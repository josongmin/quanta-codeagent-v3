//! `linux-sandbox-native` — napi-rs binding for quanta's in-process Linux
//! Landlock + seccomp OS sandbox (ADR-0175 scaffold, ADR-0184 Phase 3.1
//! real impl, ADR-0191 Phase 3.2 strict seccomp + rlimit/alarm caps).
//!
//! ## Layout
//!
//! Two `#[napi]` entry points (the contract for the TypeScript adapter in
//! `src/runtime/os-sandbox/landlock-native.ts`):
//!
//!   - `spawn_sandboxed(spec, policy) -> NapiSpawnResult`
//!   - `availability() -> String` (JSON envelope)
//!
//! Three `#[napi(object)]` value types matching the TS `SandboxPolicy` /
//! `SandboxedSpawnSpec` / `SandboxedSpawnResult` types. napi-rs converts
//! snake_case Rust ↔ camelCase JS automatically.
//!
//! ## Platform gating
//!
//! `landlock` + `seccompiler` are Linux-only crates (Cargo.toml gates them
//! by `cfg(target_os = "linux")`). The real spawn / restrict logic lives
//! in `policy` + `seccomp` modules that are themselves
//! `#![cfg(target_os = "linux")]`. On non-Linux hosts the napi exports
//! still compile but return typed "unavailable" results — this is the
//! IDE-friendly path (rust-analyzer on macOS doesn't choke) and also
//! exactly what we want at runtime if the per-triple npm artifact is
//! installed on a non-Linux host by mistake.
//!
//! ## Codex parity
//!
//! The fork-exec → child applies seccomp → landlock `restrict_self()` →
//! `execve()` pipeline is byte-identical to Codex `codex-linux-sandbox`.
//! Seccomp is applied BEFORE landlock because landlock leaves the syscall
//! table intact while seccomp can fail-fast on namespace-escape attempts
//! before the landlock fence even loads.

use napi_derive::napi;
use std::collections::HashMap;

#[cfg(target_os = "linux")]
pub mod policy;
#[cfg(target_os = "linux")]
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
    /// Seccomp mode: `"strict"` (default — Phase 3.2 default-deny + per-
    /// syscall-family allowlist) or `"lax"` (Phase 3.1 wire — allow-all,
    /// diagnostic / debug only). When `None`, the child applies strict.
    pub seccomp_mode: Option<String>,
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

/// Plain-Rust mirror of `NapiSandboxPolicy` that is `Clone + Send + 'static`.
///
/// `#[napi(object)]` doesn't derive `Clone`; `Command::pre_exec` requires
/// the closure (and its captures) to be `Send + 'static`. We snapshot the
/// napi struct into this local mirror at the top of `spawn_sandboxed` and
/// pass it into the pre_exec closure.
#[cfg(target_os = "linux")]
#[derive(Clone)]
struct LocalPolicy {
    profile: String,
    workspace: String,
    extra_read_paths: Vec<String>,
    extra_write_paths: Vec<String>,
    allow_network: Option<bool>,
    /// Memory cap (MB). When `Some`, enforced via `RLIMIT_AS + RLIMIT_DATA`
    /// in `pre_exec` BEFORE landlock + seccomp apply.
    memory_mb: Option<u32>,
    /// Wall-clock cap (ms). When `Some`, enforced via `RLIMIT_CPU` (CPU
    /// seconds hard cap → SIGKILL on excess) plus `alarm(secs)` as a
    /// wall-clock backstop.
    timeout_ms: Option<u32>,
    /// Seccomp mode. Defaults to `"strict"` when the napi field is `None`.
    /// `"lax"` is the Phase 3.1 diagnostic path.
    seccomp_mode: String,
}

#[cfg(target_os = "linux")]
impl LocalPolicy {
    fn from_napi(p: &NapiSandboxPolicy) -> Self {
        Self {
            profile: p.profile.clone(),
            workspace: p.workspace.clone(),
            extra_read_paths: p.extra_read_paths.clone(),
            extra_write_paths: p.extra_write_paths.clone(),
            allow_network: p.allow_network,
            memory_mb: p.memory_mb,
            timeout_ms: p.timeout_ms,
            seccomp_mode: p
                .seccomp_mode
                .as_deref()
                .map(str::to_string)
                .unwrap_or_else(|| String::from("strict")),
        }
    }

    /// Re-hydrate a `NapiSandboxPolicy` view for `policy::compile_ruleset`,
    /// which expects the napi shape. Cheap — only shared by the child's
    /// `pre_exec` once per spawn.
    fn as_napi(&self) -> NapiSandboxPolicy {
        NapiSandboxPolicy {
            profile: self.profile.clone(),
            workspace: self.workspace.clone(),
            extra_read_paths: self.extra_read_paths.clone(),
            extra_write_paths: self.extra_write_paths.clone(),
            allow_network: self.allow_network,
            timeout_ms: self.timeout_ms,
            memory_mb: self.memory_mb,
            seccomp_mode: Some(self.seccomp_mode.clone()),
        }
    }
}

