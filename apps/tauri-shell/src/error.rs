//! `AppError` — the single error surface every `tauri::command` returns.
//!
//! Per ADR-0317 the frontend expects a stable `{ code, message }` JSON shape.
//! `serde::Serialize` is implemented by hand so the variant -> string code
//! mapping stays explicit and is not coupled to enum variant names changing.

use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("sidecar `{name}` failed to spawn: {source}")]
    SidecarSpawn {
        name: &'static str,
        #[source]
        source: tauri_plugin_shell::Error,
    },

    #[error("sidecar `{name}` exited with status {status}: {stderr}")]
    SidecarExit {
        name: &'static str,
        status: i32,
        stderr: String,
    },

    #[error("sidecar `{name}` produced invalid JSON: {source}")]
    SidecarJson {
        name: &'static str,
        #[source]
        source: serde_json::Error,
    },

    #[error("hotkey `{accelerator}` failed: {reason}")]
    Hotkey {
        accelerator: String,
        reason: String,
    },

    #[error("daemon is not running")]
    DaemonNotRunning,

    #[error("daemon already running on port {port}")]
    DaemonAlreadyRunning { port: u16 },

    #[error("could not find `bun` on PATH (set QUANTA_BUN_PATH to override): {reason}")]
    BunNotFound { reason: String },

    #[error("no free local port available: {reason}")]
    PortBindFailed { reason: String },

    #[error("entropy source failed: {0}")]
    Entropy(String),

    #[error("invalid argument `{arg}`: {reason}")]
    InvalidArgument { arg: &'static str, reason: String },

    #[error("io error: {0}")]
    Io(String),

    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable code for the frontend. Kept ASCII-lowercase
    /// kebab so it can be safely matched in TypeScript.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::SidecarSpawn { .. } => "sidecar-spawn",
            AppError::SidecarExit { .. } => "sidecar-exit",
            AppError::SidecarJson { .. } => "sidecar-json",
            AppError::Hotkey { .. } => "hotkey",
            AppError::DaemonNotRunning => "daemon-not-running",
            AppError::DaemonAlreadyRunning { .. } => "daemon-already-running",
            AppError::BunNotFound { .. } => "bun-not-found",
            AppError::PortBindFailed { .. } => "port-bind-failed",
            AppError::Entropy(_) => "entropy",
            AppError::InvalidArgument { .. } => "invalid-argument",
            AppError::Io(_) => "io",
            AppError::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

/// Convenience alias used across every `tauri::command`.
pub type AppResult<T> = Result<T, AppError>;
