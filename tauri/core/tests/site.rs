//! The website sign-in calls against a stand-in for the site's login service (tools/site/login_service.py in
//! SlumsMS-site): the same paths, cookies and answers.

use slums_core::site::{self, Account};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Debug, Default)]
struct Seen {
    method: String,
    path: String,
    cookie: Option<String>,
    body: String,
}

type Reply = (u16, Vec<String>, String);

/// A one-route-per-call HTTP server: `answer(seen)` gives status, Set-Cookie lines and a JSON body.
async fn serve(answer: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let log: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let (answer, seen_log) = (Arc::new(answer), log.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let (answer, log) = (answer.clone(), seen_log.clone());
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    let Some(end) = text.find("\r\n\r\n") else { continue };
                    let head = &text[..end];
                    let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if data.len() < end + 4 + length {
                        continue;
                    }
                    let mut first = head.lines().next().unwrap().split(' ');
                    let seen = Seen {
                        method: first.next().unwrap().into(),
                        path: first.next().unwrap().into(),
                        cookie: head.lines().find_map(|l| l.strip_prefix("cookie: ").or_else(|| l.strip_prefix("Cookie: ")).map(str::to_string)),
                        body: text[end + 4..end + 4 + length].to_string(),
                    };
                    let (status, cookies, body) = answer(&seen);
                    log.lock().unwrap().push(seen);
                    let mut out = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
                    for c in cookies {
                        out.push_str(&format!("Set-Cookie: {c}\r\n"));
                    }
                    out.push_str("\r\n");
                    out.push_str(&body);
                    let _ = socket.write_all(out.as_bytes()).await;
                    return;
                }
            });
        }
    });
    (base, log)
}

#[tokio::test]
async fn me_reads_a_session_back_and_a_revoked_one_comes_back_signed_out() {
    let (base, log) = serve(|seen| match (seen.method.as_str(), seen.path.as_str()) {
        ("GET", "/api/login/me") if seen.cookie.as_deref() == Some("slums_session=eyJhIjoxfQ.mac_1") => (200, vec![], r#"{"signed_in": true, "character": "Momo", "account": "momo"}"#.into()),
        ("GET", "/api/login/me") => (200, vec![], r#"{"signed_in": false, "character": null, "account": null}"#.into()),
        ("GET", "/api/market/me") => (200, vec![], r#"{"ok": true, "badge": 2}"#.into()),
        ("POST", "/api/login/logout") => (200, vec!["slums_session=; Max-Age=0".into()], r#"{"ok": true}"#.into()),
        _ => (404, vec![], r#"{"ok": false}"#.into()),
    })
    .await;
    let token = "eyJhIjoxfQ.mac_1";
    assert_eq!(site::me(&base, token).await.unwrap().as_deref(), Some("Momo"));
    assert_eq!(site::alert_count(&base, token).await, Some(2));
    // revoked.txt, a per-session revoke or an expired session: signed_in false, and the launcher drops the token.
    assert_eq!(site::me(&base, "eyJhIjoxfQ.revoked").await.unwrap(), None);
    site::logout(&base, token).await;
    let log = log.lock().unwrap();
    assert!(log.iter().all(|s| s.cookie.as_deref().is_some_and(|c| c.starts_with("slums_session=") && !c.contains(';'))), "one session cookie per request, nothing else");
    assert_eq!(log.last().unwrap().path, "/api/login/logout");
}

#[tokio::test]
async fn password_sign_in_and_invite_sign_up_give_a_session_or_the_sites_own_message() {
    let (base, log) = serve(|seen| {
        let body: serde_json::Value = serde_json::from_str(&seen.body).unwrap_or_default();
        match seen.path.as_str() {
            site::PASSWORD_PATH if body["user"] == "momo" && body["pass"] == "pa ss\"word" => (200, vec!["slums_session=tok.en; Path=/".into()], r#"{"ok": true, "character": "Momo"}"#.into()),
            site::PASSWORD_PATH if body["user"] == "slow" => (429, vec![], "{}".into()),
            site::PASSWORD_PATH => (401, vec![], r#"{"ok": false, "error": "Wrong username or password."}"#.into()),
            site::SIGNUP_PATH if body["code"] == "GOOD" => (200, vec!["slums_session=new.one; Path=/".into()], r#"{"ok": true, "account": "newbie", "character": null}"#.into()),
            site::SIGNUP_PATH if body["code"] == "TAKEN" => (409, vec![], r#"{"ok": false, "error": "That username is taken."}"#.into()),
            site::SIGNUP_PATH if body["code"] == "DOWN" => (503, vec![], r#"{"ok": false, "error": "Sign-in is down right now. Try again in a bit."}"#.into()),
            site::SIGNUP_PATH => (403, vec![], r#"{"ok": false, "error": "That invite code doesn't work."}"#.into()),
            _ => (404, vec![], "{}".into()),
        }
    })
    .await;
    assert_eq!(site::sign_in_with_password(&base, "momo", "pa ss\"word").await.unwrap(), Account::SignedIn { token: "tok.en".into(), character: "Momo".into() });
    assert_eq!(site::sign_in_with_password(&base, "momo", "nope").await.unwrap(), Account::Refused("Wrong username or password.".into()));
    assert!(matches!(site::sign_in_with_password(&base, "slow", "x").await.unwrap(), Account::Refused(m) if m.starts_with("Too many tries")));
    assert_eq!(site::sign_up(&base, "GOOD", "newbie", "secret1").await.unwrap(), Account::SignedIn { token: "new.one".into(), character: "newbie".into() }, "no character yet: the account name");
    assert_eq!(site::sign_up(&base, "TAKEN", "newbie", "secret1").await.unwrap(), Account::Refused("That username is taken.".into()));
    assert_eq!(site::sign_up(&base, "DOWN", "newbie", "secret1").await.unwrap(), Account::Refused("Sign-in is down right now. Try again in a bit.".into()));
    assert_eq!(site::sign_up(&base, "USED", "newbie", "secret1").await.unwrap(), Account::Refused("That invite code doesn't work.".into()));
    let log = log.lock().unwrap();
    assert!(log.iter().all(|s| s.method == "POST" && s.cookie.is_none()), "credentials go in the body, no cookie is sent");
}

#[tokio::test]
async fn an_unreachable_site_is_a_network_error_so_the_token_is_kept() {
    let error = site::me("http://127.0.0.1:9", "a.b").await.unwrap_err();
    assert!(error.network);
    let refused = site::sign_in_with_password("http://example.com", "momo", "secret1").await.unwrap_err();
    assert!(!refused.network && refused.permanent, "plain HTTP off the LAN TEST origin is refused before connecting");
}

#[test]
fn wipe_zeroes_the_buffer() {
    let mut secret = String::from("hunter2");
    site::wipe(&mut secret);
    assert!(secret.is_empty());
}
