//! "Signed in as" (tickets 104 and 105): the launcher holds the website's revocable session token for the site that
//! matches its channel (Live: the live site; Test and RC: the TEST site) and shows who it belongs to. Two ways in:
//! the game username and password, or an invite-code sign-up. A password only passes through to the site and is
//! wiped here after the call; only the session token is kept (DPAPI file). Signing in is optional in 1.6.0.

use super::*;
use serde::Deserialize;
use slums_core::site::{self, token_store, Account};

/// The account strip's bookkeeping: which site the shown state belongs to, and a counter that makes answers for an
/// older site or an older attempt drop out.
#[derive(Default)]
pub(super) struct AccountRun {
    pub(super) base: String,
    generation: u64,
}

/// What the Sign in / Sign up forms send. The password is wiped when this is dropped.
#[derive(Deserialize)]
pub struct Credentials {
    #[serde(default)]
    code: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    pass: String,
}

impl Drop for Credentials {
    fn drop(&mut self) {
        site::wipe(&mut self.pass);
    }
}

fn site_label(base: &str) -> &'static str {
    match site::site_tag(base) {
        "live" => "Live",
        "test" => "TEST",
        _ => "dev",
    }
}

/// Names and passwords as the game takes them: something typed, no control characters, not absurdly long. The
/// game server makes the real checks; this only stops obvious mistakes before anything is sent.
fn check_field(value: &str, what: &str, max: usize) -> Cmd<()> {
    if value.is_empty() {
        return Err(format!("Enter your {what}."));
    }
    if value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("That {what} can't be right."));
    }
    Ok(())
}

impl Launcher {
    /// The site this launcher signs in to now. `--site-url` (loopback only) is for development and self-tests.
    pub(super) fn site_base(&self) -> String {
        if let Some(url) = &self.args.site_url {
            return url.trim_end_matches('/').to_string();
        }
        site::site_for(self.effective().channel).to_string()
    }

    fn account_json(&self, base: &str, status: &str, extra: Value) -> Value {
        let mut value = json!({ "status": status, "site": site_label(base) });
        if let (Value::Object(map), Value::Object(extra)) = (&mut value, extra) {
            map.extend(extra);
        }
        value
    }

    /// Publish account state, unless a newer attempt or another site has taken over since `generation`.
    fn send_account(&self, generation: u64, account: Value) -> bool {
        if self.account.lock().unwrap().generation != generation {
            return false;
        }
        self.send(json!({ "account": account }));
        true
    }

    /// Start over for the current site: answers still on the way for an older attempt are dropped.
    fn reset_account_run(&self, base: &str) -> u64 {
        let mut run = self.account.lock().unwrap();
        run.base = base.to_string();
        run.generation += 1;
        run.generation
    }

    /// After a channel change or probe: when the site changed, show the other site's sign-in instead.
    pub(super) async fn sync_account_site(&self) {
        let base = self.site_base();
        if self.account.lock().unwrap().base == base {
            return;
        }
        self.refresh_account().await;
    }

    /// Read the saved session for the current site and ask the site whether it still stands. A session the site
    /// no longer accepts (expired, or the account is in revoked.txt) is deleted here.
    pub(super) async fn refresh_account(&self) {
        let base = self.site_base();
        let generation = self.reset_account_run(&base);
        let Some((token, character)) = token_store::load(&self.data_dir, &base) else {
            self.send_account(generation, self.account_json(&base, "signed-out", json!({})));
            return;
        };
        self.send_account(generation, self.account_json(&base, "signed-in", json!({ "character": character, "checking": true })));
        match site::me(&base, &token).await {
            Ok(Some(name)) => {
                let name = if name.is_empty() { character } else { name };
                let alerts = site::alert_count(&base, &token).await;
                self.send_account(generation, self.account_json(&base, "signed-in", json!({ "character": name, "alerts": alerts })));
            }
            Ok(None) => {
                token_store::clear(&self.data_dir, &base);
                self.log(&format!("Website: the {} site ended this sign-in (expired, or signed out everywhere).", site_label(&base)));
                self.send_account(generation, self.account_json(&base, "signed-out", json!({ "note": "The website signed you out. Sign in again." })));
            }
            Err(_) => {
                self.send_account(generation, self.account_json(&base, "signed-in", json!({ "character": character, "offline": true })));
            }
        }
    }

