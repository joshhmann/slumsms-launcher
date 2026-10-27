//! Signing in to the SlumsMS website (tickets 104 level 1 and 105: the launcher knows who you are). The launcher uses
//! the site's own login service (docs/site/LOGIN.md in SlumsMS-site): the game username and password, or an invite
//! code and a new account, go to the site, which has the game server check them and hands back its signed session
//! token. No password is ever stored; the only thing kept is that revocable token (see `token_store`), one per site.
//!
//! Live talks only to the live site and Test/RC only to the TEST site, so a token never crosses between them.

use crate::channels::Channel;
use crate::error::{Error, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

pub const LIVE_SITE: &str = "https://theslumsms.asslorde.com";
/// The TEST copy of the site (tools/site/test164 in SlumsMS-site): plain HTTP on the LAN, for Test and RC.
pub const TEST_SITE: &str = "http://192.168.0.164:8192";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY: usize = 64 * 1024;
const MAX_TOKEN: usize = 4096;
const SESSION_COOKIE: &str = "slums_session";

/// The site a channel signs in to.
pub fn site_for(channel: Channel) -> &'static str {
    match channel {
        Channel::Live => LIVE_SITE,
        Channel::Test | Channel::Rc => TEST_SITE,
    }
}

/// A site base URL the launcher may send a session to: HTTPS, HTTP on loopback (development and tests), or the
/// TEST site's exact LAN origin. Nothing else, so a token can't be sent anywhere by accident.
pub fn site_url(base: &str) -> Result<Url> {
    let url = Url::parse(base).map_err(|_| Error::permanent("The website address is not a URL."))?;
    let loopback = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    let test = url.origin() == Url::parse(TEST_SITE).expect("TEST_SITE").origin();
    if url.scheme() != "https" && !(url.scheme() == "http" && (loopback || test)) {
        return Err(Error::permanent("The website must use HTTPS."));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::permanent("The website address cannot carry credentials."));
    }
    Ok(url)
}

/// A short tag for a site, used to name its token file: "live", "test", or "dev" for anything else.
pub fn site_tag(base: &str) -> &'static str {
    match base.trim_end_matches('/') {
        LIVE_SITE => "live",
        TEST_SITE => "test",
        _ => "dev",
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // No redirects and no cookie jar: the session cookie is read and sent by hand, to this one origin only.
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(crate::http::user_agent())
            .connect_timeout(TIMEOUT)
            .timeout(TIMEOUT)
            .build()
            .expect("HTTP client")
    })
}

fn offline(error: reqwest::Error) -> Error {
    let _ = error; // the error text can carry the URL; nothing secret, but keep messages short
    Error { message: "Could not reach the website.".into(), network: true, ..Default::default() }
}

fn endpoint(base: &str, path: &str) -> Result<Url> {
    site_url(base)?.join(path).map_err(|_| Error::permanent("The website address is not a URL."))
}

fn cookie_header(token: &str) -> String {
    format!("{SESSION_COOKIE}={token}")
}

/// Session tokens are URL-safe base64 (plus one "." in a session); anything else is refused so it
/// can't smuggle a header or a second cookie.
pub fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= MAX_TOKEN && token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The value of `name` from a response's Set-Cookie headers (empty values count as absent).
fn set_cookie(response: &reqwest::Response, name: &str) -> Option<String> {
    response.headers().get_all(reqwest::header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok()).find_map(|line| {
        let pair = line.split(';').next()?.trim();
        let (k, v) = pair.split_once('=')?;
        (k.trim() == name && !v.trim().is_empty()).then(|| v.trim().to_string())
    })
}

async fn json_body(response: reqwest::Response) -> Result<Value> {
    let bytes = response.bytes().await.map_err(offline)?;
    if bytes.len() > MAX_BODY {
        return Err(Error::permanent("The website's answer is too large."));
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::permanent("The website gave an answer the launcher can't read."))
}

/// A character name as shown: printable, at most 32 characters (the service's own limit).
fn clean_name(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control()).take(32).collect()
}

/// What a password sign-in or a sign-up got back: a session, or the site's own short message for the player
/// ("wrong username or password", "that code doesn't work", "Too many tries…").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Account {
    SignedIn { token: String, character: String },
    Refused(String),
}

