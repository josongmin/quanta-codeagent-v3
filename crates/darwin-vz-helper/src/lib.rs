//! `darwin-vz-helper` — napi-rs binding for quanta MCP Skybridge's macOS
//! Virtualization.framework (Apple VZ) microVM backend.
//!
//! **Phase 3.3 scaffold** (ADR-0190). Sibling crate to
//! `crates/linux-sandbox-native` (ADR-0175 / 0184). Real VZ bring-up bodies
//! land in Phase 3.4 (separate ADR) — this file is the typed surface +
//! "unavailable" stubs.
//!
//! ## Layout
//!
//! Two `#[napi]` entry points (the contract for the TypeScript adapter in
//! `src/mcp/skybridge/applevz-native.ts`):
//!
//!   - `spawn_vm_for_mcp(spec, policy) -> NapiVmSpawnResult`
//!   - `availability() -> String` (JSON envelope; matches landlock-native)
//!
//! Three `#[napi(object)]` value types matching the TS shapes:
//!   - `NapiMcpVmPolicy`    — declarative VZ policy (profile + allowlists)
//!   - `NapiVmSpawnSpec`    — what to launch (id + argv + env)
//!   - `NapiVmSpawnResult`  — handle envelope (vm_id + ipc + applied flag)
//!
//! napi-rs converts snake_case Rust ↔ camelCase JS automatically. Field
//! names mirror the TS adapter's expected shape exactly.
//!
//! ## Platform gating
//!
//! `objc2-virtualization` + friends are macOS-only crates (Cargo.toml gates
//! them by `cfg(target_os = "macos")`). The real impl modules
//! (`vm_config` + `boot_loader`) are themselves `#![cfg(target_os = "macos")]`.
//! On non-macOS hosts the napi exports still compile but return typed
//! "unavailable" results — the IDE-friendly path (rust-analyzer on
//! Linux/Windows doesn't choke) and also exactly what we want at runtime
//! if the per-triple npm artifact is installed on a non-macOS host by
//! mistake.
//!
//! ## SOTA reference
//!
//! - Claude Desktop's Skybridge proprietary yukonSilver microVM uses
//!   Virtualization.framework on macOS (mirrors this binding).
//! - Lima open-source CLI wraps the same framework via Swift; ADR-0160's
//!   external-CLI fallback is the byte-identical fallback tier below this.
//! - Codex `codex-rs` has no AVF native binding (Lima only) — this crate
//!   is quanta's clean lead.
//!
//! ## Phase 3.4 deferred (not in this scaffold)
//!
//! - Real `VZVirtualMachineConfiguration` compile
//! - Linux boot loader (kernel + initrd) selection
//! - Disk image management (QCow / RAW DMG / curated registry)
//! - vsock IPC bridging
//! - Entitlements + signing for Virtualization.framework access

use napi_derive::napi;
use std::collections::HashMap;

#[cfg(target_os = "macos")]
pub mod boot_loader;
#[cfg(target_os = "macos")]
pub mod vm_config;

/// Typed VM policy ferried across the napi boundary.
///
/// Field names mirror the TS `McpSandboxPolicy` shape (with the addition of
/// `cpu_count` + `boot_image_path` that are AVF-specific) with napi-rs
/// snake_case conversion. `profile` is intentionally a `String` here (not
/// an enum) — the TS side already validates the closed `SkybridgeProfile`
/// union; the Rust side rejects unknown profiles with a typed error in
/// `vm_config.rs`.
///
/// `network_allowlist` / `host_read_allowlist` / `host_write_allowlist` are
/// non-optional `Vec<String>` (defaulted to empty by the TS adapter when
/// absent) — napi-rs has known rough edges with `Option<Vec<_>>` on some
/// ABI versions; defaulting to `[]` matches the empty-array semantics of
/// the TS port without losing information. (Same pattern as
/// `NapiSandboxPolicy.extra_*_paths` in `linux-sandbox-native`.)
#[napi(object)]
pub struct NapiMcpVmPolicy {
    /// One of: "off" | "process-isolated" | "container" | "microvm"
    /// Only "microvm" is meaningful to this backend — others compile to a
    /// typed "wrong-backend" rejection in vm_config.
    pub profile: String,
    /// Absolute path to the workspace root (mounted RW into the guest).
    pub workspace: String,
    /// Network policy override; `None` means "follow profile default".
    pub allow_network: Option<bool>,
    /// Allowlist of outbound `host:port` (best-effort guest-side enforcement
    /// + future host-side MITM proxy). Empty = deny-all.
    pub network_allowlist: Vec<String>,
    /// Host paths the guest may read (mounted RO).
    pub host_read_allowlist: Vec<String>,
    /// Host paths the guest may write (mounted RW).
    pub host_write_allowlist: Vec<String>,
    /// Memory cap in MB (Phase 3.4: maps to `VZVirtualMachineConfiguration::memorySize`).
    pub memory_mb: Option<u32>,
    /// CPU count (Phase 3.4: maps to `VZVirtualMachineConfiguration::cpuCount`).
    pub cpu_count: Option<u32>,
    /// Wall-clock cap in milliseconds (host-side; AVF has no in-VM timeout).
    pub max_runtime_ms: Option<u32>,
    /// Path to the boot image (Linux kernel / initrd / disk DMG). Caller
    /// supplies; Phase 3.4 may add a curated default registry.
    pub boot_image_path: Option<String>,
}

