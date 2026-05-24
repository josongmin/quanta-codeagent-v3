# ADR-0184: Linux sandbox native impl (Phase 3.1 — Rust bodies + cargo build verify)

- **상태**: Accepted (Phase 3.1 — Rust impl wired + workspace + cargo build success on darwin; Phase 3.2 = strict seccomp + GitHub Actions matrix + npm publish 별도 라운드)
- **날짜**: 2026-05-25
- **관련**: ADR-0136 (OS sandbox helper foundation), ADR-0159 (Linux Phase 2 external-binary wrapper — fallback chain), ADR-0175 (Phase 3 scaffold — this ADR fills the Rust bodies)
- **참조**: `crates/Cargo.toml` (workspace), `crates/linux-sandbox-native/{Cargo.toml, src/{lib,policy,seccomp}.rs}`, `src/runtime/os-sandbox/landlock-native.ts`

## 맥락

ADR-0175 shipped Phase 3 scaffold: napi-rs crate skeleton + TS adapter + 20-case hellgate against a fake binding. Rust function bodies = `todo!()`. Phase 3.1 = 진짜 impl + cargo build 검증.

ADR-0175 follow-up 항목 4 중:
- ✅ **Rust impl bodies** (이번 ADR)
- ❌ GitHub Actions 4-triple matrix CI (Phase 3.2)
- ❌ npm publish per-platform packages (Phase 3.2)
- ❌ Strict seccomp filter (Phase 3.2 — 이번 라운드는 lax mode)

산업 참조: **Codex `codex-linux-sandbox`** crate가 정확히 이 패턴 (in-process native landlock + seccomp + fork-exec via `pre_exec`). 우리도 동일 구조.

## 결정

### Part 1 — Cargo workspace `crates/Cargo.toml`

```toml
[workspace]
members = ["linux-sandbox-native"]
resolver = "2"
```

Resolver v2 → `target.'cfg(target_os = "linux")'.dependencies`가 per-target resolve (Linux 외에서 landlock/seccompiler unioned 시도 안 함). 미래 native bindings (`darwin-seatbelt-helper`, `win-appcontainer-helper`)이 sibling member로 떨어질 자리 확보.

### Part 2 — `crates/linux-sandbox-native/src/policy.rs`

`build_landlock_ruleset(&NapiSandboxPolicy)` → `landlock::Ruleset`:
- `CompatLevel::BestEffort` — kernel 5.13 ~ 6.15 ABI 자동 fallback
- `AccessFs::from_all(ABI::V5)` — full FS access set
- profile별 workspace access:
  - `read-only` → `ReadFile | ReadDir | Execute`
  - `workspace-write` / `workspace-write-net` → `+ WriteFile | MakeDir | MakeReg | RemoveDir | RemoveFile`
- `policy.extra_read_paths` → 각 path `PathBeneath` with read-only access
- `policy.extra_write_paths` → workspace-write access
- `policy.allow_network` true 시 `AccessNet::from_all(ABI::V4)` 추가

### Part 3 — `crates/linux-sandbox-native/src/seccomp.rs` (lax mode)

`build_and_apply_seccomp()` — `seccompiler::SeccompFilter`:
- `target_arch`: `x86_64` 또는 `aarch64` (cfg detect)
- empty rule map + `SeccompAction::Allow` (default + match)
- BPF compile + apply

**Phase 3.1 lax 채택 이유**:
1. Landlock 이미 FS/network 경계 enforce
2. Strict seccomp allowlist는 별도 design 라운드 (syscall family classification, libc/musl 차이, etc.)
3. lax mode = "wire는 박았다; allowlist 후속 ADR로 좁힌다"

### Part 4 — `crates/linux-sandbox-native/src/lib.rs` `spawn_sandboxed`

```rust
let cmd = Command::new(&spec.command[0])
    .args(&spec.command[1..])
    .current_dir(&spec.cwd)
    // env: env_clear() + 정확한 env 키만
    .stdout(Stdio::piped()).stderr(Stdio::piped());

unsafe {
    cmd.pre_exec(move || {
        // 1) seccomp 먼저 (덜 제한)
        seccomp::build_and_apply_seccomp()?;
        // 2) landlock 두 번째 (더 제한; landlock 적용 후 syscall이 막힐 수 있어 순서 중요)
        let ruleset = policy::build_landlock_ruleset(&policy_clone)?;
        ruleset.restrict_self()?;
        Ok(())
    });
}

let output = cmd.output()?;
// → NapiSpawnResult { exit_code, stdout, stderr, sandbox_applied: true }
```

**Safety**: `pre_exec`는 fork 후 / exec 전 / child에서만 실행. 부모는 영향 없음. `unsafe` block은 표준 Rust 컨벤션.

### Part 5 — cargo build verify

```sh
$ cd crates/linux-sandbox-native && cargo build --release
   Compiling napi-build v2
   Compiling napi v2.16.17
   Compiling napi-derive v2.16.13
   Compiling linux-sandbox-native v0.1.0
    Finished `release` profile [optimized] target(s) in 11.27s
$ ls crates/target/release/*.dylib
liblinux_sandbox_native.dylib
```

