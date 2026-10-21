//! One error type for the whole launcher core. The classification mirrors the Electron updater:
//! `permanent` errors are never retried (4xx, hash mismatch, bad manifest), `local` errors are disk
//! trouble (never retried as network trouble), `network` marks failures with no HTTP answer at all
//! (offline, refused, timeout), and `code` carries the few conditions the UI reacts to.

use std::fmt;

pub const ACCESS_KEY_REQUIRED: &str = "ACCESS_KEY_REQUIRED";
pub const DISK_FULL: &str = "DISK_FULL";
pub const GAME_RUNNING: &str = "GAME_RUNNING";
pub const CONFIG_MISSING: &str = "CONFIG_MISSING";
pub const ABORTED: &str = "ABORTED";

#[derive(Debug, Clone, Default)]
pub struct Error {
    pub message: String,
    pub permanent: bool,
    pub local: bool,
    pub network: bool,
    pub stalled: bool,
    pub status: Option<u16>,
    pub code: Option<&'static str>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error { message: message.into(), ..Default::default() }
    }
    pub fn permanent(message: impl Into<String>) -> Self {
        Error { message: message.into(), permanent: true, ..Default::default() }
    }
    pub fn with_code(mut self, code: &'static str) -> Self {
        self.code = Some(code);
        self
    }
    pub fn make_permanent(mut self) -> Self {
        self.permanent = true;
        self
    }
    pub fn make_local(mut self) -> Self {
        self.local = true;
        self
    }
    pub fn aborted(message: impl Into<String>) -> Self {
        Error { message: message.into(), permanent: true, code: Some(ABORTED), ..Default::default() }
    }
    pub fn is(&self, code: &str) -> bool {
        self.code == Some(code)
    }
    /// Disk errors are not network trouble: never retry them.
    pub fn io(error: std::io::Error, context: impl fmt::Display) -> Self {
        Error { message: format!("{context}: {error}"), local: true, permanent: true, ..Default::default() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Error { message: error.to_string(), local: true, permanent: true, ..Default::default() }
    }
}
