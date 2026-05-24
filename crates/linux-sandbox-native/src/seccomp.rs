//! seccomp BPF filter compile layer.
//!
//! ADR-0176 Phase 3.1 **lax-mode wire**.
//!
//! Phase 3.1 ships a **lax** filter that allows all syscalls. The wire
//! (compile → BpfProgram → `prctl(PR_SET_NO_NEW_PRIVS) + PR_SET_SECCOMP`)
//! is installed and the child runs through it, but the filter table is
//! empty — every syscall hits `mismatch_action: Allow`.
//!
//! Why lax in Phase 3.1?
//!   - Getting a strict default-deny syscall allowlist right is its own
//!     design round (Codex's `codex-linux-sandbox` filter is ~80 syscalls
//!     and each entry has been tuned against the long tail of libc
//!     behaviour). Shipping the wire first means Phase 3.2 can swap the
//!     filter table in without touching the spawn pipeline.
//!   - Landlock alone covers filesystem + (with ABI v4+) network policy.
//!     The syscall-level deny adds defense-in-depth against namespace
//!     escape (`unshare`, `setns`, `clone3` with NEWNS|NEWNET|NEWUSER)
//!     and ptrace — important but orthogonal to the Phase 3.1 ship goal.
//!   - The lax filter still installs `PR_SET_NO_NEW_PRIVS=1` via the
//!     seccompiler `apply_filter` path, which itself blocks setuid binary
//!     execution — a meaningful non-zero baseline.
//!
//! Phase 3.2 will replace this with a per-policy strict filter; the
//! exported `build_and_apply()` signature is stable so the spawn pipeline
//! doesn't change.

#![cfg(target_os = "linux")]

use seccompiler::{apply_filter, BpfProgram, SeccompAction, SeccompFilter, TargetArch};
use std::collections::BTreeMap;

/// Compile a lax seccomp filter and apply it to the current thread.
///
/// Returns a typed error string on any seccompiler failure. The caller is
/// `lib.rs::spawn_sandboxed` which converts to `io::Error` for the
/// `pre_exec` hook. Must run in the child AFTER fork, BEFORE landlock
/// `restrict_self()` and BEFORE `execve()`.
pub fn build_and_apply() -> Result<(), String> {
    // Pick the host architecture's syscall numbering. seccompiler 0.5
    // supports x86_64 / aarch64 / riscv64. The cdylib is shipped per
    // target triple by napi-rs, so cfg-gating is correct here (every
    // built artifact picks exactly one).
    let target = if cfg!(target_arch = "x86_64") {
        TargetArch::x86_64
    } else if cfg!(target_arch = "aarch64") {
        TargetArch::aarch64
    } else {
        // Unsupported arch — fall through with no filter applied. Caller
        // sees the typed error and degrades to passthrough.
        return Err(format!(
            "seccomp: unsupported target_arch {}",
            std::env::consts::ARCH
        ));
    };

    // Empty rule table + Allow default = lax mode. Match action is also
    // Allow but unused (no rules can match).
    let filter = SeccompFilter::new(
        BTreeMap::new(),
        SeccompAction::Allow,
        SeccompAction::Allow,
        target,
    )
    .map_err(|e| format!("seccomp filter new: {e}"))?;

    let program: BpfProgram = filter
        .try_into()
        .map_err(|e| format!("seccomp compile: {e}"))?;

    apply_filter(&program).map_err(|e| format!("seccomp apply: {e}"))?;

    Ok(())
}
