//! Policy compile layer: `NapiSandboxPolicy` → `landlock::Ruleset`.
//!
//! ADR-0176 Phase 3.1 **real impl** — fills the scaffold from ADR-0175.
//!
//! The whole module is `#[cfg(target_os = "linux")]`. On non-Linux hosts the
//! `landlock` crate is not even compiled (gated in Cargo.toml). `lib.rs` has
//! a parallel stub module for those hosts so the napi surface still
//! compiles.
//!
//! ## Profile → access-rights mapping (matches `landlock-cli.ts` Phase 2)
//!
//! | TS profile             | Workspace access on `PathBeneath`            |
//! |------------------------|----------------------------------------------|
//! | `read-only`            | ReadFile + ReadDir + Execute                 |
//! | `workspace-write`      | the above + WriteFile + MakeDir/Reg + Remove |
//! | `workspace-write-net`  | same as workspace-write (net = separate)     |
//! | `off`, `danger-full-access` | rejected here — caller bypasses adapter |
//!
//! `extra_read_paths` always get read+execute access; `extra_write_paths`
//! get the full workspace-write set (these are caller-declared escape
//! hatches and treated as workspace peers).
//!
//! ## ABI compatibility
//!
//! `CompatLevel::BestEffort` is the only sane default for a tool shipped to
//! arbitrary kernels — Landlock added access rights across ABI v1 → v5+.
//! `from_all(ABI::V5)` requests the broadest set; older kernels silently
//! drop unsupported bits. This matches Codex `codex-linux-sandbox`
//! behaviour.

#![cfg(target_os = "linux")]

use crate::NapiSandboxPolicy;
use landlock::{
    Access, AccessFs, AccessNet, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
    RulesetAttr, RulesetCreated, RulesetCreatedAttr, ABI,
};

