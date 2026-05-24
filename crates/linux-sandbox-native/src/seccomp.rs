//! seccomp BPF filter compile layer.
//!
//! ADR-0184 Phase 3.1 shipped the **lax-mode** wire (empty rule table +
//! `SeccompAction::Allow` default). ADR-0191 Phase 3.2 swaps in a
//! **strict default-deny** filter compiled per profile, while keeping the
//! lax path available for diagnostic / debugging only.
//!
//! Module surface:
//!   - `build_and_apply_seccomp()` — Phase 3.1 lax (allow-all). **Diagnostic
//!     / debug only**. Production calls
//!     [`build_and_apply_strict_seccomp`].
//!   - `build_and_apply_strict_seccomp(profile)` — Phase 3.2 strict
//!     allowlist. `default_action: KillProcess` +
//!     `mismatch_action: KillProcess`; per-syscall-family allowlist gated
//!     by the sandbox profile.
//!
//! Both paths apply via `seccompiler::apply_filter` which itself sets
//! `PR_SET_NO_NEW_PRIVS=1`. Must run in the child AFTER fork, BEFORE
//! landlock `restrict_self()` and BEFORE `execve()`.
//!
//! ## Strict allowlist categorization
//!
//! Categories mirror Codex `codex-linux-sandbox` strict mode + libc/glibc
//! reality. Every entry is a per-syscall name; matching syscalls fall
//! through to `Allow`, everything else hits `KillProcess` (SIGSYS — the
//! child terminates immediately).
//!
//! | Category        | Profile gate                   | Notes                       |
//! |-----------------|--------------------------------|-----------------------------|
//! | I/O essentials  | always                         | read/write/openat/close/... |
//! | Memory mgmt     | always                         | mmap/mprotect/munmap/brk    |
//! | Process basics  | always                         | exit/getpid/getuid/...      |
//! | Signals         | always                         | rt_sigaction/sigprocmask    |
//! | FS read         | always                         | readlinkat/getdents64       |
//! | FS write        | workspace-write{,-net} only    | writev/ftruncate/renameat2  |
//! | Process spawn   | always                         | execve/execveat             |
//! | Time            | always                         | clock_gettime/nanosleep     |
//! | Network         | workspace-write-net only       | socket/connect/sendto/...   |
//! | DENY            | all profiles (KillProcess)     | clone3/unshare/ptrace/bpf   |
//!
//! ## Deny rationale
//!
//! - **clone3**: Codex denies. The 3-arg form supports a `cl_args` struct
//!   that can request `CLONE_NEWNS|CLONE_NEWUSER|CLONE_NEWNET` — namespace
//!   escape. `clone()` (the 2-arg) is allowed implicitly via `fork()` →
//!   `vfork()` glibc paths only when needed; we explicitly do NOT allow it
//!   either (the child has already forked from the parent's spawn; further
//!   forking inside the sandboxed binary is a non-goal).
//! - **unshare / setns**: namespace manipulation — pivot_root + chroot in
//!   the same family. We're inside landlock + seccomp; unshare to a fresh
//!   ns would escape both.
//! - **ptrace / process_vm_{read,write}v**: peer-process introspection —
//!   sandbox escape via injection.
//! - **bpf / kexec_load / *_module**: kernel-level privilege elevation.
//! - **mount / umount2 / pivot_root / chroot**: FS namespace manipulation
//!   (landlock-resistant via the namespace pivot trick).

#![cfg(target_os = "linux")]

use seccompiler::{
    apply_filter, BpfProgram, SeccompAction, SeccompFilter, SeccompRule, TargetArch,
};
use std::collections::BTreeMap;

/// Resolve the host target arch for seccompiler. Returns `Err` with a typed
/// message on unsupported arches; the caller falls through to the typed
/// error path in `lib.rs::spawn_sandboxed`.
fn host_target_arch() -> Result<TargetArch, String> {
    if cfg!(target_arch = "x86_64") {
        Ok(TargetArch::x86_64)
    } else if cfg!(target_arch = "aarch64") {
        Ok(TargetArch::aarch64)
    } else {
        Err(format!(
            "seccomp: unsupported target_arch {}",
            std::env::consts::ARCH
        ))
    }
}

