# ADR-0159: Linux sandbox — 2-backend auto-detect (bubblewrap + landlock-cli)

- **상태**: Accepted (Phase 2 external-binary wrapper)
- **날짜**: 2026-05-24
- **관련**: ADR-0136 (OS-sandbox helper Phase 1 — Seatbelt + Linux stub), ADR-0150 (Linux Phase 2 bubblewrap shell-out), ADR-0093 (effect-channel — 미래 통합 지점), ADR-0006 (runtime 샌드박스 추상화), ADR-0135 (permission-sandbox 2-layer)
- **SOTA 출처**: Cursor `cursorsandbox` (Linux backend = bubblewrap + landlock+seccomp 조합 — 두 backend 모두 검출/시도), Codex `codex-linux-sandbox` (Landlock native Rust + seccomp). 본 ADR은 두 SOTA의 **auto-detect + graceful degrade** 패턴을 user-space shell-out으로 흡수.
- **참조**: `src/runtime/os-sandbox/{landlock,landlock-cli,bubblewrap,default,types,index}.ts`, `tests/unit/os-sandbox-linux-hellgate.test.ts`, `tests/unit/os-sandbox-bubblewrap-hellgate.test.ts`, `tests/unit/os-sandbox-hellgate.test.ts`

## 맥락

ADR-0150 은 Linux 백엔드를 `bwrap` 단일 셸-아웃으로 정착시켰다. 그러나 production Linux 환경 (특히 CI, container, restricted distros) 에서는 `bwrap` 가 항상 가용하지 않다:

| 환경 | `bwrap` | `landlock-cli` |
|---|---|---|
| Debian/Ubuntu desktop | ✅ apt install | partial (newer) |
| Alpine (musl) | ⚠️ 큰 의존성 | ✅ minimal |
| 잠긴 CI container | ❌ (no caps) | ✅ (kernel-only) |
| WSL2 (older kernels) | ✅ | ⚠️ kernel 6.7+ |

`bwrap` 부재 시 ADR-0150 는 `degradeReason: "linux-bwrap-missing"` 으로 정직하게 passthrough 한다. 정직하지만 **Linux 의 일부 사용자에게 sandbox 가 0** 이라는 의미였다.

`landlock-cli` 는 Linux Landlock LSM 을 wrap 하는 user-space 도구다. FS 만 격리 (no network namespace), 따라서 `bwrap` 보다 의미론적으로 약하다. 그러나 **kernel-level FS 격리 자체는 동등** — 약점은 "network deny 못 함" 한 가지로 좁혀진다. 그리고 그 약점은 **typed degradeReason 으로 가시화** 하면 honest degradation 으로 정착 가능.

## 결정

`src/runtime/os-sandbox/` 안에서 (다른 슬라이스 미수정):

### 1. `landlock-cli.ts` (신규) — Pure argv compiler

```ts
compileLandlockCliArgs(policy, workspace): string[] | null
export const LANDLOCK_CLI_NETWORK_DEFERRED_MARKER = "--network-deferred"
```

`compileBubblewrapArgs` / `compileSeatbeltProfile` 와 동일한 contract — `null` = "verbatim spawn" (`off` / `danger-full-access`). Profile → `landlock-cli` argv mapping:

- `read-only`           → `--ro-paths <system + workspace>` (workspace joins RO list)
- `workspace-write`     → `--ro-paths <system>` + `--rw-paths <workspace>`
- `workspace-write-net` → 위와 같음 (network 은 landlock 가 enforce 못함)
- `extraReadPaths`      → `--ro-paths` 에 merge
- `extraWritePaths`     → `--rw-paths` 에 merge (read-only profile 에서는 silent skip)
- **network deny 요구 + landlock-cli backend 선택** → `--network-deferred` sentinel marker emit (실 flag 아님; spawn 전 filter)

system RO paths: `["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin"]` — bwrap 의 `--ro-bind /` 의도를 명시적 list 로 풀어 씀 (landlock-cli 는 "bind /" primitive 없음). glibc + musl + 모든 주요 distro 의 libc/언어 runtime/SSL cert 읽기 cover.

### 2. `landlock.ts` (extend) — 2-backend dispatch + back-compat

```ts
type LinuxSandboxBackend = "bubblewrap" | "landlock-cli"

detectLinuxSandboxBackend(cfg): Promise<LinuxSandboxBackend | null>  // 신규
compileLinuxSandboxArgv(policy, workspace, backend): string[]        // 신규
linuxOsSandbox(cfg): OsSandbox                                       // 신규 entry point

// ADR-0150 byte-identical legacy exports 유지:
isBubblewrapAvailable / spawnViaBubblewrap / isLandlockAvailable / spawnViaLandlock
```

`detectLinuxSandboxBackend` 는 **bwrap 우선 → landlock-cli fallback** 순. `linuxOsSandbox.spawn` dispatch:

