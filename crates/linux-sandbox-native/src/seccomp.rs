//! seccomp BPF filter compile layer: `NapiSandboxPolicy` → seccompiler filter.
//!
//! **Scaffold** (ADR-0175 Phase 3). Function bodies are `unimplemented!()`.
//! Mirrors Codex `codex-linux-sandbox` seccomp denylist (`socket`,
//! `connect`, `accept`, `bind`, `listen`, `ptrace`, `mount`, `umount2`,
//! `unshare`, `setns`, `clone3` with NEWNS/NEWNET/NEWUSER, ...).
//!
//! ## Filter shape (Phase 3.1 target)
//!
//! Default action: `Allow`. Per-syscall actions:
//!   - Network family (`socket`/`connect`/`accept`/`bind`/`listen`/
//!     `sendto`/`recvfrom`/`sendmsg`/`recvmsg`) → `Errno(EACCES)` when
//!     policy denies network.
//!   - Privilege-escalation (`ptrace`/`process_vm_*`/`mount`/`umount2`/
//!     `pivot_root`/`chroot`) → `Errno(EPERM)` unconditionally.
//!   - Namespace manipulation (`unshare`/`setns`/`clone3` with NEWNS|
//!     NEWNET|NEWUSER flag bits) → `Errno(EPERM)`.
//!
//! Architecture: filter compiled for `target_arch` (x86_64 / aarch64);
//! `seccompiler::compile_filter` handles arch-specific syscall numbers.
//!
//! Phase 3.1 deferral: actual filter table + arg-matching for `clone3`
//! flags moves here as a `static FILTER_DENY_NET: Filter = ...`.

use crate::NapiSandboxPolicy;

/// Compiled seccomp BPF program placeholder.
///
/// Phase 3.1 swaps this for `seccompiler::BpfProgram` (raw BPF instruction
/// vector ready for `prctl(PR_SET_SECCOMP, ...)`).
pub struct CompiledFilter;

/// Compile `policy` to a seccomp BPF program.
///
/// Scaffold: returns `unimplemented!()`. Phase 3.1:
///   1. Build a `seccompiler::SeccompFilter` with `Allow` default.
///   2. Add per-syscall rules per the table in this module's docs.
///   3. `filter.try_into()` → `BpfProgram`.
pub fn build_filter(_policy: &NapiSandboxPolicy) -> Result<CompiledFilter, String> {
    unimplemented!("seccomp::build_filter — Phase 3.1 (see ADR-0175)")
}

/// Apply a compiled BPF program to the CURRENT thread (post-fork / pre-exec).
///
/// Scaffold: `unimplemented!()`. Phase 3.1 calls
/// `seccompiler::apply_filter(&program)`.
pub fn apply_filter(_filter: &CompiledFilter) -> Result<(), String> {
    unimplemented!("seccomp::apply_filter — Phase 3.1 (see ADR-0175)")
}
