# ADR-0175: Linux sandbox Phase 3 — native Landlock + seccomp via napi-rs scaffold

- **상태**: Accepted (scaffold + TS adapter; full Rust impl deferred to Phase 3.1)
- **날짜**: 2026-05-25
- **관련**: ADR-0136 (OS-sandbox helper Phase 1), ADR-0150 (Linux Phase 2 — bubblewrap shell-out), ADR-0159 (Linux Phase 2.5 — landlock-cli fallback), ADR-0006 (runtime 샌드박스 추상화)
- **SOTA 출처**: Codex `codex-linux-sandbox` (in-process landlock + seccomp crate; 본 ADR 의 직접 모델), Cursor `cursorsandbox` (별도 Rust 바이너리 + bwrap, 우리는 in-process napi 선택 — 알트네이티브 §참고)
- **참조**: `src/runtime/os-sandbox/{landlock-native,default,index}.ts`, `tests/unit/os-sandbox-landlock-native-hellgate.test.ts`, `crates/linux-sandbox-native/**`

## 맥락

ADR-0150 (Phase 2, bubblewrap shell-out) 와 ADR-0159 (Phase 2.5, landlock-cli 후방) 까지 Linux 사용자는 user-space 시스템 바이너리 두 종류에 의존해야 했다. 두 옵션 모두 **외부 binary 설치 필요** — `apt install bubblewrap` 또는 `landlock-cli` 빌드. 일부 minimal Linux 환경 (Alpine on Docker, immutable distros, CI runners) 에서는 둘 다 부재하여 `sandboxApplied: false` + `degradeReason: "linux-bwrap-missing"` 으로 강등이 빈번하다.

Phase 3 옵션 매트릭스:

| 옵션 | 효과 | 구현 비용 | 사용자 부담 |
|---|---|---|---|
| **napi-rs Landlock+seccomp in-process** | kernel LSM + BPF syscall fence; 외부 바이너리 0 | N주 Rust + 4-triple matrix build CI | npm install 시 native binary 자동 (optionalDep) |
| Bun.dlopen FFI | Bun 전용; experimental flag 표기 | 짧음 | Bun 외 런타임 불가 |
| libseccomp-rs (C bind) | seccompiler 와 동일 효과 | C 의존성 추가 | apt install libseccomp-dev |
| `crates/` 항상 빌드 | 단일 cargo build | Linux 외 환경에서 install 실패 | mac/win 개발자 install 망가짐 |
| in-process syscall (no fork) | landlock+seccomp 적용 | 짧음 | sandbox 가 호스트 프로세스 자체에 적용 → harness 깨짐 |

**napi-rs 채택**. 이유:
1. Codex 가 동일 패턴 (in-process landlock crate) 으로 운영 검증 (codex-rs 0.131.0-alpha.9).
2. N-API ABI 가 안정 — Bun.dlopen 의 experimental 마커 회피.
3. seccompiler 가 pure-Rust — libseccomp-rs 의 C 의존성 회피, 우리 zero-C-dep posture 와 합치.
4. `optionalDependencies` 로 4-triple npm 패키지 — Linux 외 host install 무영향 (cross-platform monorepo 의 install 마찰 제거).
5. fork-exec child-process 격리 — landlock+seccomp lifecycle 이 호스트 프로세스를 잠그지 않도록.

## 결정

`src/runtime/os-sandbox/` + `crates/linux-sandbox-native/` 안에서만 (다른 슬라이스 미수정):

### 1. `crates/linux-sandbox-native/` (신규) — napi-rs 크레이트 스캐폴드

```
crates/linux-sandbox-native/
  Cargo.toml         — napi v2 / napi-derive v2 / landlock 0.4 / seccompiler 0.5 (Linux-gated)
  build.rs           — napi-build symbol generation
  src/
    lib.rs           — #[napi] spawn_sandboxed / availability + 3 #[napi(object)] types
    policy.rs        — typed policy → landlock Ruleset (scaffold: unimplemented!())
    seccomp.rs       — seccompiler filter compile (scaffold: unimplemented!())
  npm/
    linux-x64-gnu/package.json     — per-triple npm publish target (stub)
    linux-x64-musl/package.json
    linux-arm64-gnu/package.json
    linux-arm64-musl/package.json
  package.json       — @quanta/linux-sandbox-native (optionalDeps 4-triple)
  README.md
```

API surface (final — Phase 3.1 impl 의 contract):
- `spawn_sandboxed(spec: NapiSandboxedSpawnSpec, policy: NapiSandboxPolicy) -> NapiSpawnResult`
- `availability() -> String` (JSON `{ available, kernelVersion, abiSupported, reason? }`)