pub const SIGNUP_PATH: &str = "/api/login/signup";
pub const PASSWORD_PATH: &str = "/api/login/password";

/// Overwrite a secret's bytes before it is dropped (best effort: the HTTP stack keeps its own copy briefly).
pub fn wipe(secret: &mut String) {
    // SAFETY: zero bytes are valid UTF-8; volatile writes are not optimised away.
    for b in unsafe { secret.as_bytes_mut() } {
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    secret.clear();
}

/// POST a JSON body of credentials and read a session back. The body moves into the request and is freed with it.
async fn account_call(base: &str, path: &str, body: String) -> Result<Account> {
    let response = client().post(endpoint(base, path)?).header("Content-Type", "application/json").header("X-Slums", "1").body(body).send().await.map_err(offline)?;
    let status = response.status().as_u16();
    let token = set_cookie(&response, SESSION_COOKIE);
    let answer = json_body(response).await.ok();
    let message = answer.as_ref().and_then(|a| a.get("error")).and_then(Value::as_str).map(|m| m.chars().filter(|c| !c.is_control()).take(200).collect::<String>());
    if status == 200 && answer.as_ref().and_then(|a| a.get("ok")).and_then(Value::as_bool) == Some(true) {
        return match token.filter(|t| valid_token(t)) {
            Some(token) => {
                // A brand-new account has no character yet: show the account name instead.
                let character = clean_name(answer.as_ref().and_then(|a| a.get("character")));
                let character = if character.is_empty() { clean_name(answer.as_ref().and_then(|a| a.get("account"))) } else { character };
                Ok(Account::SignedIn { token, character })
            }
            None => Err(Error::permanent("The website said yes but sent no session.")),
        };
    }
    // The site's errors are written for players ("Wrong username or password.", "That invite code doesn't work.").
    match (status, message) {
        (400..=599, Some(m)) if !m.is_empty() => Ok(Account::Refused(m)),
        (429, _) => Ok(Account::Refused("Too many tries. Wait a minute and try again.".into())),
        (404, _) => Err(Error::new("The website does not take sign-ins here yet.")),
        _ => Err(Error::new(format!("The website's sign-in answered HTTP {status}."))),
    }
}

fn credentials(pairs: &[(&str, &str)]) -> String {
    let map: serde_json::Map<String, Value> = pairs.iter().map(|(k, v)| (k.to_string(), Value::from(*v))).collect();
    Value::Object(map).to_string()
}

/// Sign in with the game username and password, checked by the game server through the site. The password is
/// never stored; the caller wipes its own copy.
pub async fn sign_in_with_password(base: &str, user: &str, pass: &str) -> Result<Account> {
    account_call(base, PASSWORD_PATH, credentials(&[("user", user), ("pass", pass)])).await
}

/// Make a game account with an invite code, then hold the session the site gives for it.
pub async fn sign_up(base: &str, code: &str, user: &str, pass: &str) -> Result<Account> {
    account_call(base, SIGNUP_PATH, credentials(&[("code", code), ("user", user), ("pass", pass)])).await
}

/// GET /api/login/me: the signed-in character, or None when the session is no longer good (expired, or the
/// account is in revoked.txt). A network failure is an error, so an offline launcher keeps its token.
pub async fn me(base: &str, token: &str) -> Result<Option<String>> {
    if !valid_token(token) {
        return Ok(None);
    }
    let response = client().get(endpoint(base, "/api/login/me")?).header("Cookie", cookie_header(token)).send().await.map_err(offline)?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(Error::new(format!("The website answered HTTP {status}.")));
    }
    let body = json_body(response).await?;
    if body.get("signed_in").and_then(Value::as_bool) == Some(true) {
        Ok(Some(clean_name(body.get("character"))))
    } else {
        Ok(None)
    }
}

/// GET /api/market/me: how many price alerts fired since the player last looked (the site's badge). None when the
/// market is not there or does not know the session; this is extra, so callers just leave it out.
pub async fn alert_count(base: &str, token: &str) -> Option<u64> {
    if !valid_token(token) {
        return None;
    }
    let response = client().get(endpoint(base, "/api/market/me").ok()?).header("Cookie", cookie_header(token)).send().await.ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    json_body(response).await.ok()?.get("badge").and_then(Value::as_u64)
}

