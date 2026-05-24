//! `linux-sandbox-native` — napi-rs binding surface for quanta's in-process
//! Linux Landlock + seccomp OS sandbox (ADR-0175, Phase 3).
//!
//! This file is the **scaffold** of the napi-rs API surface. The TypeScript
//! adapter (`src/runtime/os-sandbox/landlock-native.ts`) loads
//! `@quanta/linux-sandbox-native` lazily; this crate provides the entry
//! points it expects. The actual landlock + seccomp + fork-exec wire is
//! deferred to Phase 3.1 (see ADR-0175 §Phase 3.1 deferral) — function
//! bodies here are `todo!()` / stub returns that compile-check the ABI shape
//! without performing any kernel calls.
//!
//! Industry pattern mirror:
//!   - Codex `codex-linux-sandbox` (in-process landlock crate) — same shape.
//!   - Cursor `cursorsandbox` (separate Rust binary, no napi) — alternative
//!     we explicitly didn't take; see ADR-0175 §Alternatives rejected.
//!
//! ## Surface
//!
//! Two `#[napi]` entry points (kept minimal so the TS adapter dictates the
//! contract):
//!
//!   - `spawn_sandboxed(spec, policy) -> NapiSpawnResult`
//!   - `availability() -> String` (JSON `{ available, kernelVersion, abiSupported, reason? }`)
//!
//! Three `#[napi(object)]` value types matching the TS `SandboxPolicy` /
//! `SandboxedSpawnSpec` / `SandboxedSpawnResult` types, with napi-rs
//! convention: camelCase JS → snake_case Rust. The TS adapter maps between
//! the two with a single `mapPolicyToNapi()` helper.

use napi_derive::napi;
use std::collections::HashMap;

pub mod policy;
pub mod seccomp;

/// Typed sandbox policy ferried across the napi boundary.
///
/// Field names mirror the TS `SandboxPolicy` shape with napi-rs snake_case
/// conversion. `profile` is intentionally a `String` here (not an enum) —
/// the TS side already validates the closed enum via `SandboxProfile`; the
/// Rust side rejects unknown profiles with a typed error in `policy.rs`.
///
/// `extra_read_paths` / `extra_write_paths` are non-optional `Vec<String>`
/// (defaulted to empty by the TS adapter when absent) — napi-rs has known
/// rough edges with `Option<Vec<_>>` on some ABI versions; defaulting to
/// `[]` matches the empty-array semantics of the TS port without losing
/// information.
#[napi(object)]
pub struct NapiSandboxPolicy {
    /// One of: "off" | "read-only" | "workspace-write" | "workspace-write-net" | "danger-full-access"
    pub profile: String,
    /// Absolute path to the workspace root (RW for write profiles).
    pub workspace: String,
    /// Additional read-allow absolute paths.
    pub extra_read_paths: Vec<String>,
    /// Additional write-allow absolute paths.
    pub extra_write_paths: Vec<String>,
    /// Network policy override; `None` means "follow profile default".
    pub allow_network: Option<bool>,
    /// Wall-clock cap in milliseconds; `None` = no cap.
    pub timeout_ms: Option<u32>,
    /// Memory cap in MB; `None` = no cap. Enforced via rlimit in the child.
    pub memory_mb: Option<u32>,
}

/// Spawn spec — argv + cwd + (optional) env. Mirrors the TS
/// `SandboxedSpawnSpec` minus `signal` (AbortSignal does not cross napi;
/// the TS adapter handles cancellation by killing the child via PID).
#[napi(object)]
pub struct NapiSandboxedSpawnSpec {
    pub command: Vec<String>,
    pub cwd: String,
    pub env: Option<HashMap<String, String>>,
}

/// Spawn result — buffered stdout/stderr + exit code + sandbox-applied
/// flag. Mirrors the TS `SandboxedSpawnResult`. `degrade_reason` is
/// emitted iff the sandbox could not be fully applied; the TS adapter
/// maps this to the typed `degradeReason` field (omitted when None).
#[napi(object)]
pub struct NapiSpawnResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub sandbox_applied: bool,
    pub degrade_reason: Option<String>,
}

/// Spawn `spec.command` inside a Landlock + seccomp fence compiled from
/// `policy`.
///
/// Phase 3 (this commit) — **scaffold body**. Returns a typed
/// `unavailable` result so the TS adapter can degrade to the Phase 2
/// external-binary wrapper (bwrap / landlock-cli) without any wire
/// disruption. Phase 3.1 will replace the body with:
///
///   1. `policy::compile_ruleset(&policy)` → landlock `Ruleset`.
///   2. `seccomp::build_filter(&policy)` → seccompiler `BpfProgram`.
///   3. `fork()` child.
///   4. In child: apply landlock ruleset (post-exec ABI restriction),
///      install seccomp filter, then `execve(command)`.
///   5. In parent: `wait()`, capture stdout/stderr via pipe pair, return.
///
/// Cancellation: the TS adapter remembers the child PID and `kill(SIGTERM)`s
/// it when its `AbortSignal` fires.
#[napi]
pub fn spawn_sandboxed(
    _spec: NapiSandboxedSpawnSpec,
    _policy: NapiSandboxPolicy,
) -> napi::Result<NapiSpawnResult> {
    // Scaffold: surface "not yet implemented" via the typed result so the
    // TS adapter can fall through to the Phase 2 path without throwing.
    // Phase 3.1 replaces this with the real fork/landlock/seccomp/exec wire.
    Ok(NapiSpawnResult {
        exit_code: 127,
        stdout: String::new(),
        stderr: String::from(
            "linux-sandbox-native: scaffold body — Phase 3.1 impl pending (see ADR-0175)",
        ),
        sandbox_applied: false,
        degrade_reason: Some(String::from("native-impl-pending")),
    })
}

/// Probe kernel + ABI support for Landlock. Returns a JSON string the TS
/// adapter parses (avoids declaring a second `#[napi(object)]` purely for
/// availability).
///
/// Shape:
///   `{ "available": bool, "kernelVersion": string, "abiSupported": number, "reason"?: string }`
///
/// Phase 3 scaffold returns `available: false` with a typed reason so the
/// fallback chain still kicks in. Phase 3.1 wires this to
/// `landlock::ABI::new_current()` + `/proc/sys/kernel/osrelease` read.
#[napi]
pub fn availability() -> napi::Result<String> {
    Ok(String::from(
        r#"{"available":false,"kernelVersion":"","abiSupported":0,"reason":"native-impl-pending"}"#,
    ))
}