/// Spawn `spec.command` inside a Landlock + seccomp fence compiled from
/// `policy`.
///
/// Pipeline (matches Codex `codex-linux-sandbox`):
///
///   1. Validate inputs (non-empty argv, supported profile).
///   2. `Command::new(argv[0]).args(argv[1..]).current_dir(cwd).env(...)`.
///   3. Install a `pre_exec` hook that, in the **child** after fork but
///      BEFORE `execve()`:
///         a. Applies the seccomp filter (lax in Phase 3.1; see seccomp.rs
///            for the rationale).
///         b. Compiles + applies the landlock ruleset.
///   4. `Command::output()` runs the child, captures stdout/stderr, waits.
///
/// Cancellation: the TS adapter does not pass AbortSignal here (napi
/// boundary). The adapter manages cancellation by killing the child via
/// the OS PID it gets back through the spawn handle. In this synchronous
/// `Command::output()` path the cancellation is therefore the host
/// process's responsibility (`kill(pid, SIGTERM)`); a future async napi
/// surface can expose the PID directly.
#[napi]
#[cfg(target_os = "linux")]
pub fn spawn_sandboxed(
    spec: NapiSandboxedSpawnSpec,
    policy: NapiSandboxPolicy,
) -> napi::Result<NapiSpawnResult> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // Validate argv first — empty argv is a TS-adapter bug; surface a
    // typed result rather than letting `Command::new("")` panic.
    if spec.command.is_empty() {
        return Ok(NapiSpawnResult {
            exit_code: 127,
            stdout: String::new(),
            stderr: String::from("spawn_sandboxed: empty command vector"),
            sandbox_applied: false,
            degrade_reason: Some(String::from("empty-command")),
        });
    }

    // Snapshot policy for the move into pre_exec.
    let local_policy = LocalPolicy::from_napi(&policy);

    let mut cmd = Command::new(&spec.command[0]);
    if spec.command.len() > 1 {
        cmd.args(&spec.command[1..]);
    }
    cmd.current_dir(&spec.cwd);
    if let Some(env) = &spec.env {
        cmd.env_clear();
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // SAFETY: `pre_exec` runs after `fork()` returns 0 (child) but before
    // `execve()`. The closure runs in a single-threaded address space
    // (only the calling thread survives the fork) so no synchronization
    // primitives are required. We avoid allocator pressure here — the
    // closure does small `String` work via the typed error path but no
    // heavy allocation. landlock and seccomp APIs are async-signal-safe in
    // their hot path (they ultimately call `syscall(...)` directly).
    //
    // Pipeline (Phase 3.2):
    //   1. rlimit + alarm (memory + CPU + wall-clock backstop) — set FIRST
    //      so even seccomp/landlock-apply failure paths still inherit the
    //      caps. setrlimit / alarm are async-signal-safe.
    //   2. seccomp (strict by default, lax for opt-in diagnostic) — second
    //      so landlock-apply syscalls aren't already filtered.
    //   3. landlock `restrict_self()` — third; landlock leaves the syscall
    //      table intact, so seccomp goes first per Codex parity.
    unsafe {
        cmd.pre_exec(move || {
            // 1) rlimit + alarm caps. SAFETY: libc::setrlimit / libc::alarm
            // are async-signal-safe per POSIX. We ignore the return code
            // when the cap is None; non-zero failure on a set call is
            // surfaced as a typed io::Error so the child fails before
            // execve().
            if let Some(mb) = local_policy.memory_mb {
                let bytes: u64 = (mb as u64).saturating_mul(1024 * 1024);
                let lim = libc::rlimit {
                    rlim_cur: bytes as libc::rlim_t,
                    rlim_max: bytes as libc::rlim_t,
                };
                // RLIMIT_AS — virtual address space cap. Tightest control
                // available without cgroups.
                if libc::setrlimit(libc::RLIMIT_AS, &lim) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // RLIMIT_DATA — data segment cap. Defense in depth against
                // brk() / sbrk() allocations that bypass RLIMIT_AS on some
                // kernel configs.
                if libc::setrlimit(libc::RLIMIT_DATA, &lim) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            if let Some(ms) = local_policy.timeout_ms {
                // ms → seconds (saturating). Sub-second timeouts collapse
                // to 1s because RLIMIT_CPU + alarm() are both
                // second-resolution APIs. ms < 1000 → secs=1.
                let secs: u64 = ((ms as u64) / 1000).max(1);
                let lim = libc::rlimit {
                    rlim_cur: secs as libc::rlim_t,
                    rlim_max: secs as libc::rlim_t,
                };
                // RLIMIT_CPU — CPU seconds hard cap (kernel sends SIGKILL
                // on excess).
                if libc::setrlimit(libc::RLIMIT_CPU, &lim) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // alarm(secs) — wall-clock backstop. The child receives
                // SIGALRM on timeout. RLIMIT_CPU only fires on CPU-bound
                // workloads; alarm covers the I/O-blocked case.
                // alarm() returns previous remaining seconds — we discard.
                let secs_u32 = if secs > u32::MAX as u64 {
                    u32::MAX
                } else {
                    secs as u32
                };
                libc::alarm(secs_u32);
            }

            // 2) Seccomp — branch on policy.seccomp_mode. Both error paths
            // convert to `io::Error` so the child fails before `execve()`
            // and the parent sees a typed spawn failure.
            match local_policy.seccomp_mode.as_str() {
                "lax" => {
                    // Phase 3.1 diagnostic path — preserved as opt-in.
                    seccomp::build_and_apply_seccomp().map_err(std::io::Error::other)?;
                }
                // "strict" | unknown → strict (defense in depth: unknown
                // mode collapses to the safer side).
                _ => {
                    seccomp::build_and_apply_strict_seccomp(&local_policy.profile)
                        .map_err(std::io::Error::other)?;
                }
            }

            // 3) Re-hydrate napi shape inside the child and compile fresh —
            // landlock file descriptors must be opened in the child's
            // address space.
            let napi_view = local_policy.as_napi();
            let ruleset = policy::compile_ruleset(&napi_view).map_err(std::io::Error::other)?;
            policy::apply_ruleset(ruleset).map_err(std::io::Error::other)?;
            Ok(())
        });
    }

    match cmd.output() {
        Ok(output) => Ok(NapiSpawnResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            sandbox_applied: true,
            degrade_reason: None,
        }),
        Err(e) => Ok(NapiSpawnResult {
            exit_code: 127,
            stdout: String::new(),
            stderr: format!("spawn_sandboxed: {e}"),
            sandbox_applied: false,
            degrade_reason: Some(String::from("spawn-failed")),
        }),
    }
}

