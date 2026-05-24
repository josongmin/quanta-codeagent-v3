# ADR-0136: OS-level sandbox helper — Cursor `cursorsandbox` + Codex Seatbelt 흡수

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0006 (runtime 샌드박스 추상화 — `LocalSandbox`/`DockerSandbox` 약식 보장 매트릭스), ADR-0093 (effect-channel — 본 슬라이스의 미래 통합 지점), ADR-0135 (permission-sandbox 2-layer — 본 슬라이스가 4-pillar의 sandbox pillar를 강화)
- **SOTA 출처**: Cursor `cursorsandbox` (macOS Seatbelt + Linux Bubblewrap/Landlock+seccomp), Codex `codex-seatbelt-sandbox-profile` (workspace-write/read-only/danger-full-access 3-mode + Landlock fallback). 두 SOTA만 OS-level wrap을 제공 — Claude Code 2.1 / v0.dev / Cline 모두 미보유.
- **참조**: `src/runtime/os-sandbox/{types,seatbelt,landlock,default,index}.ts`, `tests/unit/os-sandbox-hellgate.test.ts`

## 맥락

오늘 quanta의 격리 매트릭스 (ADR-0006):

| 축 | LocalSandbox | DockerSandbox |
|---|---|---|
| env 스크럽 | ✅ | ✅ |
| cwd jail (start dir + escape reject) | ✅ | ✅ |
| 절대경로 FS 격리 (chroot) | ❌ | ✅ |
| 네트워크 차단 | ❌ (advisory) | ✅ |
| process spawn 제한 | ❌ | ❌ |
| syscall 제한 | ❌ | ❌ |

`bash` 툴이 자식 프로세스를 띄울 때 우리는 **fs-jail (path-level allow/deny)** 에 의존한다. 그러나 sandboxed subprocess가 **fork할 수 있고**, **임의 네트워크 소켓을 열 수 있고**, **권한이 있으면 `/etc/shadow`도 읽을 수 있다** — fs-jail은 이런 출구를 막을 수 없다.

Cursor는 `cursorsandbox` (Rust binary) 로 macOS Seatbelt + Linux Bubblewrap/Landlock+seccomp를 추상화한다. Codex는 비슷한 `codex-linux-sandbox` + 직접 Seatbelt profile 발급. **두 곳 모두 PATTERN은 동일**: typed policy → OS-native enforcer 선택 → 자식 프로세스를 그 안에서 exec.

우리는 그 **PATTERN을 흡수**한다. Phase 1 = typed policy + Seatbelt profile compiler (macOS) + Linux 1-stage stub + degraded-passthrough fallback. **실제 Landlock FFI는 N주 + napi-rs 바인딩 유지보수가 필요해 Phase 2 ADR로 분리한다.**

## 결정

신규 plane-clean 모듈 4개 + barrel 1개 (`src/runtime/os-sandbox/`):

### 1. `types.ts` — 폐쇄 enum + 포트

5-arm 폐쇄 `SandboxProfile`:
- `"off"` — 패스-스루 (기본; 기존 호출자에 byte-identical)
- `"read-only"` — FS 읽기만, 네트워크 deny, 새 바이너리 exec deny
- `"workspace-write"` — 워크스페이스 내 write, 외부 read, 네트워크 deny, exec deny
- `"workspace-write-net"` — workspace-write + 네트워크 allow
- `"danger-full-access"` — 명시적 opt-in 패스-스루 (warning surfaced)

`SandboxPolicy` 필드: `profile`, `extraReadPaths?`, `extraWritePaths?`, `allowNetwork?`, `timeoutMs?` (전부 exactOptional).

`OsSandbox` 포트:
```ts
interface OsSandbox {
  spawn(spec, policy): Promise<SandboxedSpawnResult>  // NO-THROW
  availability(): Promise<{ backend, warnings }>
}
```

`SandboxedSpawnResult` carries `sandboxApplied: boolean` + optional `degradeReason`. 결과 객체로 강등을 가시화 — silent fallback 금지.

### 2. `seatbelt.ts` — Pure profile compiler

```ts
compileSeatbeltProfile(policy, workspace): string | null
```

`null` 반환 = "이 profile은 컴파일하지 않음" (caller가 verbatim spawn) — `off`, `danger-full-access` 케이스.

Profile shape (`codex-seatbelt-sandbox-profile` 베이스라인 + 5-arm enum 적응):
```scheme
(version 1)
(deny default)
(allow process-fork)              ;; bash 자신이 fork 필요
(allow ipc-posix-sem)             ;; glibc init
(allow pseudo-tty)                ;; node-pty / test runner
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow user-preference-read)
(allow file-read*                 ;; 시스템 framework reads — always-on
  (subpath "/usr/lib") (subpath "/usr/share")
  (subpath "/System/Library/Frameworks") ...)
(allow file-read* (subpath "<workspace>") ...extraReadPaths)
(allow file-write* (subpath "<workspace>") ...extraWritePaths)  ;; read-only 제외
(deny network*)                   ;; 또는 (allow network*)
```

