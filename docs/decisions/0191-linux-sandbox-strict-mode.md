# ADR-0191: Linux sandbox strict mode (Phase 3.2 — strict seccomp + rlimit/alarm caps)

- **상태**: Accepted (Phase 3.2 — strict default-deny seccomp filter + rlimit/alarm cap wire; CI matrix + npm publish 별도 ADR — Phase 3.3 deferred)
- **날짜**: 2026-05-25
- **관련**: ADR-0136 (OS sandbox helper foundation — `SandboxPolicy.memoryMb` / `timeoutMs` 필드 정의), ADR-0159 (Linux Phase 2 external-binary wrapper — fallback), ADR-0175 (Phase 3 scaffold), ADR-0184 (Phase 3.1 — lax-mode seccomp + landlock + pre_exec wire)
- **참조**: `crates/linux-sandbox-native/{Cargo.toml, src/{lib,seccomp}.rs}`, `src/runtime/os-sandbox/{landlock-native,types}.ts`, `tests/unit/os-sandbox-strict-seccomp-hellgate.test.ts`

## 맥락

ADR-0184 (Phase 3.1) ships Rust 진짜 impl + lax-mode seccomp + landlock + pre_exec. lax seccomp = empty rule table + `Allow` default = 모든 syscall 통과 (단, `apply_filter` side-effect로 `PR_SET_NO_NEW_PRIVS=1`만 설정). landlock이 FS/network 경계는 enforce하지만 namespace escape (`unshare`/`clone3`/`ptrace`)는 syscall-level deny가 필요.

ADR-0184 follow-up 5개 중:
- ✅ **Strict seccomp filter** (이번 ADR)
- ✅ **rlimit / alarm wire** — `policy.memoryMb` / `timeoutMs` 실제 enforce (이번 ADR)
- ❌ GitHub Actions 4-triple matrix CI (Phase 3.3)
- ❌ npm publish per-platform packages (Phase 3.3)
- ❌ Real ABI probe via `/sys/kernel/security/landlock` (Phase 3.3)

SOTA: Codex `codex-linux-sandbox` strict mode = `default_action: KillProcess` + per-syscall-family allowlist (~80 syscalls). 우리도 동일 패턴, 4 profile 게이트로 카테고리 토글.

## 결정

### Part 1 — Strict seccomp 카테고리 분류 (`crates/linux-sandbox-native/src/seccomp.rs`)

신규 entry-point `build_and_apply_strict_seccomp(profile: &str) -> Result<(), String>`. `seccompiler::SeccompFilter::new(rules, default_action: KillProcess, mismatch_action: Allow, target)` — 매치된 syscall만 통과, 나머지는 `SIGSYS`로 child 즉시 종료.

**카테고리 (10개)**:

| Category | Profile gate | Syscalls |
|---|---|---|
| I/O essentials | always | `read, write, close, openat, fstat, statx, lseek, fcntl, dup, dup2, dup3, pipe2, ioctl` |
| Memory mgmt | always | `mmap, mprotect, munmap, brk, madvise` |
| Process basics | always | `exit, exit_group, getpid, gettid, getuid, geteuid, getgid, getegid, getrlimit, prlimit64, arch_prctl` |
| Signals | always | `rt_sigaction, rt_sigprocmask, rt_sigreturn, kill, tgkill, sigaltstack` |
| FS read | always | `readlinkat, getdents64, faccessat2, name_to_handle_at` |
| FS write | `workspace-write{,-net}` | `writev, pwrite64, ftruncate, fsync, fdatasync, mkdirat, unlinkat, renameat2, linkat, symlinkat` |
| Process spawn | always | `execve, execveat` (landlock이 path를 gate) |
| Time | always | `clock_gettime, clock_nanosleep, nanosleep` |
| Network | `workspace-write-net` only | `socket, connect, sendto, recvfrom, sendmsg, recvmsg, accept4, bind, listen, getsockopt, setsockopt` |
| **DENY (explicit)** | all profiles → `KillProcess` | `clone3, unshare, setns, mount, umount2, pivot_root, chroot, ptrace, process_vm_readv, process_vm_writev, bpf, init_module, finit_module, delete_module, kexec_load` |

`resolve_syscall_nr(name, target)` = libc `SYS_*` 상수 매칭. unknown name → typed error (drift catch). x86_64 / aarch64 arch-specific 분기 (`dup2`/`arch_prctl` aarch64에서 다른 nr). 모든 entry는 `Vec<SeccompRule>::new()` (empty arg-condition = 무조건 allow); arg-narrowing (ioctl → TIOCGWINSZ만) 은 Phase 3.4 tightening.

### Part 2 — rlimit + alarm wire (`crates/linux-sandbox-native/src/lib.rs::spawn_sandboxed` pre_exec)