/// VM spawn spec — id + argv + env. Mirrors the TS `McpServerSpec`. `cwd` is
/// intentionally NOT here (guest filesystem layout is policy-driven, not
/// per-spawn).
#[napi(object)]
pub struct NapiVmSpawnSpec {
    /// Stable id within ONE quanta session (e.g. "github-mcp"). Used to
    /// derive a deterministic VM id.
    pub mcp_id: String,
    /// argv to invoke INSIDE the guest after boot.
    pub command: Vec<String>,
    /// Env to pass into the guest. `None` = inherit guest defaults.
    pub env: Option<HashMap<String, String>>,
}

/// VM spawn result — handle envelope. Mirrors the TS `McpSandboxHandle`
/// minus the `stop()` thunk (that's TS-side; the binding returns the
/// `vm_id` the TS adapter uses to issue `stop` later via a separate napi
/// call — Phase 3.4).
///
/// `ipc_kind` is the IPC channel category the caller layers MCP JSON-RPC
/// on top of:
///   - `"vsock"`            : VM-native AF_VSOCK socket (Phase 3.4 target)
///   - `"stdio-over-ssh"`   : stdio piped via SSH into the guest (fallback)
///   - `"passthrough"`      : no VM in effect (scaffold / degraded)
///
/// `degrade_reason` is emitted iff the VM could not be fully brought up;
/// the TS adapter maps this to the typed `degradeReason` field (omitted
/// when `None`, matching exactOptional).
#[napi(object)]
pub struct NapiVmSpawnResult {
    pub vm_id: String,
    pub ipc_kind: String,
    pub ipc_ref: String,
    pub sandbox_applied: bool,
    pub degrade_reason: Option<String>,
}

/// Spawn a VZ microVM for an MCP server and return a handle envelope.
///
/// **Phase 3.3 scaffold**: returns a typed `napi::Error` so the TS adapter's
/// try/catch path converts it to `McpSandboxError("backend-unavailable")`
/// with the typed `degradeReason: "darwin-vz-phase3.3-scaffold"`. Phase 3.4
/// fills the body with real `VZVirtualMachine::start()`.
///
/// Pipeline (Phase 3.4 — documented here so the contract is stable):
///   1. `vm_config::compile_configuration(&policy, &spec)` →
///      `VZVirtualMachineConfiguration`
///   2. `boot_loader::select(&policy)` → `VZBootLoader` (Linux or macOS)
///   3. `VZVirtualMachine::new(configuration)` + `start()` (async via block2)
///   4. Resolve vsock port via `VZVirtioSocketDeviceConfiguration`
///   5. Return `NapiVmSpawnResult { vm_id, ipc_kind: "vsock", ipc_ref: "<port>", sandbox_applied: true }`
#[napi]
#[cfg(target_os = "macos")]
pub fn spawn_vm_for_mcp(
    _spec: NapiVmSpawnSpec,
    _policy: NapiMcpVmPolicy,
) -> napi::Result<NapiVmSpawnResult> {
    // Phase 3.3: return a typed Err so the TS adapter's catch arm wraps it
    // in McpSandboxError("backend-unavailable"). When Phase 3.4 lands the
    // body becomes the VZ bring-up pipeline documented above.
    Err(napi::Error::from_reason(
        "darwin-vz: Phase 3.3 scaffold — real VZVirtualMachine bring-up lands in Phase 3.4",
    ))
}

/// Non-macOS fallback: typed Err so the per-triple npm artifact, if
/// accidentally installed on Linux / Windows, still composes with the TS
/// fallback chain. `registry.ts` darwin branch is the only production
/// caller; this exists for IDE compile only.
#[napi]
#[cfg(not(target_os = "macos"))]
pub fn spawn_vm_for_mcp(
    _spec: NapiVmSpawnSpec,
    _policy: NapiMcpVmPolicy,
) -> napi::Result<NapiVmSpawnResult> {
    Err(napi::Error::from_reason(
        "darwin-vz-helper: not supported on this platform (macOS-only)",
    ))
}

/// Probe Virtualization.framework availability. Returns a JSON string the
/// TS adapter parses (avoids declaring a second `#[napi(object)]` purely
/// for availability — mirrors `linux-sandbox-native::availability`).
///
/// Shape:
///   `{ "available": bool, "backend": "apple-virtualization" | "passthrough",
///      "reason"?: string }`
///
/// macOS Phase 3.3 (this scaffold) returns `available: false` with reason
/// `"vz-phase3.3-scaffold"`. Phase 3.4 will probe:
///   - `VZVirtualMachineConfiguration::validateWithError:` (entitlements
///     + framework load)
///   - `VZLinuxBootLoader` instantiation (basic AVF availability sanity)
///   - AVF entitlement check on the calling process
///
/// Non-macOS hosts always return `available: false` with reason
/// `"platform-unsupported"`.
#[napi]
#[cfg(target_os = "macos")]
pub fn availability() -> napi::Result<String> {
    Ok(String::from(
        r#"{"available":false,"backend":"apple-virtualization","reason":"vz-phase3.3-scaffold"}"#,
    ))
}

/// Non-macOS availability stub: always `available: false` with a typed
/// reason. Backend reported as `"passthrough"` so the TS adapter routes
/// to the next tier (Lima external CLI / final passthrough).
#[napi]
#[cfg(not(target_os = "macos"))]
pub fn availability() -> napi::Result<String> {
    Ok(String::from(
        r#"{"available":false,"backend":"passthrough","reason":"platform-unsupported"}"#,
    ))
}