    /// A session the site just gave: keep it and show who it is.
    async fn signed_in(&self, base: &str, generation: u64, token: String, character: String, how: &str) -> Cmd<Value> {
        if self.account.lock().unwrap().generation != generation {
            return Err("The channel changed. Sign in again.".into());
        }
        token_store::save(&self.data_dir, base, &token, &character).map_err(|e| e.message)?;
        self.log(&format!("Website: signed in to the {} site {how}.", site_label(base)));
        let account = self.account_json(base, "signed-in", json!({ "character": character }));
        self.send_account(generation, account.clone());
        let alerts = site::alert_count(base, &token).await;
        if alerts.is_some() {
            self.send_account(generation, self.account_json(base, "signed-in", json!({ "character": character, "alerts": alerts })));
        }
        Ok(account)
    }

    /// The Sign in and Sign up forms: send once, wipe the password, keep only the session that comes back.
    async fn account_form(&self, form: Credentials, signup: bool) -> Cmd<Value> {
        check_field(&form.user, "username", 32)?;
        check_field(&form.pass, "password", 64)?;
        if signup {
            check_field(form.code.trim(), "invite code", 64)?;
        }
        let base = self.site_base();
        let generation = self.reset_account_run(&base);
        let answer = if signup { site::sign_up(&base, form.code.trim(), form.user.trim(), &form.pass).await } else { site::sign_in_with_password(&base, form.user.trim(), &form.pass).await };
        drop(form); // wipes the password
        match answer.map_err(|e| e.message)? {
            Account::SignedIn { token, character } => self.signed_in(&base, generation, token, character, if signup { "with a new account" } else { "with a password" }).await,
            Account::Refused(message) => Err(message),
        }
    }

    async fn sign_out(&self) -> Value {
        let base = self.site_base();
        let generation = self.reset_account_run(&base);
        if let Some((token, _)) = token_store::load(&self.data_dir, &base) {
            site::logout(&base, &token).await;
        }
        token_store::clear(&self.data_dir, &base);
        self.log(&format!("Website: signed out of the {} site.", site_label(&base)));
        let account = self.account_json(&base, "signed-out", json!({}));
        self.send_account(generation, account.clone());
        account
    }

    /// Self-test: save, read back and delete a made-up session under a development site, so a Windows run shows
    /// that DPAPI protects and unprotects for this user. Nothing is sent anywhere.
    pub(super) fn account_store_self_test(&self) -> Result<Value, String> {
        let base = "http://127.0.0.1:9";
        token_store::save(&self.data_dir, base, "self.test-token", "SelfTest").map_err(|e| e.message)?;
        let file = token_store::path(&self.data_dir, base);
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        let back = token_store::load(&self.data_dir, base);
        let plain_on_disk = bytes.windows(b"self.test-token".len()).any(|w| w == b"self.test-token");
        token_store::clear(&self.data_dir, base);
        let ok = back == Some(("self.test-token".into(), "SelfTest".into())) && (cfg!(not(windows)) || !plain_on_disk) && !file.exists();
        if !ok {
            return Err(format!("token store round trip failed (read back: {}, plain on disk: {plain_on_disk})", back.is_some()));
        }
        Ok(json!({ "bytes": bytes.len(), "plainOnDisk": plain_on_disk, "removed": true }))
    }
}

#[tauri::command]
pub async fn account_sign_in(launcher: L<'_>, value: Credentials) -> Cmd<Value> {
    launcher.inner().clone().account_form(value, false).await
}

#[tauri::command]
pub async fn account_sign_up(launcher: L<'_>, value: Credentials) -> Cmd<Value> {
    launcher.inner().clone().account_form(value, true).await
}

#[tauri::command]
pub async fn account_sign_out(launcher: L<'_>) -> Cmd<Value> {
    Ok(launcher.inner().clone().sign_out().await)
}

/// "Forgot password?": the site's page for the current channel, in the browser. No reset happens in the launcher.
#[tauri::command]
pub async fn open_forgot(launcher: L<'_>) -> Cmd<()> {
    let url = site::forgot_url(&launcher.site_base()).ok_or("The website address is not a URL.")?;
    if !platform::open_path(&url) {
        return Err("Could not open the browser.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_market(launcher: L<'_>) -> Cmd<()> {
    let url = site::market_url(&launcher.site_base()).ok_or("The website address is not a URL.")?;
    if !platform::open_path(&url) {
        return Err("Could not open the browser.".into());
    }
    Ok(())
}