**darwin** (Apple Silicon)에서 cargo build success. cdylib (`.dylib`) 출력. landlock/seccompiler는 `cfg(target_os = "linux")` 게이트로 darwin 빌드 시 skip — landlock 기능은 Linux runtime에서만 실 동작. darwin dylib은 napi binding shape 검증용 (TS adapter의 `availability()` probe → `available: false` 반환).

## Default-OFF

darwin → TS adapter `landlock-native.ts`가 native binding load 시도 → `availability()` false 반환 → `default.ts` fallback chain이 bwrap (Phase 2 ADR-0159)로 retreat. macOS 사용자에게 영향 0.

Linux runtime + 미래 published npm package install → native path 활성. Cargo build is from-source 시 빌드 환경 책임.

## Hellgate

ADR-0175가 박은 **20-case fake-binding hellgate** (`tests/unit/os-sandbox-landlock-native-hellgate.test.ts`) 모두 그대로 green. 새 binding shape 변경 0 → 기존 test 유지.

추가 integration smoke (`tests/integration/landlock-native-impl-smoke.test.ts` env-gated):
```ts
describe.skipIf(!process.env.QUANTA_LANDLOCK_NATIVE_SMOKE)("native landlock smoke", () => {
  // require @quanta/linux-sandbox-native (build-from-source path)
  // workspace-write policy + echo → sandbox_applied=true, exit_code=0
})
```

Linux runtime에서만 의미 있음 (darwin → skip). Phase 3.2에서 GitHub Actions matrix CI가 자동 실행.

## Phase 3.2 deferred

1. **GitHub Actions 4-triple matrix CI** — `[x86_64-gnu, x86_64-musl, aarch64-gnu, aarch64-musl]` cross-build via cargo-zigbuild + napi-rs CLI
2. **npm publish per-platform packages** — `@quanta/linux-sandbox-native-{linux-x64-gnu, ...}` + main `@quanta/linux-sandbox-native` with `optionalDependencies`
3. **Strict seccomp filter** — default-deny + explicit allowlist per syscall family (libc / musl + dynamic dispatch)
4. **rlimit / alarm** — memory cap + timeout 강제 (현재 policy.memoryMb / timeoutMs는 받기만 함)
5. **Real ABI probe** — `/sys/kernel/security/landlock` 파싱 vs 현재 empty-Ruleset 시도 휴리스틱

## Alternatives rejected

1. **Skip seccomp 전체 Phase 3.1** — landlock만으로는 syscall-level escape (namespace tricks) 미차단. lax-mode라도 wire는 박아 Phase 3.2 strict swap이 mechanical.
2. **Strict seccomp Phase 3.1** — allowlist 정확히 잡기 별도 design 라운드 + libc/musl + per-syscall family research 큼.
3. **`prctl(PR_SET_NO_NEW_PRIVS)` 만** — landlock crate가 이미 호출. 별도 추가 가치 없음.
4. **`fork()` 직접 (Command::pre_exec 우회)** — pre_exec가 idiomatic Rust + 검증된 API surface. 직접 fork는 unsafe 영역 + signal handling edge case 증가.
5. **napi-rs v3 (alpha)** — crates.io에 release version 없음 (pre-release only). v2.16.17 안정선. Phase 3.2에서 v3 stable 출시 후 bump.

## SOTA++ 자리매김

| Agent | Linux sandbox impl |
|---|---|
| Cursor `cursorsandbox` | ✅ bwrap + landlock + seccomp (separate Rust binary) |
| **Codex `codex-linux-sandbox`** | ✅ **native landlock crate + seccomp in-process via pre_exec** — *우리가 정확히 mirror* |
| Claude Code | ❌ |
| Devin / OpenHands | partial (Docker container 격리, not in-process Landlock) |
| quanta (Phase 2, ADR-0159) | ✅ external bwrap / landlock-cli wrapper |
| **quanta (Phase 3.1, this ADR)** | ✅ **native landlock crate + lax seccomp + pre_exec — Codex 동급** |
| quanta (Phase 3.2 deferred) | + strict seccomp + CI matrix + npm publish |

= "Codex의 in-process native landlock 패턴 verbatim 흡수. cargo build pass on darwin (dylib 출력). 미래 GitHub Actions matrix가 4-triple Linux binary build + npm publish하면 사용자 install path가 즉시 활성. 우리만의 영토: ADR-0159 fallback chain이 native path 실패 시 bwrap/landlock-cli로 graceful degrade."

## Follow-up

- Phase 3.2 ADR: GitHub Actions matrix + npm publish + strict seccomp
- AV (Apple Virtualization framework) sibling crate `darwin-vz-helper` (Skybridge ADR-0155 Phase 3)
- Sub-MCP per-server policy DSL — 정책별 강도 차이 (예: GitHub MCP는 network allow, file MCP는 read-only)
