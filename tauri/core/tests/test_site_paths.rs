//! Every launcher sign-in path against the real TEST site (ticket: Login L1 verification). Opt-in: it makes a
//! throwaway TEST account, so it runs only with `--ignored` and an invite code:
//!   SLUMS_QA_INVITE=<code from `!invite`> cargo test --test test_site_paths -- --ignored --nocapture
//! SLUMS_QA_SITE picks another site (default: the TEST site). Never point it at Live. SLUMS_QA_RC_FEED (e.g.
//! http://192.168.0.164:8090/launcher-rc/manifest.json) also checks the download pass against the RC feed.

use slums_core::site::{self, Account};

fn site_base() -> String {
    std::env::var("SLUMS_QA_SITE").unwrap_or_else(|_| site::TEST_SITE.to_string())
}

/// 23 characters (the game's password box maximum), mixed case, digits and symbols the site allows.
fn long_password() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#%+-_";
    let mut pass: String = (0..20).map(|_| CHARS[fastrand::usize(..CHARS.len())] as char).collect();
    pass.push_str("Aa9");
    pass
}

async fn status_of(url: &str) -> u16 {
    reqwest::get(url).await.map(|r| r.status().as_u16()).unwrap_or(0)
}

#[tokio::test]
#[ignore]
async fn every_sign_in_path_works_on_the_test_site() {
    let base = site_base();
    assert_ne!(base, site::LIVE_SITE, "this test makes accounts; never run it against Live");
    let invite = std::env::var("SLUMS_QA_INVITE").expect("set SLUMS_QA_INVITE to a TEST invite code");
    let user = format!("lqa{}", fastrand::u32(100_000..999_999));
    let pass = long_password();
    assert_eq!(pass.len(), 23);
    println!("site {base}, throwaway account {user}");

    // The pages the launcher links to.
    for url in [site::forgot_url(&base), site::join_url(&base), site::report_url(&base, "1.6.1", Some("1.6.0+10600"))] {
        let url = url.expect("a page URL");
        assert_eq!(status_of(&url).await, 200, "{url}");
        println!("ok   page {url}");
    }

    // Wrong password for an account that doesn't exist: the site's own message, no session.
    match site::sign_in_with_password(&base, &user, "not-the-password").await.expect("an answer") {
        Account::Refused(m) => println!("ok   unknown account refused: {m:?}"),
        other => panic!("unknown account signed in: {other:?}"),
    }

    // Sign up with the invite and a 23-character password.
    let token = match site::sign_up(&base, &invite, &user, &pass).await.expect("an answer") {
        Account::SignedIn { token, character } => {
            println!("ok   sign-up with invite: signed in as {character:?}");
            token
        }
        Account::Refused(m) => panic!("sign-up refused: {m}"),
    };
    assert!(site::me(&base, &token).await.expect("me").is_some(), "the new session is good");
    println!("ok   /me knows the new session");
    let download = site::download_pass(&base, &token).await.expect("download pass call");
    assert!(download.is_some(), "a signed-in account gets a download pass");
    println!("ok   download pass issued");
    // The pass alone (no access key) opens the RC feed on the patch server; a wrong one doesn't.
    if let Ok(feed) = std::env::var("SLUMS_QA_RC_FEED") {
        let get = |pass: String| { let feed = feed.clone(); async move { reqwest::Client::new().get(&feed).header("X-Slums-Pass", pass).send().await.map(|r| r.status().as_u16()).unwrap_or(0) } };
        assert_eq!(get(download.clone().unwrap().pass).await, 200, "the pass opens {feed}");
        assert_eq!(get("dp1.wrong".into()).await, 401, "a wrong pass is refused");
        println!("ok   the pass opens the RC feed, a wrong pass gets 401");
    }

    // The same invite a second time.
    match site::sign_up(&base, &invite, &format!("{user}b"), &pass).await.expect("an answer") {
        Account::Refused(m) => println!("ok   used invite refused: {m:?}"),
        other => panic!("a used invite made a second account: {other:?}"),
    }

    // Wrong password, then the 12-character prefix (nothing may truncate the password), then the real one.
    match site::sign_in_with_password(&base, &user, "wrong-password-1").await.expect("an answer") {
        Account::Refused(m) => println!("ok   wrong password refused: {m:?}"),
        other => panic!("a wrong password signed in: {other:?}"),
    }
    match site::sign_in_with_password(&base, &user, &pass[..12]).await.expect("an answer") {
        Account::Refused(_) => println!("ok   the first 12 characters alone are refused"),
        other => panic!("a 12-character prefix of the password signed in: {other:?}"),
    }
    let token2 = match site::sign_in_with_password(&base, &user, &pass).await.expect("an answer") {
        Account::SignedIn { token, .. } => token,
        Account::Refused(m) => panic!("the 23-character password was refused: {m}"),
    };
    println!("ok   23-character password signs in");

    // Sign out. The launcher forgets its token whatever the answer; report what the site does with the old one.
    site::logout(&base, &token2).await;
    match site::me(&base, &token2).await {
        Ok(None) => println!("ok   after sign-out the old session is refused by the site"),
        Ok(Some(_)) => println!("note after sign-out the site still accepts the old session (the launcher has forgotten it)"),
        Err(e) => println!("note /me after sign-out: {}", e.message),
    }
    println!("done: account {user} stays on TEST");
}