### 3. `landlock.ts` — Linux Phase 1 stub

`isLandlockAvailable()` always `false` (Phase 1). `spawnViaLandlock()` = degraded passthrough + `degradeReason: "landlock-not-implemented"`. Phase 2에서 napi-rs binding 또는 `bwrap` 셸-아웃 도입 시 본 stub만 교체.

### 4. `default.ts` — Port impl

`defaultOsSandbox(cfg?)` returns `OsSandbox`. 디스패치:
- `profile === "off" | "danger-full-access"` → 패스-스루, `sandboxApplied: false`, **no `degradeReason`** (사용자가 의도적으로 sandbox 안 켰음)
- `darwin + sandbox-exec found` → `compileSeatbeltProfile` + `sandbox-exec -p '<profile>' <cmd>`
- `darwin + sandbox-exec missing` → degraded passthrough + `degradeReason: "sandbox-exec-missing"`
- `linux` → `spawnViaLandlock` (Phase 1 = degraded)
- `other` (win32 등) → degraded passthrough + `unsupported-platform:<plat>`

`cfg.spawner` / `cfg.platform` / `cfg.which` 전부 closed-port DI — 테스트가 주입. 프로덕션 default는 `node:child_process` (Bun.spawn-compatible 인터페이스).

### 5. `index.ts` — Barrel

전부 re-export. `@/runtime/os-sandbox`로 단일 import 지점.

## 계약 (6)

1. **NO-THROW spawn**. 어떤 spawn/sandbox 실패도 throw 안 함. 실패는 `exitCode === 127` + `stderr` 메시지 + `degradeReason: "spawn-failed"`로 collapse. `OsSandboxError` typed class는 *callers*가 try-around-spawner-config-they-pass 패턴으로 쓸 수 있지만, port surface 자체는 절대 throw 안 함.
2. **Default-OFF byte-identical**. `profile === "off"` ⇒ 기존 호출 경로와 argv 동일 (`sandbox-exec` 래핑 없음). 기존 `bash`/`runShell` 경로는 본 ADR 적용 후에도 **호출자가 명시적으로 policy를 넘기기 전까지** 완전 byte-identical.
3. **exactOptionalPropertyTypes**. `degradeReason`은 강등 발생 시에만 key 존재. `sandboxApplied: true` 결과는 `hasOwnProperty("degradeReason") === false` (HELL-E23 검증).
4. **Honest degradation**. 강등은 **항상 typed 결과**로 가시화. silent fallback 금지 — ADR-0006이 `DockerSandbox`에서 throw로 가시화한 정신을 본 ADR에서는 typed result field로 가시화 (port가 NO-THROW이므로).
5. **Plane-clean import**. `src/runtime/os-sandbox/*`는 `node:child_process`만 import. `@/agent`/`@/permission`/`@/tool` 어느 것도 import 안 함. 본 슬라이스는 leaf — 다른 슬라이스의 의존성 그래프 외부에 위치.
6. **Determinism**. `compileSeatbeltProfile(policy, workspace)` 는 pure — 같은 입력은 byte-identical 출력 (HELL-D22 검증). I/O / Date.now / random 부재.

## Default-OFF & wiring 정책

본 슬라이스를 **자동으로 wire하는 곳은 없다**. `LocalSandbox`/`DockerSandbox`/`runShell` 어느 곳도 본 ADR 적용 후 변경되지 않는다. 모든 기존 호출자는 zero-regression.

미래 소비자:
- **`runShell` 통합** — `ShellOptions.osSandbox?: { sandbox: OsSandbox; policy: SandboxPolicy }` 슬롯을 sibling ADR에서 추가 가능 (deferred-wire 패턴, ADR-0125와 동일)
- **`bash` 툴** — per-call policy override (HITL "사용자가 이 명령은 networking이 필요하다고 답함" → 한 번만 `workspace-write-net`)
- **EffectChannel (ADR-0093)** — 모든 effect-tagged spawn이 본 sandbox.spawn을 통과하는 미래 ADR

## Hellgate (23 cases)

`tests/unit/os-sandbox-hellgate.test.ts` 가 5 cluster로 봉인:

- **A. compileSeatbeltProfile pure (6)**: read-only no-write + deny-net / workspace-write file-write line / workspace-write-net allow-net / extraReadPaths included / extraWritePaths included / off+danger return null
- **B. defaultOsSandbox.spawn (8)**: off→raw argv / danger→raw argv / darwin+seatbelt→`sandbox-exec -p ...` prefix / darwin+missing→degraded `sandbox-exec-missing` / linux→degraded `landlock-not-implemented` / spawner throw→exit 127+stderr / signal forwarded / env forwarded
- **C. availability (3)**: darwin+seatbelt→backend=seatbelt+0 warnings / linux→passthrough+Phase-2 warning / win32→passthrough+unsupported warning
- **D. policy edge cases (5)**: abs extraReadPath preserved verbatim / rel extraReadPath joined to workspace / allowNetwork override on read-only / off→no compilation + spawn passthrough / determinism (byte-identical for same input)
- **E. result shape (1)**: sandboxApplied=true ⇒ `degradeReason` key OMITTED (exactOptional)