`NapiSandboxPolicy.memory_mb` / `timeout_ms` 가 실제 enforce 되도록 pre_exec block 맨 앞에 cap 설정. **순서**: rlimit/alarm 먼저 → seccomp → landlock. seccomp + landlock-apply 자체가 syscall이라 rlimit를 cap 되기 *전*에 설정해야 안전.

```rust
if let Some(mb) = local_policy.memory_mb {
    let bytes = (mb as u64).saturating_mul(1024 * 1024);
    let lim = libc::rlimit { rlim_cur: bytes, rlim_max: bytes };
    libc::setrlimit(libc::RLIMIT_AS, &lim);   // virtual address space
    libc::setrlimit(libc::RLIMIT_DATA, &lim); // data segment (brk/sbrk defense)
}
if let Some(ms) = local_policy.timeout_ms {
    let secs = ((ms as u64) / 1000).max(1);   // sub-second → 1s collapse
    libc::setrlimit(libc::RLIMIT_CPU, &lim);  // CPU sec hard cap → SIGKILL
    libc::alarm(secs as u32);                 // wall-clock backstop → SIGALRM
}
```

**RLIMIT_AS + RLIMIT_DATA 둘 다**: 일부 커널 config에서 `brk()`/`sbrk()`가 RLIMIT_AS 우회. RLIMIT_DATA가 defense-in-depth.

**RLIMIT_CPU + alarm() 둘 다**: RLIMIT_CPU는 CPU-bound workload만 fire (I/O-blocked process는 통과). alarm은 wall-clock backstop. Codex pattern verbatim.

Cargo: `[target.'cfg(target_os = "linux")'.dependencies] libc = "0.2"` 추가. libc는 standard, nix 같은 wrapper crate 불필요 (4개 syscall만 호출).

### Part 3 — Phase 3.1 lax mode preserved as opt-out

`build_and_apply_seccomp()` (lax) 함수는 그대로 유지 + module-header 주석에 "diagnostic / debug only; production calls `build_and_apply_strict_seccomp`" 명시. `NapiSandboxPolicy.seccomp_mode: Option<String>` 추가, `lib.rs` pre_exec block에서 분기:

```rust
match local_policy.seccomp_mode.as_str() {
    "lax" => seccomp::build_and_apply_seccomp()?,
    _ => seccomp::build_and_apply_strict_seccomp(&local_policy.profile)?,
}
```

Default (`None` 또는 unknown 문자열) → strict. "unknown → strict" 의도적 (defense in depth: TS adapter bug로 잘못된 값이 와도 안전한 쪽).

### Part 4 — TS pass-through

`src/runtime/os-sandbox/types.ts` `SandboxPolicy`:
```ts
readonly memoryMb?: number    // 신규
readonly seccompMode?: "lax" | "strict"  // 신규
```

`src/runtime/os-sandbox/landlock-native.ts`:
- `NapiSandboxPolicy` 타입에 `seccompMode?: "lax" | "strict"` 추가
- `mapPolicyToNapi`: `memoryMb` exactOptional spread + `seccompMode ?? "strict"` 명시적 default

명시적 default (Rust side도 default 가지는데 TS에서 한번 더): wire에 explicit 값을 박아 (a) test assertion이 항상 `expect(napi.seccompMode).toBe("strict")` 처럼 단언 가능 (b) 진단 시 "어느 mode가 실제로 binding에 갔는가" 명확.

## Hellgate

신규: `tests/unit/os-sandbox-strict-seccomp-hellgate.test.ts` 12 cases:

1. `policy.seccompMode` absent → 바인딩 "strict" 수신
2. explicit "lax" forwarded
3. explicit "strict" + workspace-write forwarded
4. policy literal에 seccompMode 키 없음 → "strict"
5. `memoryMb` set → forwarded
6. `timeoutMs` set → forwarded
7. 두 필드 absent → 바인딩이 키 자체를 못 받음 (exactOptional)
8. `memoryMb` + `workspace-write` + `extraReadPaths` 조합
9. `mapPolicyToNapi`가 `profile=off` 에도 `seccompMode` 방출 (mapping 순수성)
10. Phase 3.1 type re-export 신성성 (sanity)
11. `bindingLoader=null` → degraded passthrough; `seccompMode` 참조 안 됨
12. conditional spread로 `seccompMode === undefined` → "strict" 기본

기존: 20-case Phase 3.1 hellgate (`os-sandbox-landlock-native-hellgate.test.ts`) + 22-case `os-sandbox-linux-hellgate.test.ts` 모두 green 유지 (signature breakage 0).

**합계**: 12 신규 + 20 + 22 = **54 cases / 0 fail / 125 expects**.

## Verify