- `profile === "off" | "danger-full-access"` → passthrough, **no degradeReason** (opt-out 의도)
- `detect → null` → degraded passthrough + `degradeReason: "linux-bwrap-missing"` (legacy reason 유지 — ADR-0150 의 hellgate 와 byte-identical)
- `detect → "bubblewrap"` → `spawnViaBubblewrap` 위임 (byte-identical)
- `detect → "landlock-cli"` → `spawnViaLandlockCli` (신규) — network-deferred marker 검출 시 `degradeReason: "landlock-network-policy-not-enforced"` 부착

`compileLinuxSandboxArgv` 는 두 compiler 의 pure dispatcher — opt-out arms 는 `[]` (empty) 로 정규화 (real spawn 은 profile 직접 검사하므로 그 branch 미도달; 방어적 `[]` 가 surface 를 total 하게 유지).

### 3. `default.ts` (extend) — Linux 분기 delegation

```ts
if (platform === "linux") {
  const linux = linuxOsSandbox({ spawner, which })
  return linux.spawn(spec, policy)
}
```

`availability()` 분기도 `linuxOsSandbox({ which }).availability()` 로 위임 — detection + warnings 가 single-source. 결과:

- `bwrap` present → `backend: "bubblewrap"`, no warnings
- `landlock-cli` only → `backend: "landlock+seccomp"`, warning "landlock-cli active — bubblewrap not found ... network policy is NOT enforced"
- neither → `backend: "passthrough"`, warning "install bubblewrap (apt/dnf/pacman) or landlock-cli for sandbox — degraded to passthrough" (HELL-C16 의 `.includes("install bubblewrap")` invariant 보존)

### 4. `types.ts` — 변경 없음

ADR-0150 에서 추가된 `"landlock+seccomp"` arm 이 본 ADR 에서 **활성화**. Phase 3 native FFI 까지 placeholder 였던 arm 이 `landlock-cli` 백엔드 가용 시 실제 보고됨.

### 5. `index.ts` — Barrel 확장

신규 export: `compileLandlockCliArgs`, `LANDLOCK_CLI_NETWORK_DEFERRED_MARKER`, `compileLinuxSandboxArgv`, `detectLinuxSandboxBackend`, `linuxOsSandbox`, `type LinuxSandboxBackend`.

## 계약 (ADR-0150 4 + 본 ADR 추가 3)

1. **NO-THROW** — 변동 없음.
2. **off / danger-full-access 의 `degradeReason` 미발생** — 동일.
3. **bwrap+landlock-cli 부재 = 정직한 강등 (legacy reason 보존)** — `degradeReason: "linux-bwrap-missing"` 유지. ADR-0150 의 `os-sandbox-bubblewrap-hellgate` + `os-sandbox-hellgate` 두 battery 와 byte-identical.
4. **Backend 정직** — `availability()` 가 `"bubblewrap"` / `"landlock+seccomp"` / `"passthrough"` 중 하나로 정확 보고. `landlock-cli` 만 가용 시 `"landlock+seccomp"` arm 활성화.
5. **(신규) Auto-detect 우선순위 고정** — `bwrap` 가 가용하면 항상 우선 채택. `landlock-cli` 는 fallback. 두 backend 가 모두 있을 때 검출 결과는 deterministic (HELL-LX-C16).
6. **(신규) Network-deferred sentinel 의 caller-invisibility** — `LANDLOCK_CLI_NETWORK_DEFERRED_MARKER` 는 spawn 직전 filter. **실제 `landlock-cli` 호출 argv 에는 절대 포함되지 않음** (HELL-LX-D22). marker 가 있었으면 결과에 `degradeReason: "landlock-network-policy-not-enforced"` 부착.
7. **(신규) Determinism** — `compileLinuxSandboxArgv(policy, ws, backend)` 는 pure. 같은 입력 → byte-identical 출력.

## Hellgate (21 신규 케이스 — `os-sandbox-linux-hellgate.test.ts`)

4 cluster:

- **A. compileLinuxSandboxArgv — bubblewrap arm pure (8)**: read-only / workspace-write / workspace-write-net (no `--unshare-net`) / `allowNetwork=true` override / `extraReadPaths` → `--ro-bind p p` / `extraWritePaths` → `--bind p p` / `off` → `[]` / `danger-full-access` → `[]`
- **B. compileLinuxSandboxArgv — landlock-cli arm pure (4)**: read-only → `--ro-paths` 에 workspace / workspace-write → `--rw-paths` 에 workspace / network deny → deferred marker, allow → 미발급 / `extraReadPaths` + `extraWritePaths` merge
- **C. detectLinuxSandboxBackend (4)**: bwrap only → "bubblewrap" / landlock-cli only → "landlock-cli" / neither → null / both → bubblewrap wins (preferred)
- **D. linuxOsSandbox.spawn (5+1=6)**: `off` → passthrough no degradeReason / `workspace-write` + bwrap → argv prefixed `bwrap ... -- userCmd` / no backend → degraded `linux-bwrap-missing` / spawner throw → exit 127 / signal forwarded / landlock-cli + network-deny → marker filtered out + `degradeReason: "landlock-network-policy-not-enforced"`

