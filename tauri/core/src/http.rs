//! Feed transport: HTTPS-only URLs (loopback HTTP for development), manual redirects, and an
//! optional access key sent as HTTP Basic auth only to the feed's own origin. Port of the
//! request/readJSON/feedAccess part of updater.mjs.

use crate::error::{Error, Result, ACCESS_KEY_REQUIRED};
use base64::Engine;
use std::sync::OnceLock;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

/// Basic-auth user for player keys. The dev key uses DEV_ACCESS_USER; the server decides which works.
pub const ACCESS_KEY_USER: &str = "slums";
pub const DEV_ACCESS_USER: &str = "slumsdev";
pub const ACCESS_KEY_MESSAGE: &str = "This server needs an access key - enter it in Settings";
pub const MAX_MANIFEST_BYTES: usize = 128 * 1024 * 1024;

pub fn user_agent() -> String {
    format!("SlumsMS-Launcher/{}", env!("CARGO_PKG_VERSION"))
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(user_agent())
            .connect_timeout(Duration::from_secs(30))
            .build()
            .expect("HTTP client")
    })
}

fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some("localhost") | Some("[::1]") => true,
        Some(host) => {
            let parts: Vec<&str> = host.split('.').collect();
            parts.len() == 4 && parts[0] == "127" && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        }
        None => false,
    }
}

/// A release URL: absolute, HTTPS (HTTP only on loopback), no credentials or fragment.
pub fn network_url(input: &str) -> Result<Url> {
    let url = Url::parse(input).map_err(|_| Error::permanent("Enter an absolute HTTPS manifest URL."))?;
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback(&url)) {
        return Err(Error::permanent("Release URLs must use HTTPS (HTTP is allowed only on loopback for local verification)."));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::permanent("Release URLs cannot contain credentials or fragments."));
    }
    Ok(url)
}

/// An access key bound to the feed's origin. The Authorization header is only ever attached to
/// requests whose origin equals that origin; an empty key yields no header at all.
#[derive(Clone, Debug, Default)]
pub struct FeedAccess {
    pub origin: Option<url::Origin>,
    authorization: String,
}

impl FeedAccess {
    pub fn new(feed_url: &str, access_key: &str, user: &str) -> Result<Self> {
        let origin = network_url(feed_url)?.origin();
        let authorization = if access_key.is_empty() {
            String::new()
        } else {
            format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{access_key}")))
        };
        Ok(FeedAccess { origin: Some(origin), authorization })
    }
    /// The header value, for a client (the Tauri updater) that only ever talks to `origin`.
    pub fn authorization(&self) -> &str {
        &self.authorization
    }
    pub fn same_origin(&self, url: &Url) -> bool {
        self.origin.as_ref() == Some(&url.origin())
    }
}

fn access_denied(status: u16) -> Error {
    Error { message: ACCESS_KEY_MESSAGE.into(), permanent: true, status: Some(status), code: Some(ACCESS_KEY_REQUIRED), ..Default::default() }
}

fn network_error(error: reqwest::Error) -> Error {
    Error { message: format!("Could not reach the update server ({error})."), network: true, ..Default::default() }
}

pub fn cancelled(token: &CancellationToken) -> Error {
    let _ = token;
    Error::aborted("The operation was cancelled.")
}

