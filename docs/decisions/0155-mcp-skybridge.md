# ADR-0155: MCP Skybridge Phase 1 — typed sandbox port + passthrough adapter

- **상태**: Accepted (Phase 1 — typed-port + passthrough adapter + Phase-2 stubs)
- **날짜**: 2026-05-24
- **관련**: ADR-0136 (OS-level sandbox helper — sibling primitive, but for bash subprocess; 본 슬라이스는 MCP 서버 격리 전용), ADR-0094 (ChatGPT OAuth — sibling provider port; 동일한 closed-port DI 패턴), ADR-0150 (Linux sandbox Phase 2 — 동일한 "Phase 1 typed-port → Phase 2 native binding" 분리 전략의 선례)
- **SOTA 출처**: Claude Desktop 1.7196.3 "Skybridge" (yukonSilver microVM + Cowork containers + vsock + MITM proxy). Cursor 3.2 / Codex 0.131 / v0.dev / Cline — 모두 MCP 서버를 호스트 권한으로 그대로 실행 (격리 없음). Phase 1 = Claude Desktop의 **STRUCTURAL 패턴** (typed profile → backend → ipcChannel + sandboxApplied 정직성) 흡수.
- **참조**: `src/mcp/skybridge/{types,passthrough,container,microvm,registry,index}.ts`, `tests/unit/mcp-skybridge-hellgate.test.ts`

## 맥락

오늘 quanta의 MCP 격리 상태:

| 축 | 우리 (전) | Cursor | Codex | Claude Desktop | v0.dev |
|---|---|---|---|---|---|
| MCP 서버 프로세스 분리 | ✅ (stdio child) | ✅ | ✅ | ✅ | ✅ |
| MCP 서버 FS allowlist | ❌ | ❌ | ❌ | ✅ (Cowork) | ❌ |
| MCP 서버 network allowlist | ❌ | partial | ❌ | ✅ (MITM proxy) | ❌ |
| MCP 서버 syscall filter | ❌ | ❌ | ❌ | partial | ❌ |
| MCP 서버 microVM 격리 | ❌ | ❌ | ❌ | ✅ (yukonSilver) | ❌ |
| typed sandbox policy 포트 | ❌ | ❌ | ❌ | internal | ❌ |

`@/mcp/client.ts` 는 `Bun.spawn` 으로 MCP 서버를 직접 띄우고 PATH + opt-in env 만 inherit 한다. **MCP 서버는 quanta 와 동일한 권한**으로 호스트의 모든 파일/네트워크에 접근할 수 있다 — env 스크럽이 secret 누출은 막지만, 임의 파일 읽기/네트워크 송신은 막지 못한다.

Claude Desktop은 "Skybridge"로 이 표면을 봉인했다:
- **yukonSilver** — MCP 서버는 Lima/Apple-Virtualization 위의 microVM 안에서 실행.
- **Cowork** — chroot/namespace 기반의 container-Lite 변형 (lower 격리).
- **vsock** — host ↔ guest IPC.
- **MITM proxy** — 격리된 MCP 서버의 outbound network traffic 을 host 가 검사.

quanta 가 native binding (Lima FFI, Virtualization.framework helper, firecracker 등) 을 직접 maintain 하는 비용은 N주이고, 본 슬라이스는 그것을 결정하지 않는다. 대신 **STRUCTURAL 패턴**을 흡수한다 — Phase 2 에서 native adapter 가 들어올 때 caller 코드는 1줄도 안 바뀌도록 port 표면을 먼저 닫는다.

## 결정

신규 plane-clean 모듈 5개 + barrel 1개 (`src/mcp/skybridge/`):

### 1. `types.ts` — 폐쇄 4-arm profile + 포트

```ts
type SkybridgeProfile = "off" | "process-isolated" | "container" | "microvm"

interface McpSandboxPolicy {
  readonly profile: SkybridgeProfile
  readonly networkAllowlist?: ReadonlyArray<string>
  readonly hostReadAllowlist?: ReadonlyArray<string>
  readonly hostWriteAllowlist?: ReadonlyArray<string>
  readonly maxRuntimeMs?: number
  readonly memoryMb?: number
}

interface McpSandbox {
  spawn(spec, policy): Promise<McpSandboxHandle>  // no-throw
  availability(): Promise<{ backend, warnings }>
}
```