총: **21 + 1 bonus = 22 신규** + 기존 23 (`os-sandbox-hellgate`) + 11 (`os-sandbox-bubblewrap-hellgate`) = **56 pass / 0 fail / 158 expects**. 모든 케이스 hermetic — 실제 `bwrap` / `landlock-cli` 호출 없음 (darwin 호스트에서도 안전 실행).

## Phase 3 deferral — napi-rs native Landlock FFI

본 ADR 은 **shell-out user-space wrapper** 의 마지막 단계. Phase 3 으로 미루는 이유:

1. **stable Rust binding 미성숙** — `landlock-rs` 가 kernel ABI 추적; per-kernel-version drift 발생. 안정화 전 native binding 은 너무 이름.
2. **per-arch (x64/arm64/musl/glibc) prebuilt 빌드** — npm install 시 native compile 또는 prebuilt download 매트릭스. first-cut 정당화 안 됨.
3. **현재 의미론으로 충분** — `bwrap` denylist 가 Seatbelt parity. `landlock-cli` 가 그 80% (FS-only) 를 cover. Phase 3 native 는 **network namespace + seccomp** 추가 단계.

Phase 3 ADR 진입 조건: `landlock-rs >= 1.0` 안정 release + Bun napi-rs 호환성 확인 + kernel 6.7+ 가 주요 LTS distro 의 default.

## Alternatives rejected

1. **napi-rs landlock FFI in Phase 2** — N주 effort + per-arch native compile + kernel ABI drift. 본 ADR 의 user-space wrapper 가 동일한 의미론 (denylist) 을 0 binding 으로 달성. Phase 3 로 deferred.
2. **firejail** — heavier (1.4MB, 200+ default profiles), X11 forwarding 기본 차단으로 surprise. `bwrap` 가 더 minimal + predictable. `landlock-cli` 가 더 backend-of-last-resort 로 적합.
3. **Docker/podman per-call wrap** — per-spawn container start ~100ms. interactive loop (수십 spawn/turn) 에 unacceptable. `DockerSandbox` (ADR-0006) 는 contract-tier 전용 유지.
4. **seccomp-only filter (libseccomp via FFI)** — Cursor/Codex 가 Landlock 과 **함께** 쓰는 layer. 단독으로는 FS 격리 없음 → 의미 없는 sandbox. Phase 3 의 native Landlock 묶음에 같이.
5. **uid mapping (`unshare --map-root-user`)** — `bwrap` 가 이미 내부에서 처리 (`--unshare-user-try`). `landlock-cli` 도 PID/uid namespace 없음 — 이건 Phase 3 의 future enhancement.
6. **`degradeReason` taxonomy 확장 ("landlock-cli-only" 별도 reason)** — 현재 `"linux-bwrap-missing"` (backend 부재) + `"landlock-network-policy-not-enforced"` (landlock-cli 채택됐지만 network enforce 못함) 두 reason 으로 의미 충분. caller (telemetry, UI) 는 이 두 reason 으로 구분 가능. 새 reason 추가는 hellgate 갱신 비용만 발생.

## SOTA++ 자리매김

| Agent | Linux 백엔드 매트릭스 | Auto-detect | Honest degrade | Closed-port DI |
|---|---|---|---|---|
| Cursor 3.2 | bubblewrap + landlock+seccomp (Rust binding) | ✅ | partial (binary wrap opaque) | ❌ |
| Codex 0.131 | Landlock + seccomp (native Rust) | ✅ | ✅ | partial |
| Claude Code 2.1 | ❌ | — | — | — |
| v0.dev | ❌ | — | — | — |
| **quanta (本 Phase 2 ADR-0159)** | **bubblewrap + landlock-cli (shell-out)** | ✅ | ✅ typed marker | ✅ full closed-port |

quanta 는 Linux 에서 **2-backend auto-detect + typed network-degrade marker** 를 가진 첫 modern agent. native binding 없이 의미론 parity 의 80% 달성. Phase 3 에서 native 로 격상 가능.

## 후속

- **Phase 3 ADR — napi-rs native Landlock FFI** — `landlock-rs >= 1.0` 안정 시. `landlock-cli.ts` 의 shell-out 을 native syscall 로 교체. backend enum 의 `"landlock+seccomp"` arm 이 진짜 seccomp 까지 cover.
- **seccomp filter integration** — Phase 3 의 paired work. syscall denylist (e.g. `mount`, `ptrace`) 가 landlock 의 FS 격리 와 함께 적용.
- **uid mapping refinement** — `bwrap --unshare-user-try` 옵션이 어떤 kernel/distro 조합에서 fail. user namespace 가 활성화 안 된 환경 (Docker 일부, restricted CI) 에서의 fallback 정책.
- **Bubblewrap version probe** — `bwrap --version` parse + 최소 0.4.0 요구. `--die-with-parent` 미지원 시 명시적 hardening 후속.
- **`runShell` 통합** — `ShellOptions.osSandbox?` 슬롯 sibling ADR. Phase 2-full (본 ADR) 이 wire-ready 의 마지막 prereq.