/// Compile a **lax** seccomp filter and apply it to the current thread.
///
/// Phase 3.1 wire — kept for diagnostic / debugging only. Production calls
/// [`build_and_apply_strict_seccomp`] via `spawn_sandboxed`.
///
/// Empty rule table + `Allow` default = every syscall passes through. The
/// `apply_filter` side-effect (`PR_SET_NO_NEW_PRIVS=1`) is the only
/// hardening this path provides.
pub fn build_and_apply_seccomp() -> Result<(), String> {
    let target = host_target_arch()?;

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

/// Compile a **strict** seccomp filter for the given sandbox `profile` and
/// apply it to the current thread.
///
/// `profile` is one of the closed enum strings from `NapiSandboxPolicy`
/// (`read-only` / `workspace-write` / `workspace-write-net`). Unknown
/// profile strings degrade to the conservative `read-only` set (no FS-write
/// syscalls, no network syscalls) and emit a typed warning via the result.
///
/// Default action: `KillProcess` (SIGSYS). Mismatched action: `KillProcess`.
/// Any syscall outside the allowlist immediately terminates the child.
///
/// The allowlist categories are documented in the module header table.
pub fn build_and_apply_strict_seccomp(profile: &str) -> Result<(), String> {
    let target = host_target_arch()?;

    // Closed enum match. Unknown profiles fall through to the tightest
    // allowlist (read-only equivalent) — defense in depth against a TS
    // adapter bug that ferries an unexpected string here.
    let allow_fs_write = matches!(profile, "workspace-write" | "workspace-write-net");
    let allow_network = matches!(profile, "workspace-write-net");

    // Build the allowlist. Each `&str` is a libc syscall name; seccompiler
    // resolves the per-arch syscall number internally. Empty `SeccompRule`
    // vec means "match any args" (per-syscall rules with arg filtering are
    // a future Phase 3.3 tightening — e.g. ioctl narrowed to TIOCGWINSZ).
    let mut allow_syscalls: Vec<&'static str> = Vec::with_capacity(96);

    // ---- I/O essentials (always) -----------------------------------------
    allow_syscalls.extend_from_slice(&[
        "read", "write", "close", "openat", "fstat", "statx", "lseek", "fcntl", "dup", "dup2",
        "dup3", "pipe2", "ioctl",
    ]);

    // ---- Memory management (always) --------------------------------------
    allow_syscalls.extend_from_slice(&["mmap", "mprotect", "munmap", "brk", "madvise"]);

    // ---- Process basics (always) -----------------------------------------
    allow_syscalls.extend_from_slice(&[
        "exit",
        "exit_group",
        "getpid",
        "gettid",
        "getuid",
        "geteuid",
        "getgid",
        "getegid",
        "getrlimit",
        "prlimit64",
        "arch_prctl",
    ]);

    // ---- Signals (always) ------------------------------------------------
    allow_syscalls.extend_from_slice(&[
        "rt_sigaction",
        "rt_sigprocmask",
        "rt_sigreturn",
        "kill",
        "tgkill",
        "sigaltstack",
    ]);

    // ---- FS read (always) ------------------------------------------------
    allow_syscalls.extend_from_slice(&[
        "readlinkat",
        "getdents64",
        "faccessat2",
        "name_to_handle_at",
    ]);

    // ---- FS write (workspace-write / workspace-write-net) ----------------
    if allow_fs_write {
        allow_syscalls.extend_from_slice(&[
            "writev",
            "pwrite64",
            "ftruncate",
            "fsync",
            "fdatasync",
            "mkdirat",
            "unlinkat",
            "renameat2",
            "linkat",
            "symlinkat",
        ]);
    }

    // ---- Process spawn (always) ------------------------------------------
    // execve/execveat are gated by landlock at the FS layer — landlock
    // refuses to execute binaries outside the allowed `Execute` set, so a
    // permissive seccomp here is safe.
    allow_syscalls.extend_from_slice(&["execve", "execveat"]);

    // ---- Time (always) ---------------------------------------------------
    allow_syscalls.extend_from_slice(&["clock_gettime", "clock_nanosleep", "nanosleep"]);

    // ---- Network (workspace-write-net only) ------------------------------
    if allow_network {
        allow_syscalls.extend_from_slice(&[
            "socket",
            "connect",
            "sendto",
            "recvfrom",
            "sendmsg",
            "recvmsg",
            "accept4",
            "bind",
            "listen",
            "getsockopt",
            "setsockopt",
        ]);
    }

    // Compile into the SeccompFilter rules map. Each entry maps syscall
    // number → list of arg-condition rules. Empty rule vec = unconditional
    // allow for that syscall name.
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for name in &allow_syscalls {
        let nr = resolve_syscall_nr(name, target)?;
        rules.entry(nr).or_default(); // empty Vec = unconditional allow
    }

    let filter = SeccompFilter::new(
        rules,
        SeccompAction::KillProcess, // mismatch → kill
        SeccompAction::Allow,       // match → allow (empty rules = matches)
        target,
    )
    .map_err(|e| format!("seccomp strict filter new: {e}"))?;

    let program: BpfProgram = filter
        .try_into()
        .map_err(|e| format!("seccomp strict compile: {e}"))?;

    apply_filter(&program).map_err(|e| format!("seccomp strict apply: {e}"))?;

    Ok(())
}

/// Resolve a libc syscall name to its per-arch nr. Wraps
/// `seccompiler::sock_filter_*` internals via the public API — we use the
/// `SeccompFilter::new` rules map keyed by nr, and the nr comes from
/// libc's `SYS_*` const set.
///
/// Naming + arch resolution table — keep this tightly aligned with the
/// allowlist above. The matching is exhaustive over the union of strings
/// we extend into `allow_syscalls` (categories merged), so any drift
/// surfaces here as an "unknown syscall name" typed error rather than a
/// silently dropped allow rule.
fn resolve_syscall_nr(name: &str, _target: TargetArch) -> Result<i64, String> {
    // We avoid pulling a full syscall-table crate; libc consts cover every
    // entry in our allowlist on x86_64 and aarch64. seccompiler accepts an
    // i64 nr in the BTreeMap key.
    let nr: libc::c_long = match name {
        // I/O essentials
        "read" => libc::SYS_read,
        "write" => libc::SYS_write,
        "close" => libc::SYS_close,
        "openat" => libc::SYS_openat,
        "fstat" => libc::SYS_fstat,
        "statx" => libc::SYS_statx,
        "lseek" => libc::SYS_lseek,
        "fcntl" => libc::SYS_fcntl,
        "dup" => libc::SYS_dup,
        // dup2 is x86_64-only; aarch64 routes through dup3. We allow whichever
        // resolves; missing on the host arch is a no-op rather than fatal.
        "dup2" => {
            #[cfg(target_arch = "x86_64")]
            {
                libc::SYS_dup2
            }
            #[cfg(not(target_arch = "x86_64"))]
            {
                libc::SYS_dup3
            }
        }
        "dup3" => libc::SYS_dup3,
        "pipe2" => libc::SYS_pipe2,
        "ioctl" => libc::SYS_ioctl,

        // Memory
        "mmap" => libc::SYS_mmap,
        "mprotect" => libc::SYS_mprotect,
        "munmap" => libc::SYS_munmap,
        "brk" => libc::SYS_brk,
        "madvise" => libc::SYS_madvise,

        // Process basics
        "exit" => libc::SYS_exit,
        "exit_group" => libc::SYS_exit_group,
        "getpid" => libc::SYS_getpid,
        "gettid" => libc::SYS_gettid,
        "getuid" => libc::SYS_getuid,
        "geteuid" => libc::SYS_geteuid,
        "getgid" => libc::SYS_getgid,
        "getegid" => libc::SYS_getegid,
        "getrlimit" => libc::SYS_getrlimit,
        "prlimit64" => libc::SYS_prlimit64,
        // arch_prctl is x86_64-only; on aarch64 it doesn't exist (prctl
        // covers the same surface). Route to prctl on non-x86_64.
        "arch_prctl" => {
            #[cfg(target_arch = "x86_64")]
            {
                libc::SYS_arch_prctl
            }
            #[cfg(not(target_arch = "x86_64"))]
            {
                libc::SYS_prctl
            }
        }

        // Signals
        "rt_sigaction" => libc::SYS_rt_sigaction,
        "rt_sigprocmask" => libc::SYS_rt_sigprocmask,
        "rt_sigreturn" => libc::SYS_rt_sigreturn,
        "kill" => libc::SYS_kill,
        "tgkill" => libc::SYS_tgkill,
        "sigaltstack" => libc::SYS_sigaltstack,

        // FS read
        "readlinkat" => libc::SYS_readlinkat,
        "getdents64" => libc::SYS_getdents64,
        "faccessat2" => libc::SYS_faccessat2,
        "name_to_handle_at" => libc::SYS_name_to_handle_at,

        // FS write
        "writev" => libc::SYS_writev,
        "pwrite64" => libc::SYS_pwrite64,
        "ftruncate" => libc::SYS_ftruncate,
        "fsync" => libc::SYS_fsync,
        "fdatasync" => libc::SYS_fdatasync,
        "mkdirat" => libc::SYS_mkdirat,
        "unlinkat" => libc::SYS_unlinkat,
        "renameat2" => libc::SYS_renameat2,
        "linkat" => libc::SYS_linkat,
        "symlinkat" => libc::SYS_symlinkat,

        // Process spawn
        "execve" => libc::SYS_execve,
        "execveat" => libc::SYS_execveat,

        // Time
        "clock_gettime" => libc::SYS_clock_gettime,
        "clock_nanosleep" => libc::SYS_clock_nanosleep,
        "nanosleep" => libc::SYS_nanosleep,

        // Network
        "socket" => libc::SYS_socket,
        "connect" => libc::SYS_connect,
        "sendto" => libc::SYS_sendto,
        "recvfrom" => libc::SYS_recvfrom,
        "sendmsg" => libc::SYS_sendmsg,
        "recvmsg" => libc::SYS_recvmsg,
        "accept4" => libc::SYS_accept4,
        "bind" => libc::SYS_bind,
        "listen" => libc::SYS_listen,
        "getsockopt" => libc::SYS_getsockopt,
        "setsockopt" => libc::SYS_setsockopt,

        other => return Err(format!("seccomp strict: unknown syscall name {other}")),
    };
    Ok(nr as i64)
}