23 pass / 0 fail / 60 expect() calls. 모든 케이스 platform-injected — 실제 `sandbox-exec` 호출 없음 (macOS-only run hazard 제거).

## Alternatives rejected

1. **Native Landlock FFI in Phase 1** — N주 effort + napi-rs binding kernel ABI drift 유지보수. first-cut에 정당화 안 됨. Phase 2 ADR.
2. **Shell out to `firejail` / `bubblewrap` on Linux** — 시스템 의존성 추가. user에게 "이거 깔아라" 요구는 first-cut 정책에 어긋남. Phase 2 옵션.
3. **Docker/podman wrap을 모든 bash 호출에** — per-tool spawn cost가 100ms+ 단위. interactive loop에 너무 무겁다. `DockerSandbox` (ADR-0006) 는 contract-tier 전용으로 유지.
4. **TOCTOU-safe at kernel level (Landlock)** — Linux Phase 2가 정확히 이 작업. macOS Seatbelt도 이미 LSM-level이라 첫 단계에서 다룬다.
5. **`profile` 전체 폐기하고 path/network/exec 각각 boolean 플래그** — pre-canned profile이 더 안전 (사용자가 `network: true` 부주의 토글하기 쉬움). Cursor / Codex 둘 다 mode-enum을 채택한 SOTA 합의.
6. **NPM `node-sandbox` 같은 user-space wrapper** — Bun-incompatible + user-space는 fork escape에 무력. OS-native만 의미 있음.

## 보안 노트

- Seatbelt profile은 **deny-default**. 명시적 allow-list만 통과. 새 SBPL rule을 추가하려면 코드 변경 + hellgate 갱신 필요 — 정책 drift 방어.
- `process-fork`는 **모든 non-off profile에서 허용** — `bash` 자신이 fork(2)를 쓰므로 deny하면 sandbox가 useless. `process-exec` (새 바이너리 exec) 는 **deny** — fork→exec 출구를 closes.
- `pseudo-tty` + `/dev/ptmx`는 always-on — test runner / repl이 tty-attached일 때 sandbox-trip 방지.
- 워크스페이스 path는 SBPL string literal에 들어가기 전 `"` / `\` escape — 비-typical workspace 인자에 대한 방어 in-depth.
- `extraReadPaths`/`extraWritePaths` 절대경로는 verbatim 보존 (jail escape 방지를 호출자에 위임 — port는 정책 발급자 의도를 신뢰).

## SOTA++ 자리매김

| Agent | OS sandbox port | macOS Seatbelt | Linux Landlock | Typed policy enum | Closed-port DI |
|---|---|---|---|---|---|
| Cursor 3.2 | ✅ `cursorsandbox` binary | ✅ | ✅ (bwrap+landlock+seccomp) | ❌ (Rust struct, opaque) | ❌ (binary wrap) |
| Codex 0.131 | ✅ (Rust inline) | ✅ | ✅ (landlock+seccomp fallback) | ✅ 3-mode | partial |
| Claude Code 2.1 | ❌ | ❌ | ❌ | — | — |
| v0.dev | ❌ | ❌ | ❌ | — | — |
| **quanta (本)** | ✅ TS port | ✅ Phase 1 | ⏳ Phase 2 stub | ✅ 5-arm closed | ✅ full closed-port + NO-THROW + typed degradation |

quanta가 OS-sandbox 슬라이스를 가진 3번째 modern agent. 5-arm enum + NO-THROW port + typed degradation은 **closed-port hardening 축에서 SOTA++**.

## 후속

- **Linux Landlock impl** — Phase 2 ADR. `napi-rs landlock` evaluation + `bwrap` 셸-아웃 fallback 디자인.
- **`runShell` 통합** — `ShellOptions.osSandbox` 슬롯 추가 ADR. 본 ADR 적용 후 sibling.
- **EffectChannel 통합 (ADR-0093)** — 모든 effect-tagged spawn을 sandbox.spawn 라우팅.
- **Profile composition** — 다중 policy 결합 (e.g. base profile + per-tool overlay). 본 ADR은 단일 policy.
- **Degraded-call audit log** — sandboxApplied=false + degradeReason!==undefined 인 경우의 telemetry emission. OTel attribute는 ADR-0044 vocabulary 확장.
- **Permission-sandbox 2-layer 연결 (ADR-0135)** — `permission_profile.file_system` AND `file_system_sandbox_policy` 두 layer에서 본 슬라이스가 후자를 담당. former는 permission 슬라이스가 담당.