핵심 결정 3 가지:

#### `process-isolated` 가 `sandboxApplied: true` 인 이유

OS process 경계 자체가 **실제 (최소이지만)** 격리 layer 다 — 분리된 address space, 분리된 fd table, signal disposition, memory protection. 본 ADR 은 그것을 정직하게 `sandboxApplied: true` 로 표시한다 (silent fallback 의 반대 방향: 실제 격리 효과를 부정하지 않는다). 더 강한 profile (container / microvm) 은 그 위에 **추가** layer (FS namespace, network namespace, syscall filter, memory cap) 를 얹는 것 — Phase 2 의 일.

대안 ("process-isolated 도 sandboxApplied: false 로 표시") 는 거부했다. 오늘의 격리를 "0"으로 부르는 것은 부정확하고, container/microvm 의 honest gap 을 더 작아 보이게 만든다.

#### `off` 의 `degradeReason` 부재

`off` 는 caller 의 명시적 opt-out 이지 강등이 아니다. `degradeReason` 은 **요청한 격리를 못 제공한 사유** 를 가리키는 필드 — `off` 는 격리를 요청 안 했으므로 사유가 없다. exactOptional 로 필드 자체를 omit (key 가 존재하지 않음).

#### container/microvm 도 spawn 은 **반드시** 수행

passthrough adapter 가 `profile="container"` 를 받으면, **MCP 서버는 그래도 띄운다** — 단 `sandboxApplied: false` + `degradeReason: "phase2-not-implemented"` 로 정직하게 표시한다. 격리 layer 가 없다고 MCP connection 자체를 끊는 것은 user 입장에서 "Phase 2 백엔드 없으면 MCP 가 안 됨" 으로 잘못 학습된다. 우리는 **격리가 강등될 수는 있어도 기능은 강등되지 않는다** — UI/metrics/policy layer 가 `sandboxApplied=false` 를 보고 경고할 수 있다.

### 2. `passthrough.ts` — Phase 1 default adapter

`SkybridgeSpawner` (caller-injected) 를 wrap. cfg.spawner 가 없으면 degraded handle 을 return (no-throw, key="spawn-failed: no spawner wired"). 모든 profile arm 의 (sandboxApplied, degradeReason) 결정을 `decideApplied()` 한 곳에서.

idempotent stop wrapping: caller 가 `handle.stop()` 을 두 번 불러도 inner spawner 의 stop 은 한 번만 호출 (계약 호환).

spawner throw → `backendId: "error"` + `ipcChannel.ref: "error"` + `degradeReason: "spawn-failed: <msg>"` 로 collapse. **rethrow 하지 않는다** — `McpSandbox.spawn` 의 no-throw 계약은 모든 backend 실패를 typed-shape return 으로 표현한다 (caller 는 `sandboxApplied=false` + `degradeReason` 으로 분기).

### 3. `container.ts` / `microvm.ts` — Phase 2 stubs

각각 `spawn` 에서 `McpSandboxError("backend-unavailable", "Phase 2 — <backend> not implemented")` 를 throw. `availability()` 는 `backend: "container"` 또는 `"microvm"` + warning 으로 보고 (silent passthrough 아님).

**의도적으로 내부 강등 안 함** — caller 가 이 stub 을 *직접* wire 했다면 (passthrough 가 아니라 명시적으로 container/microvm 을 요청), rejection 이 정답이다. 강등 결정은 `registry` 가 한다 (caller 가 wire 안 했을 때만).

### 4. `registry.ts` — adapter picker

```
rule 1: profile="off"              → passthrough (off short-circuits regardless)
rule 2: profile="process-isolated" → passthrough
rule 3: profile="container" + wired → wired
rule 4: profile="microvm"   + wired → wired
rule 5: Phase-2 profile + UNwired  → passthrough (degrades; never throws)
```

