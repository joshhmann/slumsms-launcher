//! SlumsMS launcher core. Everything that is not window plumbing lives here so it can be tested
//! with `cargo test -p slums-core` on any platform (the Tauri app crate only wires it to the UI).

pub mod channels;
pub mod config;
pub mod error;
pub mod fsutil;
pub mod game_config;
pub mod game_options;
pub mod http;
pub mod install;
pub mod manifest;
pub mod packs;
pub mod play;
pub mod release;
pub mod selfupdate;
pub mod settings;

pub use error::{Error, Result};
