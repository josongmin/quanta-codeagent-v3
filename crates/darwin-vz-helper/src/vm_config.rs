//! VM-configuration compile layer: `NapiMcpVmPolicy` →
//! `VZVirtualMachineConfiguration`.
//!
//! **Phase 3.3 scaffold** — all bodies are `unimplemented!()` doc-stubs so
//! the typed surface is reviewable + the Phase 3.4 impl can drop in
//! without changing call sites. Mirrors the
//! `crates/linux-sandbox-native/src/policy.rs` scaffold → real-impl
//! progression from ADR-0175 → ADR-0184.
//!
//! The whole module is `#[cfg(target_os = "macos")]`. On non-macOS hosts
//! the `objc2-virtualization` crate is not even compiled (gated in
//! Cargo.toml). `lib.rs` has the parallel non-macOS stubs.
//!
//! ## Profile → VM config mapping (Phase 3.4 plan)
//!
//! | TS profile             | VZ configuration                              |
//! |------------------------|-----------------------------------------------|
//! | `microvm`              | full VZVirtualMachine + Linux boot + vsock    |
//! | `container`            | rejected — fall through to Lima (ADR-0160)    |
//! | `process-isolated`     | rejected — bypass profile                     |
//! | `off`                  | rejected — bypass profile                     |
//!
//! ## ABI / framework compatibility
//!
//! Apple Virtualization framework is macOS 11+ (Big Sur). Linux guest
//! support is macOS 12+ (Monterey). Phase 3.4 will probe via
//! `VZVirtualMachineConfiguration::validateWithError:` rather than version
//! parsing — semantic check on the actual feature set we need.

#![cfg(target_os = "macos")]

use crate::NapiMcpVmPolicy;

/// Compile `policy` to a `VZVirtualMachineConfiguration` ready for
/// `VZVirtualMachine::new()`.
///
/// **Phase 3.3 scaffold** — returns a typed `String` error for now; Phase
/// 3.4 will return a real `VZVirtualMachineConfiguration` (boxed objc2
/// handle) and validate via `validateWithError:`.
///
/// Phase 3.4 pipeline:
///   1. Reject bypass profiles (`off`, `process-isolated`, `container`)
///   2. Validate workspace path is absolute (mirror `policy.rs` line 65)
///   3. Build `VZVirtualMachineConfiguration`:
///      - `cpuCount` = `policy.cpu_count.unwrap_or(1)`
///      - `memorySize` = `policy.memory_mb.unwrap_or(512) * 1024 * 1024`
///      - `bootLoader` from `boot_loader::select()`
///      - `storageDevices` = Vec with a `VZVirtioBlockDeviceConfiguration`
///        backed by the workspace + each `host_*_allowlist` entry
///      - `networkDevices` = Vec with a single
///        `VZVirtioNetworkDeviceConfiguration` iff `allow_network` true
///      - `socketDevices` = Vec with a `VZVirtioSocketDeviceConfiguration`
///        for vsock IPC bridging
///   4. `validateWithError:` — surface typed validation failure (entitlement
///      missing, kernel mismatch, etc.)
#[allow(dead_code)]
pub fn compile_configuration(policy: &NapiMcpVmPolicy) -> Result<VmConfigHandle, String> {
    // Phase 3.3: defensive profile rejection (matches the bypass-reject
    // pattern from `linux-sandbox-native/src/policy.rs::compile_ruleset`).
    // The TS adapter already short-circuits these profiles at
    // `registry.ts`; reaching here would be a wire contract bug.
    match policy.profile.as_str() {
        "microvm" => {}
        other @ ("off" | "process-isolated" | "container") => {
            return Err(format!(
                "vm_config: profile {} not handled by darwin-vz backend (TS registry routing bug)",
                other
            ));
        }
        other => return Err(format!("vm_config: unknown profile {other}")),
    }

    if !policy.workspace.starts_with('/') {
        return Err(format!(
            "vm_config: workspace must be absolute, got {}",
            policy.workspace
        ));
    }

    // Phase 3.4: build the real configuration here. For now Phase 3.3
    // returns a sentinel handle so the TS adapter's typed failure path is
    // exercised (the adapter never actually calls `compile_configuration`
    // — it goes through `spawn_vm_for_mcp` which returns `napi::Error`).
    unimplemented!(
        "vm_config::compile_configuration: Phase 3.3 scaffold — Phase 3.4 will build VZVirtualMachineConfiguration"
    )
}

/// Opaque handle to a compiled VM configuration. Phase 3.3 is a sentinel
/// type; Phase 3.4 will wrap an `objc2::Retained<VZVirtualMachineConfiguration>`.
///
/// Crossing the napi boundary as an opaque `External<T>` is the Phase 3.4
/// plan — the TS adapter never inspects the inner shape, only round-trips
/// it back to `spawn_vm_for_mcp` (currently the call site is internal —
/// `lib.rs::spawn_vm_for_mcp` builds the config and consumes it in one
/// call without crossing napi).
#[allow(dead_code)]
pub struct VmConfigHandle {
    // Phase 3.4: pub(crate) configuration: Retained<VZVirtualMachineConfiguration>
    _phantom: (),
}