`off` 가 wired Phase-2 adapter 보다 우선 — caller 의 명시적 opt-out 이 wiring 보다 강하다. Phase-2 profile 이 unwired 면 throw 대신 passthrough 로 degrades — registry 는 pure picker, throw 책임은 adapter 의 spawn 이 진다.

### 5. `index.ts` — barrel

모든 type + 3 adapter + registry re-export. `@/mcp/skybridge` import path 안정.

## 계약 (Phase 1, 5)

1. **NO-THROW on spawn** — `McpSandbox.spawn` 은 어떤 backend 실패도 typed-shape return 으로 collapse. throw 는 오직 Phase-2 stub 의 명시적 `McpSandboxError("backend-unavailable")` — registry 가 unwired 면 이 stub 을 picker에서 회피.
2. **honesty 봉인** — `sandboxApplied` 가 거짓을 말하지 않는다. process-isolated 는 true (OS 경계가 실제 layer), container/microvm 은 passthrough 일 때 false + `degradeReason`. silent fallback 금지.
3. **off 의 degradeReason 부재** — `profile="off"` 는 강등이 아닌 opt-out. exactOptional 로 field omit.
4. **idempotent stop** — `handle.stop()` 의 두 번째 호출은 inner spawner 의 stop 을 다시 부르지 않는다.
5. **plane-clean** — `src/mcp/skybridge/*` 는 `@/agent`, `@/permission`, `@/tool`, `@/llm` 어떤 것도 import 안 함. `node:child_process` / `Bun.spawn` 직접 import 도 안 함 — `SkybridgeSpawner` 로 caller DI.

## Hellgate (18 cases / 65 expects)

`tests/unit/mcp-skybridge-hellgate.test.ts`:

- **A. Policy type / port compile (4)**: 4-arm 폐쇄 union exhaustive switch / exactOptional omitted-key 검증 / handle.degradeReason omit / McpSandboxError 4-arm code union.
- **B. passthroughMcpSandbox.spawn (8)**: off → spawned + applied=false + reason 부재 / process-isolated → applied=true / container → applied=false + reason="phase2-not-implemented" + spawn 수행 / microvm → 동일 / env 전파 / cwd 전파 (있을 때/없을 때) / spawner throw → backendId="error" + 정직한 degraded handle + no rethrow / stop idempotency (2 호출 → 1 inner-stop).
- **C. availability + registry (3)**: passthrough → backend="passthrough" + Phase-2 warning / unwired container profile → degrades to passthrough / wired container → 그 backend 그대로.
- **D. Phase-2 stubs (2)**: container.spawn throws McpSandboxError("backend-unavailable") / microvm 동일.
- **E. registry off short-circuit (1)**: wired container+microvm 모두 있어도 `profile="off"` 면 passthrough 가 picks (caller opt-out 가 wiring 보다 강함).

18 pass / 0 fail / 65 expects.

## Phase 2 deferral 합리화

native microVM binding (Lima FFI / Virtualization.framework helper / firecracker / vsock) 의 maintenance burden 은:
- per-OS native code (macOS = Virtualization.framework Swift/Obj-C helper, Linux = Lima 또는 firecracker subprocess + vsock)
- per-arch prebuilt (x64 / arm64 / musl)
- guest OS image 관리 (alpine? ubuntu-min? size? boot time?)
- vsock protocol layering (host ↔ guest connection bootstrap, restart 시 reconnect, exit semantics)
- MITM proxy (Claude Desktop 의 4번째 축 — host 가 격리된 MCP 의 outbound 를 검사)

이건 single-ADR 분량이 아니다. Phase 1 의 가치는: Phase 2 가 도착했을 때 caller 코드를 **1줄도 안 바꾸고** swap 할 수 있는 port 표면을 먼저 닫는 것 — 그것을 18-case hellgate 로 봉인.

## Alternatives rejected