/// POST /api/login/logout. Sessions are not stored on the server, so this only matters to a browser; the launcher
/// forgets its token whatever the answer.
pub async fn logout(base: &str, token: &str) {
    if let Ok(url) = endpoint(base, "/api/login/logout") {
        let _ = client().post(url).header("Cookie", cookie_header(token)).header("Content-Length", "0").send().await;
    }
}

/// The site's forgot-password page (ticket 107: the owner approves resets in game; the launcher only links to it).
pub const FORGOT_PATH: &str = "/forgot/";

pub fn forgot_url(base: &str) -> Option<String> {
    endpoint(base, FORGOT_PATH).ok().map(|u| u.to_string())
}

/// The site's public "How to join" page (invite code, sign up, launcher, install, log in), linked from the New
/// account tab.
pub const JOIN_PATH: &str = "/join/";

pub fn join_url(base: &str) -> Option<String> {
    endpoint(base, JOIN_PATH).ok().map(|u| u.to_string())
}

/// Where the market page is, for the "price alerts" link.
pub fn market_url(base: &str) -> Option<String> {
    endpoint(base, "/market/").ok().map(|u| u.to_string())
}

/// The session token kept on disk, one file per site in the launcher's data folder. On Windows the file holds
/// the token encrypted with DPAPI for the current Windows user (CryptProtectData), so copying the file to
/// another account or PC gives nothing; elsewhere (tests, the dev CLI) it is a 0600 file. The site's origin is
/// sealed in with the token and checked on load, so a token is only ever sent back to the site that issued it.
pub mod token_store {
    use super::*;

    pub fn path(data_dir: &Path, base: &str) -> PathBuf {
        data_dir.join(format!("site-session-{}.bin", site_tag(base)))
    }

    fn origin(base: &str) -> Option<String> {
        site_url(base).ok().map(|u| u.origin().ascii_serialization())
    }

    /// Keep `token` (and the character it signed in as, for showing while offline) for this site.
    pub fn save(data_dir: &Path, base: &str, token: &str, character: &str) -> Result<()> {
        let origin = origin(base).ok_or_else(|| Error::permanent("The website address is not a URL."))?;
        if !valid_token(token) {
            return Err(Error::permanent("The website's session is not valid."));
        }
        let character: String = character.chars().filter(|c| !c.is_control()).take(32).collect();
        let sealed = seal(format!("{origin}\n{token}\n{character}").as_bytes())?;
        std::fs::create_dir_all(data_dir).map_err(|e| Error::io(e, data_dir.display()))?;
        let file = path(data_dir, base);
        let temporary = file.with_extension("bin.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut handle = options.open(&temporary).map_err(|e| Error::io(e, temporary.display()))?;
        handle.write_all(&sealed).map_err(|e| Error::io(e, temporary.display()))?;
        drop(handle);
        std::fs::rename(&temporary, &file).map_err(|e| Error::io(e, file.display()))
    }

    /// The saved token and character for this site, or None (missing, unreadable, another user's, or another site's).
    pub fn load(data_dir: &Path, base: &str) -> Option<(String, String)> {
        let bytes = std::fs::read(path(data_dir, base)).ok()?;
        let text = String::from_utf8(unseal(&bytes)?).ok()?;
        let mut parts = text.splitn(3, '\n');
        let (saved_origin, token, character) = (parts.next()?, parts.next()?, parts.next().unwrap_or(""));
        (Some(saved_origin.to_string()) == origin(base) && valid_token(token)).then(|| (token.to_string(), character.to_string()))
    }

    pub fn clear(data_dir: &Path, base: &str) {
        let _ = std::fs::remove_file(path(data_dir, base));
    }

    #[cfg(windows)]
    const ENTROPY: &[u8] = b"SlumsMS Launcher website session";

    #[cfg(windows)]
    fn seal(plain: &[u8]) -> Result<Vec<u8>> {
        dpapi(plain, true).ok_or_else(|| Error::permanent("Windows could not protect the website session.").make_local())
    }

    #[cfg(windows)]
    fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
        dpapi(sealed, false)
    }