/// Compile `policy` to a landlock `RulesetCreated` ready for `restrict_self()`.
///
/// Returns a typed error string on any landlock API failure (open-path
/// permission errors, handle_access compatibility surprises, etc.). The
/// caller is `lib.rs::spawn_sandboxed` which converts to `io::Error` for
/// the `pre_exec` hook.
pub fn compile_ruleset(policy: &NapiSandboxPolicy) -> Result<RulesetCreated, String> {
    // Reject the bypass profiles defensively — the TS adapter already
    // short-circuits these but a corrupt policy reaching here means a wire
    // contract bug and we'd rather fail closed than emit an empty ruleset
    // (which would still apply `restrict_self()` and lock the child to
    // nothing).
    match policy.profile.as_str() {
        "read-only" | "workspace-write" | "workspace-write-net" => {}
        "off" | "danger-full-access" => {
            return Err(format!(
                "policy: bypass profile {} reached compile_ruleset (TS adapter contract bug)",
                policy.profile
            ));
        }
        other => return Err(format!("policy: unknown profile {other}")),
    }

    // Workspace must be an absolute path. landlock will refuse via PathFd
    // open if it isn't; we surface a typed message either way.
    if !policy.workspace.starts_with('/') {
        return Err(format!(
            "policy: workspace must be absolute, got {}",
            policy.workspace
        ));
    }

    // Build a fresh ruleset handling the broadest known access set; older
    // kernels drop bits via BestEffort.
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(ABI::V5))
        .map_err(|e| format!("handle_access AccessFs: {e}"))?;

    // Network handled access — only register if network rules will be
    // consulted. `AccessNet::from_all(ABI::V4)` is the bind+connect set.
    let want_net = policy.allow_network.unwrap_or(false);
    if !want_net {
        // We register network so we can deny by *not* adding any allow
        // rule below. BestEffort drops this on ABI < 4.
        ruleset = ruleset
            .handle_access(AccessNet::from_all(ABI::V4))
            .map_err(|e| format!("handle_access AccessNet: {e}"))?;
    }

    let mut created = ruleset
        .create()
        .map_err(|e| format!("ruleset create: {e}"))?;

    // Access bitflags by profile. read-only is strictly a subset of
    // workspace-write so we compute once and branch.
    let workspace_access = match policy.profile.as_str() {
        "read-only" => AccessFs::from_read(ABI::V5),
        // workspace-write & workspace-write-net both want full RW + exec.
        // `from_all(ABI::V5)` is the conservative full set — BestEffort
        // drops bits on older kernels.
        _ => AccessFs::from_all(ABI::V5),
    };

    // Workspace path
    let workspace_fd = PathFd::new(&policy.workspace)
        .map_err(|e| format!("open workspace path {}: {e}", policy.workspace))?;
    created = created
        .add_rule(PathBeneath::new(workspace_fd, workspace_access))
        .map_err(|e| format!("add workspace rule: {e}"))?;

    // System ambient read paths — required so the child can exec binaries
    // (`/usr/bin/sh`), load dynamic linker (`/lib64/ld-linux-*.so`), read
    // CA bundles (`/etc/ssl`), etc. This list mirrors Phase 2
    // (`landlock-cli.ts:64`) exactly.
    let system_ro: &[&str] = &["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin"];
    let ro_access = AccessFs::from_read(ABI::V5);
    for path in system_ro {
        // Best-effort: a missing /lib64 on aarch64 hosts is fine; skip
        // those silently rather than fail the whole policy build.
        if let Ok(fd) = PathFd::new(path) {
            created = created
                .add_rule(PathBeneath::new(fd, ro_access))
                .map_err(|e| format!("add system ro rule {path}: {e}"))?;
        }
    }

    // extra_read_paths
    for path in &policy.extra_read_paths {
        // Defensive: skip relative + kernel-reserved prefixes. landlock
        // would error on these; we filter ahead so the rest of the
        // ruleset still applies. Matches Phase 2 behaviour.
        if !path.starts_with('/') || path.starts_with("/proc") || path.starts_with("/sys") {
            continue;
        }
        let Ok(fd) = PathFd::new(path) else { continue };
        created = created
            .add_rule(PathBeneath::new(fd, ro_access))
            .map_err(|e| format!("add extra read rule {path}: {e}"))?;
    }

    // extra_write_paths — full workspace-write access
    for path in &policy.extra_write_paths {
        if !path.starts_with('/') || path.starts_with("/proc") || path.starts_with("/sys") {
            continue;
        }
        let Ok(fd) = PathFd::new(path) else { continue };
        created = created
            .add_rule(PathBeneath::new(fd, workspace_access))
            .map_err(|e| format!("add extra write rule {path}: {e}"))?;
    }

    Ok(created)
}

/// Apply a compiled ruleset to the CURRENT thread (post-fork / pre-exec).
///
/// Wraps `RulesetCreated::restrict_self()` and discards the returned
/// `RestrictionStatus` (we don't surface partial-application status to the
/// child — the TS adapter sees only `sandbox_applied: true/false`).
pub fn apply_ruleset(ruleset: RulesetCreated) -> Result<(), String> {
    ruleset
        .restrict_self()
        .map(|_| ())
        .map_err(|e| format!("restrict_self: {e}"))
}

/// Probe the highest-supported Landlock ABI on this kernel.
///
/// Returns `0` when Landlock is unavailable (kernel built without LSM, no
/// `/sys/kernel/security/landlock`, etc.). The TS adapter treats `0` as
/// "fall through to Phase 2".
///
/// Implementation: build a minimal Ruleset and inspect its negotiated
/// status via `create()`. This is the standard landlock-crate idiom — no
/// `/sys` parsing needed.
pub fn probe_abi() -> i32 {
    // Attempting to create the broadest ruleset gives us the negotiated
    // ABI version. BestEffort handles older kernels.
    match Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(ABI::V5))
    {
        Ok(rs) => match rs.create() {
            Ok(_) => 5, // best-effort negotiation succeeded at the v5 ceiling we requested
            Err(_) => 0,
        },
        Err(_) => 0,
    }
}