1. **"Docker/containerd 를 container profile 백엔드로 직접"** — heavy dep (host docker daemon 필요), per-spawn 100ms+ overhead. Lima 기반 microVM-Lite 또는 chroot+namespace 가 cleaner. Phase 2 ADR 에서 평가.
2. **"All-in process-isolated default"** — false sense of security. 본 ADR 은 default 를 `off` 로 두고, process-isolated 는 caller 가 명시적으로 선택. policy/caller layer 가 profile 을 의식적으로 올린다.
3. **"Auto-detect platform 해서 best profile pick"** — caller 책임. Phase 1 은 strictly user-declared profile + 정직한 degrade. auto-pick 은 silent default 가 변하는 hidden-state — debug 어려움.
4. **"Network allowlist 를 passthrough 에서 enforce (e.g. ip-rules + EBPF stub)"** — passthrough 는 정의상 격리 layer 가 없다. allowlist 필드는 carry 하되 Phase 2 backend 만 enforce — 의미를 거짓으로 만들지 않음 (passthrough 가 enforce 하는 척 하면 가장 위험한 silent-fail).
5. **"Phase 1 에 mock vsock IPC over Unix domain socket"** — back-end 없는 vsock 흉내는 surface 만 늘리고 의미 없다. ipcChannel.kind 는 `"stdio" | "vsock" | "named-pipe"` 로 4-arm 미만 폐쇄로 두되 Phase 1 에서는 stdio 만 실사용. YAGNI.
6. **"container/microvm stub 이 내부적으로 passthrough 로 강등"** — caller 가 stub 을 *명시적으로* wire 했다면 (registry 가 아니라 직접 `containerMcpSandbox()` 를 손에 들었다면), rejection 이 정답. 강등은 registry 의 decision (rule 5).
7. **"spawner throw 시 McpSandboxError 로 rethrow"** — no-throw 계약 위배. typed return shape (backendId="error" + degradeReason) 이 일관성 있고 caller 분기 코드를 단순하게 만든다.

## SOTA++ 자리매김

| Agent | MCP isolation | typed policy port | sandbox honesty | adapter swap cost |
|---|---|---|---|---|
| Cline | ❌ | ❌ | n/a | n/a |
| Cursor 3.2 | partial (process) | ❌ | n/a | rewrite |
| Codex 0.131 | partial (process) | ❌ | n/a | rewrite |
| Claude Desktop 1.7196 | ✅ Skybridge microVM | internal | ✅ (Cowork tier) | internal |
| v0.dev | ❌ | ❌ | n/a | n/a |
| **quanta (Phase 1)** | ✅ typed-port + passthrough + Phase-2 stubs | ✅ 4-arm closed | ✅ exactOptional degradeReason | **1-line adapter swap** |

= "Claude Desktop 의 microVM 격리는 internal binding 으로 봉인. 우리는 같은 STRUCTURAL 패턴을 typed-port 로 표현 — Phase 2 에서 native adapter 가 도착하면 `containerSandbox`/`microvmSandbox` 슬롯에 한 줄 wire."

## Follow-up (이 ADR 이 닫지 않는 것)

- **Phase 2 ADR — native microVM adapter** — Lima (macOS arm64 친화) vs Apple Virtualization (Native macOS) vs firecracker (Linux) 매트릭스 평가. vsock IPC bootstrap. guest image (alpine-min) 관리. host helper binary 또는 napi-rs 결정.
- **Phase 2 ADR — MITM proxy port** — `networkAllowlist` enforce 하는 outbound proxy 슬라이스. Claude Desktop 의 4번째 Skybridge 축.
- **per-MCP policy DSL** — user config 의 `.mcp.json` 에 per-server `sandbox: { profile, networkAllowlist, ... }` 필드 추가 (현재는 코드 호출 시점에 정책 주입). ADR-0094 의 OAuth provider config 와 비슷한 surface 확장.
- **auto-discover safe defaults** — `npm:` prefix MCP 서버 (untrusted code) 는 자동으로 `container` profile 권장 등의 정책 layer. 단 auto-pick 자체는 본 ADR 의 alternatives §3 거부 — 별도 ADR 에서 explicit policy DSL 로.
- **observability wiring** — `MetricSink` (ADR-0144) 에 `mcp_sandbox_degraded_total{profile,reason}` counter 추가. Phase 2 의 swap 시 metric 으로 "container backend 가 정말 켜졌는가" 검증.
- **maxRuntimeMs enforce** — Phase 1 의 passthrough 는 carry 만. Phase 2 backend 가 timer + signal 로 enforce.
