//! quanta-tauri-shell — library surface.
//!
//! Re-exports the modules that compose the Tauri app. The binary in
//! `main.rs` is the only place that calls `tauri::Builder::default()`; this
//! library exists so unit tests (added in a follow-up) can drive individual
//! commands / supervisors without spinning the full webview.

#![deny(unsafe_code)]
// `unwrap`/`expect` are banned across the library surface — every fallible
// path must surface an `AppError`. `main.rs` is allowed to bail on startup
// only because there is no caller to receive a structured error.
#![warn(clippy::unwrap_used)]
#![warn(clippy::expect_used)]

pub mod commands;
pub mod daemon;
pub mod error;
pub mod hotkey;
pub mod ocr;

pub use commands::*;
pub use error::{AppError, AppResult};