`landlock` + `seccompiler` 의존성은 `target.'cfg(target_os = "linux")'.dependencies` 게이트 — seccompiler 0.5 가 darwin 에서 `libc::c_long` width mismatch 로 빌드 안 됨 (Linux 전용 crate). darwin 개발자 머신에서도 `cargo check` 통과해야 IDE 통합 깨지지 않음.

함수 본문은 `todo!()` / `unimplemented!()` / 타입화된 "native-impl-pending" 반환 — TS 어댑터 의 fallback chain 이 이를 보고 Phase 2 로 빠지므로 scaffold 만으로도 안전하게 ship 가능.

### 2. `landlock-native.ts` (신규) — TS 어댑터

```ts
nativeLandlockOsSandbox(cfg?: NativeLandlockConfig): OsSandbox
detectNativeLandlock(cfg?: NativeLandlockConfig): Promise<{ abi: number; kernelVersion: string } | null>
mapPolicyToNapi(policy: SandboxPolicy, workspace: string): NapiSandboxPolicy  // 단위 테스트 visibility
```

`OsSandbox` 포트 구현:
- `binding === null` (package 미설치) → 모든 spawn 이 degraded passthrough + `degradeReason: "native-binding-unavailable"`.
- binding throws → wrap to `OsSandboxError` 아닌 typed result + `degradeReason: "native-binding-threw"` (no-throw 계약 준수).
- `off` / `danger-full-access` → passthrough (Phase 2 와 parity).

Closed-port DI seam: `cfg.binding` (직접 fake 주입) 또는 `cfg.bindingLoader` (loader 가 null 반환 = "미설치" 시뮬레이션). 프로덕션 경로는 `dynamicLoadBinding()` 가 `await import("@quanta/linux-sandbox-native")` lazily — package 가 node_modules 에 없으면 catch + null. `@ts-expect-error` 마커는 optional dep 의 typedness 누락을 명시.

`SandboxPolicy` → `NapiSandboxPolicy` 매핑:
- `profile` 직역 (closed enum 그대로).
- `extraReadPaths` / `extraWritePaths` 는 absent 시 `[]` 로 default (napi v2 의 `Option<Vec<_>>` rough edge 회피).
- `allowNetwork` / `timeoutMs` 는 absent 시 napi 객체에서 omit (exactOptional 엄격).
- `signal` 은 napi 경계 못 넘어감 → adapter 에서 local 으로 child PID 죽임 (Phase 3.1 wire).

### 3. `default.ts` Linux 분기 갱신 — Fallback chain

```
Linux:
  1. nativeLandlockOsSandbox     (detectNativeLandlock !== null)
  2. spawnViaBubblewrap          (ADR-0150 — bwrap on PATH)
  3. degraded passthrough        ("linux-bwrap-missing")
```

`defaultOsSandbox(cfg)` 의 cfg 타입을 `OsSandboxConfig` → `NativeLandlockConfig` 로 widening — `NativeLandlockConfig extends OsSandboxConfig` 이므로 backward-compatible. 기존 호출자는 변경 없이 동작.

### 4. `index.ts` barrel — 재익스포트

Phase 3 신규 심볼:
- `nativeLandlockOsSandbox`, `detectNativeLandlock`, `mapPolicyToNapi`
- 타입: `NapiSandboxPolicy`, `NapiSandboxedSpawnSpec`, `NapiSpawnResult`, `NativeLandlockBinding`, `NativeLandlockConfig`

또한 ADR-0159 시점에 누락됐던 `linux.ts` / `landlock-cli.ts` 의 심볼들도 같은 라운드에서 정리 (`linuxOsSandbox`, `detectLinuxSandboxBackend`, `compileLinuxSandboxArgv`, `LinuxSandboxBackend`, `compileLandlockCliArgs`, `LANDLOCK_CLI_NETWORK_DEFERRED_MARKER`) — 기존 테스트가 barrel 을 통해 import 하던 심볼이 없으면 typecheck 깨짐 (re-export 안 했을 뿐 산업적 break 는 아니나, 동시 라운드에서 fix).

## Phase 3.1 deferral

이 라운드는 **scaffold + TS adapter + 테스트** 까지. 다음 라운드 (Phase 3.1) 에서:

1. **Rust impl 본체**:
   - `policy.rs::compile_ruleset()` — `landlock::ABI::new_current()` + `PathBeneath::new(ABI).access(...)` walk; ABI ≥ 4 시 network rule.
   - `seccomp.rs::build_filter()` — `seccompiler::SeccompFilter` 의 `Allow` default + per-syscall `Errno(EACCES/EPERM)` 테이블.
   - `lib.rs::spawn_sandboxed()` — `fork()` → child: apply landlock + seccomp + `execve()`; parent: `wait()` + pipe drain.