/// Non-Linux fallback: emit a typed "unavailable" result so the per-triple
/// npm artifact, if accidentally installed on darwin / windows, still
/// composes with the TS fallback chain. `default.ts` Linux branch is the
/// only production caller; this exists for IDE compile only.
#[napi]
#[cfg(not(target_os = "linux"))]
pub fn spawn_sandboxed(
    _spec: NapiSandboxedSpawnSpec,
    _policy: NapiSandboxPolicy,
) -> napi::Result<NapiSpawnResult> {
    Ok(NapiSpawnResult {
        exit_code: 127,
        stdout: String::new(),
        stderr: String::from("linux-sandbox-native: not supported on this platform"),
        sandbox_applied: false,
        degrade_reason: Some(String::from("platform-unsupported")),
    })
}

/// Probe kernel + ABI support for Landlock. Returns a JSON string the TS
/// adapter parses (avoids declaring a second `#[napi(object)]` purely for
/// availability).
///
/// Shape:
///   `{ "available": bool, "kernelVersion": string, "abiSupported": number, "reason"?: string }`
///
/// Linux path: probes ABI via `policy::probe_abi()` (builds a trivial
/// ruleset and inspects negotiation) and reads `/proc/sys/kernel/osrelease`
/// for the kernel version string. Errors at any step degrade to
/// `available: false` with a typed reason — the TS adapter never sees an
/// exception.
#[napi]
#[cfg(target_os = "linux")]
pub fn availability() -> napi::Result<String> {
    let abi = policy::probe_abi();
    let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .unwrap_or_default()
        .trim()
        .to_string();
    let json = if abi > 0 {
        format!(
            r#"{{"available":true,"kernelVersion":"{}","abiSupported":{}}}"#,
            escape_json(&kernel),
            abi
        )
    } else {
        format!(
            r#"{{"available":false,"kernelVersion":"{}","abiSupported":0,"reason":"landlock-abi-zero"}}"#,
            escape_json(&kernel)
        )
    };
    Ok(json)
}

/// Non-Linux availability: always `available: false` with a typed reason.
#[napi]
#[cfg(not(target_os = "linux"))]
pub fn availability() -> napi::Result<String> {
    Ok(String::from(
        r#"{"available":false,"kernelVersion":"","abiSupported":0,"reason":"platform-unsupported"}"#,
    ))
}

/// Minimal JSON string escaper for the availability envelope. We don't
/// pull a JSON crate just for this — kernel version strings only contain
/// ASCII alnum + `.`/`-`/`_` in practice, but defensively escape `"` and
/// `\` to keep the envelope parseable.
#[cfg(target_os = "linux")]
fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' | '\t' => {}
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}