```sh
$ cd crates/linux-sandbox-native && cargo build --release   # darwin host
   Compiling linux-sandbox-native v0.1.0
    Finished `release` profile [optimized] target(s) in 1.04s
$ cargo check --target x86_64-unknown-linux-gnu             # cross-validate Linux paths
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 15.11s
$ bunx tsc --noEmit                                          # slice errors
    (0 errors in src/runtime/os-sandbox/** or tests/unit/os-sandbox-strict-seccomp-hellgate.test.ts)
$ bun test tests/unit/os-sandbox-{strict-seccomp,landlock-native,linux}-hellgate.test.ts
   54 pass / 0 fail / 125 expect()
$ bunx biome check src/runtime/os-sandbox/{landlock-native,types}.ts tests/unit/os-sandbox-strict-seccomp-hellgate.test.ts
   0 errors
```

darwin build = napi binding shape 검증 + cfg-gated 모듈 skip. Linux runtime 실 enforce는 GitHub Actions matrix (Phase 3.3)에서.

## Phase 3.3 deferred

1. **GitHub Actions 4-triple matrix CI** — `[x86_64-gnu, x86_64-musl, aarch64-gnu, aarch64-musl]` cross-build via cargo-zigbuild + napi-rs CLI
2. **npm publish per-platform packages** — `@quanta/linux-sandbox-native-{linux-x64-gnu, …}` + main meta `@quanta/linux-sandbox-native` with `optionalDependencies`
3. **Real ABI probe** — `/sys/kernel/security/landlock` 파싱 (현재 empty-Ruleset 시도 휴리스틱은 부정확)
4. **Arg-narrowing** — ioctl → TIOCGWINSZ/TIOCSPGRP만, mmap → MAP_FIXED 거부 같은 per-syscall arg filter
5. **Network syscall arg-filter** — `socket(AF_UNIX)` 만 허용 같은 family-narrowing

## Alternatives rejected

1. **`KillProcess` vs `Errno(EPERM)`**: KillProcess가 더 안전 — Errno는 program이 retry loop에 빠질 수 있고, 잘못된 path로의 silent fallback 가능. SIGSYS는 명백한 termination signal로 sandbox escape 시도를 즉시 가시화.
2. **`unshare` allow + landlock-only enforce**: Codex가 deny. unshare로 fresh namespace 만들면 landlock 적용 *이전* 상태로 reset 시도 가능. 우리도 deny.
3. **libc 직접 vs nix crate**: libc만으로 4개 syscall (setrlimit×3 + alarm) 충분. nix는 wrapper 부피 큼, 추가 transitive dep. 거부.
4. **Default lax → opt-in strict**: 반대로 가야 함 — production은 strict가 기본, lax는 explicit opt-in (diagnostic). 보안 default 의 정석 (fail-closed).
5. **arg-filter at Phase 3.2**: ioctl request-num narrowing 등은 미세 튜닝 필요 + libc 호출 패턴 종단간 측정 필요. Phase 3.4로 분리.
6. **seccompMode 없이 strict 강제**: lax mode 완전 제거 시 production-only일 때 디버그 어려움 (어떤 syscall이 trip 했나 빠른 bisect 불가). opt-in 보존.

## SOTA++ 자리매김 (Phase 3.2 시점)

| Agent | Linux sandbox impl |
|---|---|
| Cursor `cursorsandbox` | ✅ bwrap + landlock + seccomp strict (separate Rust binary) |
| **Codex `codex-linux-sandbox`** | ✅ **native landlock crate + seccomp strict in-process via pre_exec + rlimit/alarm** — *우리가 이 ADR로 완전 mirror* |
| Claude Code | ❌ |
| Devin / OpenHands | partial (Docker container 격리, not in-process Landlock) |
| quanta Phase 2 (ADR-0159) | ✅ external bwrap / landlock-cli wrapper |
| quanta Phase 3.1 (ADR-0184) | ✅ native landlock + **lax** seccomp + pre_exec |
| **quanta Phase 3.2 (this ADR)** | ✅ **native landlock + STRICT seccomp + rlimit/alarm + lax opt-out — Codex 동급 in-process strict** |
| quanta Phase 3.3 (deferred) | + CI 4-triple matrix + npm publish + arg-narrowing |

= "Phase 3.1에서 wire를 박고 Phase 3.2에서 default-deny + 80-ish syscall allowlist + rlimit/alarm 실 enforce 까지 완료. Codex의 strict mode 패턴 verbatim. 우리만의 영토: profile-gated 카테고리 토글 (workspace-write에서만 FS write category enable; workspace-write-net에서만 network category enable) — Codex는 코드 path가 fixed-list, 우리는 explicit 4-profile gate."

## Follow-up

- Phase 3.3 ADR: GitHub Actions matrix + npm publish + real ABI probe
- Phase 3.4 ADR: per-syscall arg-narrowing (ioctl/mmap/socket)
- 통합: `nativeLandlockOsSandbox` 어댑터가 `policy.seccompMode` 진단 정보 + landlock ABI 버전을 `availability().warnings`에 노출
- Sub-MCP per-server policy DSL — 정책별 강도 차이 (이전 ADR-0184 follow-up과 동일)