2. **GitHub Actions matrix CI** — 4-triple cross-build (`x86_64-unknown-linux-gnu` / `-musl` + `aarch64` 동) via `actions-rs/cross` 또는 `napi-rs/cli`.
3. **npm publish** — `napi prepublish -t npm` per triple → 4 per-platform packages + main package.
4. **cap enforcement** — `timeoutMs` (`alarm(2)`) / `memoryMb` (`setrlimit(RLIMIT_AS)`) in child.
5. **MCP per-server policy DSL** wiring.

## Hellgate

`tests/unit/os-sandbox-landlock-native-hellgate.test.ts` — 20 cases / 47 expects / 0 fail.

DI seam shape: fake `NativeLandlockBinding` (`{ spawn_sandboxed(spec, policy) -> NapiSpawnResult, availability() -> string }`) via `cfg.binding` (직접) 또는 `cfg.bindingLoader` (lazy import 시뮬레이션). 모든 테스트는 darwin host 에서 실행 가능 — 실제 `@quanta/linux-sandbox-native` 로드 안 함.

Clusters:
- **A. detectNativeLandlock probe (4)**: 미설치 → null / 정상 → {abi,kernel} / kernel 너무 낮음 → null / availability throws → null.
- **B. nativeLandlockOsSandbox.spawn (8)**: profile=off → passthrough / binding 정상 호출 / binding throws → wrapped + `native-binding-threw` / AbortSignal preserve / extraReadPaths flow / allowNetwork override / result mapping 5-field / `degradeReason` omitted when absent.
- **C. fallback chain (4)**: native 로드 → native 사용 / native 실패 → bwrap fallback (argv[0]==="bwrap") / 둘 다 실패 → degraded with `linux-bwrap-missing` / darwin → Seatbelt 분기 (native binding 무시).
- **D. mapPolicyToNapi (4)**: extraReadPaths preserved + defensive copy / timeoutMs propagate / profile verbatim / absent fields omitted (exactOptional).

회귀: `os-sandbox-hellgate` (35) + `os-sandbox-linux-hellgate` (21) + `os-sandbox-bubblewrap-hellgate` 합산 76 pass / 0 fail.

## Default-OFF

Package `@quanta/linux-sandbox-native` 는 **현재 npm 에 publish 안 됨** (Phase 3.1 작업). 따라서:
- 모든 host (Linux 포함) 에서 `dynamicLoadBinding()` 가 null 반환 → `detectNativeLandlock()` 가 null → `default.ts` 의 Linux 분기가 Phase 2 (bwrap) 로 byte-identical fallthrough.
- 즉, 이 ADR 의 main-merge 자체는 **런타임 동작 영향 0**. 어떤 사용자도 sandbox 동작 변화를 느끼지 않음.
- Phase 3.1 에서 npm publish 후에야 Linux 사용자가 native tier 사용 시작.

## Alternatives rejected

- **Bun.dlopen FFI** — Bun docs experimental 마커; napi-rs N-API ABI 안정. 또한 Bun 외 런타임 (Node) 호환성 필요.
- **libseccomp-rs (C dep)** — seccompiler pure-Rust 와 동일 효과; zero-C-dep posture 유지.
- **단일 `crates/` workspace member always-builds** — Linux-only 의존성을 cross-platform monorepo 의 `npm install` 매번 빌드 시도 → mac/win 개발자 install 깨짐. `optionalDependencies` 4-triple 별도 npm package 가 산업 표준.
- **In-process syscall (no fork)** — landlock+seccomp 는 한번 적용 후 해제 불가 (seccomp PR_SET_NO_NEW_PRIVS sticky). 호스트 프로세스에 직접 적용하면 harness 후속 작업 모두 fence 내부로. fork-exec child 격리가 산업 패턴.

## SOTA matrix

| Agent | Linux sandbox 구현 |
|---|---|
| Cursor `cursorsandbox` | bwrap + landlock + seccomp (별도 Rust 바이너리 - 외부 dep) |
| Codex `codex-linux-sandbox` | landlock + seccomp (in-process Rust crate, 본 ADR 의 직접 모델) |
| Claude Code | (없음 — Linux sandbox 부재) |
| **quanta (Phase 2 — ADR-0150/0159)** | external bwrap / landlock-cli shell-out |
| **quanta (Phase 3 scaffold — 본 ADR)** | napi-rs binding 준비 완료; CI + Rust impl Phase 3.1 |

## Follow-up

- **Phase 3.1 ops**: Rust impl 본체 + GitHub Actions 4-triple matrix + npm publish + cap enforcement (memory/timeout).
- **Phase 3.2**: per-MCP server policy DSL wiring (각 MCP 서버가 자기만의 `SandboxPolicy` 선언).
- **Phase 3.3**: kernel ABI drift 대응 — Landlock ABI v5/v6/v7 신규 access rights 매핑 테이블.