    #[cfg(windows)]
    fn dpapi(input: &[u8], protect: bool) -> Option<Vec<u8>> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let blob = |bytes: &[u8]| CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
        let (data, entropy) = (blob(input), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: the in blobs point at live slices for the call; the out blob is allocated by Windows and freed below.
        let ok = unsafe {
            if protect {
                CryptProtectData(&data, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&data, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 || out.pbData.is_null() {
            return None;
        }
        // SAFETY: Windows returned cbData bytes at pbData.
        let result = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData.cast()) };
        Some(result)
    }

    #[cfg(not(windows))]
    fn seal(plain: &[u8]) -> Result<Vec<u8>> {
        Ok(plain.to_vec())
    }

    #[cfg(not(windows))]
    fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
        Some(sealed.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_signs_in_to_the_live_site_and_test_and_rc_to_the_test_site() {
        assert_eq!(site_for(Channel::Live), "https://theslumsms.asslorde.com");
        assert_eq!(site_for(Channel::Test), "http://192.168.0.164:8192");
        assert_eq!(site_for(Channel::Rc), "http://192.168.0.164:8192");
        assert_eq!(forgot_url(LIVE_SITE).as_deref(), Some("https://theslumsms.asslorde.com/forgot/"));
        assert_eq!(forgot_url(TEST_SITE).as_deref(), Some("http://192.168.0.164:8192/forgot/"));
        assert_eq!(join_url(LIVE_SITE).as_deref(), Some("https://theslumsms.asslorde.com/join/"));
        assert_eq!(join_url(TEST_SITE).as_deref(), Some("http://192.168.0.164:8192/join/"));
        assert_eq!(site_tag(LIVE_SITE), "live");
        assert_eq!(site_tag("http://192.168.0.164:8192/"), "test");
        assert_eq!(site_tag("http://127.0.0.1:9"), "dev");
    }

    #[test]
    fn a_session_goes_only_to_https_loopback_or_the_exact_test_origin() {
        assert!(site_url(LIVE_SITE).is_ok());
        assert!(site_url(TEST_SITE).is_ok());
        assert!(site_url("http://127.0.0.1:8094").is_ok());
        assert!(site_url("http://192.168.0.164:8193").is_err(), "another port on the TEST box");
        assert!(site_url("http://192.168.0.165:8192").is_err());
        assert!(site_url("http://theslumsms.asslorde.com").is_err(), "the live site never over plain HTTP");
        assert!(site_url("https://u:p@theslumsms.asslorde.com").is_err());
        assert!(site_url("not a url").is_err());
    }

    #[test]
    fn tokens_are_url_safe_base64_with_at_most_a_dot() {
        assert!(valid_token("eyJhIjoxfQ.abc-_123"));
        assert!(!valid_token(""));
        assert!(!valid_token("a b"));
        assert!(!valid_token("a;slums_session=x"));
        assert!(!valid_token("a\r\nSet-Cookie: x"));
        assert!(!valid_token(&"a".repeat(MAX_TOKEN + 1)));
    }

    #[test]
    fn the_token_file_is_per_site_and_never_read_back_for_another_site() {
        let dir = std::env::temp_dir().join(format!("slums-site-{}", uuid::Uuid::new_v4()));
        token_store::save(&dir, TEST_SITE, "body.mac", "Momo").unwrap();
        assert_eq!(token_store::load(&dir, TEST_SITE), Some(("body.mac".into(), "Momo".into())));
        let on_disk = std::fs::read(token_store::path(&dir, TEST_SITE)).unwrap();
        let plain = on_disk.windows(8).any(|w| w == b"body.mac");
        assert_eq!(plain, cfg!(not(windows)), "on Windows the file holds only DPAPI ciphertext");
        assert_eq!(token_store::load(&dir, LIVE_SITE), None);
        // A test token copied over the live file is refused: the origin sealed with it is the TEST one.
        std::fs::copy(token_store::path(&dir, TEST_SITE), token_store::path(&dir, LIVE_SITE)).unwrap();
        assert_eq!(token_store::load(&dir, LIVE_SITE), None);
        assert!(token_store::save(&dir, TEST_SITE, "bad token", "").is_err());
        token_store::clear(&dir, TEST_SITE);
        assert_eq!(token_store::load(&dir, TEST_SITE), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_printable_and_short() {
        assert_eq!(clean_name(Some(&Value::from("Momo\u{7}"))), "Momo");
        assert_eq!(clean_name(Some(&Value::from("x".repeat(40)))).len(), 32);
        assert_eq!(clean_name(None), "");
    }
}