/// GET `input`, following up to five redirects by hand. The key is sent only while the chain stays
/// on the feed's origin; once a hop leaves it, it is dropped for the rest of the chain.
pub async fn request(input: &str, cancel: &CancellationToken, access: Option<&FeedAccess>, extra: &[(&str, String)]) -> Result<(reqwest::Response, Url)> {
    let mut url = network_url(input)?;
    let secure = url.scheme() == "https";
    let mut trusted = access.is_some_and(|a| !a.authorization.is_empty());
    for redirects in 0..=5 {
        if secure && url.scheme() != "https" {
            return Err(Error::permanent("An HTTPS release cannot redirect to HTTP."));
        }
        if !access.is_some_and(|a| a.same_origin(&url)) {
            trusted = false;
        }
        let mut builder = client().get(url.clone()).header("Accept-Encoding", "identity");
        for (name, value) in extra {
            builder = builder.header(*name, value);
        }
        if trusted {
            builder = builder.header("Authorization", &access.unwrap().authorization);
        }
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled(cancel)),
            r = builder.send() => r.map_err(network_error)?,
        };
        let status = response.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let location = response.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
            drop(response);
            let Some(location) = location.filter(|_| redirects < 5) else {
                return Err(Error::permanent("Release request has an invalid or excessive redirect chain."));
            };
            let next = url.join(&location).map_err(|_| Error::permanent("Release request has an invalid or excessive redirect chain."))?;
            url = network_url(next.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            // 401/403 from the feed means a missing or wrong key; it is permanent, so never retried.
            if (status == 401 || status == 403) && access.is_some_and(|a| a.same_origin(&url)) {
                return Err(access_denied(status));
            }
            let reason = response.status().canonical_reason().unwrap_or("");
            let mut error = Error::new(format!("Release request failed: HTTP {status} {reason}."));
            error.status = Some(status);
            if status < 500 && ![408, 425, 429].contains(&status) {
                error.permanent = true;
            }
            return Err(error);
        }
        return Ok((response, url));
    }
    Err(Error::permanent("Release request exceeded the redirect limit."))
}

/// Read a small JSON document (manifest, layer manifest, pack index) fully, with a size limit.
pub async fn read_bytes(input: &str, label: &str, access: Option<&FeedAccess>, cancel: &CancellationToken, timeout: Option<Duration>) -> Result<(Vec<u8>, Url)> {
    let work = async {
        let (mut response, url) = request(input, cancel, access, &[]).await?;
        if response.content_length().is_some_and(|n| n as usize > MAX_MANIFEST_BYTES) {
            return Err(Error::permanent(format!("{label} is too large.")));
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(cancelled(cancel)),
                c = response.chunk() => c.map_err(network_error)?,
            };
            let Some(chunk) = chunk else { break };
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX_MANIFEST_BYTES {
                return Err(Error::permanent(format!("{label} is too large.")));
            }
        }
        Ok((bytes, url))
    };
    match timeout {
        Some(limit) => tokio::time::timeout(limit, work).await.unwrap_or_else(|_| {
            Err(Error { message: "Could not reach the update server (timed out).".into(), network: true, ..Default::default() })
        }),
        None => work.await,
    }
}

pub fn parse_json(bytes: &[u8], label: &str) -> Result<serde_json::Value> {
    serde_json::from_slice(bytes).map_err(|error| Error::permanent(format!("Cannot read {label}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_require_https_except_loopback() {
        assert!(network_url("https://slumspatch.asslorde.com/manifest.json").is_ok());
        assert!(network_url("http://127.0.0.1:8080/m.json").is_ok());
        assert!(network_url("http://localhost/m.json").is_ok());
        assert!(network_url("http://[::1]:9/m.json").is_ok());
        assert!(network_url("http://example.com/m.json").is_err());
        assert!(network_url("https://slums:key@example.com/m.json").is_err(), "no credentials in URLs");
        assert!(network_url("https://example.com/m.json#x").is_err());
        assert!(network_url("manifest.json").is_err());
    }

    #[test]
    fn the_key_is_basic_auth_for_the_given_user_and_bound_to_the_origin() {
        let access = FeedAccess::new("https://a.example/x/manifest.json", "k", ACCESS_KEY_USER).unwrap();
        assert_eq!(access.authorization(), format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("slums:k")));
        assert!(access.same_origin(&Url::parse("https://a.example/other").unwrap()));
        assert!(!access.same_origin(&Url::parse("https://a.example:444/other").unwrap()));
        assert!(!access.same_origin(&Url::parse("https://b.example/other").unwrap()));
        let dev = FeedAccess::new("https://a.example/m.json", "k", DEV_ACCESS_USER).unwrap();
        assert_eq!(dev.authorization(), format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("slumsdev:k")));
        assert_eq!(FeedAccess::new("https://a.example/m.json", "", ACCESS_KEY_USER).unwrap().authorization(), "");
    }
}
