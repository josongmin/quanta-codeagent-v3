# RFC: MCP 서버 crash-detection + auto-restart (exponential backoff)

- **Status**: Draft (implementation-ready)
- **Author**: architecture
- **Date**: 2026-06-02
- **ADR (제안)**: ADR-0435 (`docs/decisions/`의 최신은 `0434-permission-profile-list-select.md` — 다음 free 번호)
- **Slice**: `@/mcp` (신규 leaf `src/mcp/reconnect/`) + `@/agent` 와이어 1줄 + `@/apps/cli` 와이어 1줄
- **Default-OFF**: supervisor 미주입 ⇒ 오늘 동작 **byte-identical**
- **흡수 출처**: Cursor `mcpProcessMain.js` reconnect lifecycle (정확한 line은 §1)

---

## 1. 배경 — Cursor의 reconnect 알고리즘 (흡수 대상)

전부 `/Users/songmin/quanta-codeagent-v3/.extracted_source/cursor/out/vs/code/electron-utility/mcpProcess/mcpProcessMain.js`.

### 1.1 두 단계 backoff 상수 (`:19065`)

```js
var Dv = 5e3,        // fastRetryBaseDelayMs   = 5_000  (5s)
    Nv = 6e4,        // fastRetryMaxDelayMs    = 60_000 (60s)
    Fv = 5 * 6e4,    // periodicRetryBaseDelayMs = 300_000 (5m)
    Uv = 30 * 6e4;   // periodicRetryMaxDelayMs  = 1_800_000 (30m)
```

Cursor는 reconnect를 **fast-retry**(크래시 직후 공격적 재시도)와 **periodic-retry**(fast 단계 소진 후 느린 주기적 재시도) 두 페이즈로 나눈다. 우리도 동일 모델을 채택한다.

### 1.2 backoff + jitter 공식 (`Fd`, `:19125`)

```js
function Fd({ attempt: e, baseDelayMs: t, maxDelayMs: r }) {
  const n = Math.min(t * 2 ** e, r);        // capped exponential: base * 2^attempt, clamp to max
  return n <= t ? t : t + Math.random() * (n - t);   // full-jitter over [base, capped]
}
```

핵심: **capped exponential + full-jitter**. `attempt=0`이면 `n = base`이므로 jitter 없이 정확히 `base`. 그 외에는 `[base, min(base*2^attempt, max)]` 구간에 균등 분포. (AWS "full jitter" 변형 — thundering-herd 방지.)

`Ds` (clamp, `:19088`)는 config 값을 `[minDelayMs, maxDelayMs]`로 묶는다. `Nd`(`:19096`)는 per-server 동적 config를 읽어 4상수에 floor/ceiling을 적용(예: `fastRetryBaseDelayMs`는 `[1e3, 36e5]`, `periodicRetryBaseDelayMs`는 `[3e4, 36e5]`).

### 1.3 per-server reconnect knob 묶음 (`jv`, `:19152`)

```js
function jv(e, t, r) {
  return { backoff: {
    getBackoffDelay:          s => zv(e, s, n),  // fast-retry delay   (Fd over fast base/max)
    getPeriodicRetryDelay:    s => Wv(e, s, n),  // periodic delay     (Fd over periodic base/max)
    getMaxAttempts:           () => e.getFastRetryMaxAttempts(n),    // fast 단계 최대 시도수
    getMaxPeriodicCycles:     () => e.getMaxPeriodicCycles(n),       // periodic 사이클 cap
    getStabilityThresholdMs:  () => e.getStabilityThresholdMs(n),    // "다시 healthy로 인정"하는 무사고 지속시간
    getMaxDegradedProbeFailures: () => e.getMaxDegradedProbeFailures(n)  // degraded 상태 health-probe 실패 한도
  }};
}
```

- `getStabilityThresholdMs`: 재시작 후 이 시간동안 다시 안 죽으면 attempt 카운터를 리셋(다음 크래시는 다시 attempt=0부터). **flapping 방지의 핵심**.
- `refreshReconnectConfig` (`:19337`): Statsig 동적 config를 per-server로 읽어 backoff를 런타임 갱신. 우리는 정적 per-server config로 대체(동적 원격 config는 non-goal, §3).
- `bumpConnectionGeneration`/`isCurrentConnectionGeneration` (`:19414`): 재연결 generation 토큰 — stop 후 늦게 도착한 비동기 재연결을 무시(stale guard). 우리는 동일 패턴을 `restartEpoch`로 흡수.
- `lastStartupDiagnostic` / `emitStructuredStatusLog` (`:19286`): 마지막 startup 실패 사유를 구조화 로그로 보존(`mcp_process_connect_failure`, `isRetryable`). 우리는 supervisor state에 `lastDiagnostic` 필드로 흡수.
- `shouldReconnectExistingLifecycle` (`:19431`): 기존 lifecycle이 retryable이면 재연결, 아니면 skip — give-up 판정.

### 1.4 격리 모델 (흡수하지 **않는** 부분)

Cursor는 MCP 전체를 전용 Electron **UtilityProcess**(`electron-utility/mcpProcess/`)에서 돌린다 — MCP 서버 크래시가 main/renderer를 절대 못 죽이도록 프로세스 경계로 격리. **이 프로세스 모델은 흡수하지 않는다**(§3 non-goal). quanta는 이미 자체 spawn/격리(`StdioMcpTransport` + 선택적 `IsolatedMcpClient`의 `@/plugin-isolation` 스포너)를 가지므로, 우리는 *재시작 정책*만 흡수하고 격리는 기존 메커니즘을 재사용한다.

---

## 2. 현재 quanta 동작 — 재시작 없음 (크래시 = 영구 실패)

### 2.1 크래시 시 영구 실패 경로 (문제의 핵심)

`src/mcp/client.ts:354`:

```ts
private onTransportExit(): void {
  this.exited = true
  this.failAllPending(new McpError(`mcp server "${this.config.name}" exited`))
}
```

transport가 종료를 알리면 `exited = true`로 영구 마킹된다. 이후 모든 호출은 `ensureReady()`(`client.ts:267`)에서 막힌다:

```ts
private ensureReady(): void {
  if (!this.started || this.stopped || this.exited) {
    throw new McpError(`mcp server "${this.config.name}" is not running`)
  }
}
```

`exited`를 false로 되돌리는 코드 경로는 **존재하지 않는다**. 즉 MCP 서버가 한 번 크래시하면 그 서버의 **모든 tool이 세션 전체 동안 영구 비활성화**된다. 재spawn/재initialize 로직은 어디에도 없다.

### 2.2 bridge가 client를 잡고 있는 방식

`src/agent/mcp-bridge.ts:67` `mcpToolToTool`는 **단일 `McpClient` 참조를 클로저로 캡처**한다:

```ts
export const mcpToolToTool = (client: McpClient, def: McpToolDef, serverName: string): Tool => {
  ...
  async *execute(input, _ctx) {
    const res = await client.callTool(def.name, input)   // <- 캡처된 client. 죽으면 끝.
    ...
  }
}
```

`loadMcpTools`(`mcp-bridge.ts:139`)는 서버별로 `new McpClient(config, clientOpts)` → `start()` → `listTools()` → tool마다 `mcpToolToTool(client, …)`를 만들고, `client` 인스턴스 배열을 그대로 반환한다(`:162`). start/list 실패 시 그 서버만 skip(`:163-166`). **재시작 훅 없음**.

이 클로저-캡처가 재시작 설계의 제약: tool이 `client` 인스턴스를 직접 잡으므로, 재시작으로 client 인스턴스가 교체되면 tool은 죽은 인스턴스를 계속 본다. 해결책은 **indirection**(아래 §4).

### 2.3 격리 client

`src/mcp/isolated-client.ts`는 `MCP_USE_ISOLATED_SPAWN=1`일 때만 쓰이는 대체 client로, 5s spawn-timeout / SIGTERM→SIGKILL 5s grace(`:14-17`)를 더한다. 하지만 **이것도 재시작은 안 한다** — `start()`의 initialize 실패 시 partial-start를 롤백(`:180-188`)할 뿐, 크래시 후 자동 재spawn은 없다. supervisor는 두 client 모두 위에서 동일하게 감싸야 한다(§4.4).

### 2.4 wire 지점

`src/apps/cli/internal.ts:635` `loadFeatures`가 `loadMcpTools(mcpConfigs, elicitationPrompterFor)`를 호출해 `mcpTools`/`mcpClients`를 `Features`에 싣는다(`:605-606`). CLI는 종료 시 `mcpClients`를 stop한다. supervisor 와이어는 정확히 이 지점.

---

## 3. Goals / Non-goals

### Goals
- MCP 서버 크래시(transport exit)를 감지하고 **자동 재시작**(re-spawn → re-`initialize` → re-`tools/list`)한다.
- **2단계 capped-exponential + full-jitter backoff**(Cursor 모델): fast-retry → 소진 시 periodic-retry.
- **stability threshold**로 flapping을 방지(재시작 후 안정 지속 시 attempt 리셋).
- **restart storm cap**: fast `maxFastAttempts` + periodic `maxPeriodicCycles` 초과 시 영구 give-up(오늘 동작으로 fallback).
- 재시작 동안 들어온 tool 호출의 **명확한 정책**(fail-fast 기본, 선택적 짧은 queue).
- 재시작 후 **tool 이름 안정성** 보장(`mcp__<server>__<tool>` 동일).
- **Default-OFF**: supervisor 미주입 시 §2 동작 byte-identical, 신규 테스트로 봉인.
- 모든 타이밍은 **주입된 clock/timer**로 — 테스트에 실제 timer 0개.

### Non-goals
- Cursor의 Electron **UtilityProcess** 프로세스 격리 재구현 ❌ (§1.4). quanta 기존 spawn/`@/plugin-isolation` 격리 재사용.
- 원격 동적 config(Statsig `mcp_reconnect_config`, `refreshReconnectConfig`) ❌. per-server **정적** config만.
- health-probe / degraded-probe 능동 polling(`getMaxDegradedProbeFailures`, `probeConnection`) ❌ (1차 범위 밖; §8 후속). 1차는 **passive crash-driven** 재시작만.
- OAuth re-auth lifecycle(`registerLifecycleOAuthProviderFactory`) ❌.
- HTTP-SSE transport 재연결 시맨틱 미세조정 ❌(supervisor는 transport-agnostic하게 `client.start()`만 재호출; stdio가 1차 타깃).

---

## 4. 설계

### 4.1 핵심 아이디어 — indirection을 통한 client 교체

문제(§2.2)는 tool이 client 인스턴스를 직접 캡처하는 것. 해결: tool이 **client를 직접 잡지 않고 supervisor가 제공하는 "현재 살아있는 client getter"**를 잡는다. 재시작은 내부 client 인스턴스를 교체하고, getter는 항상 최신을 돌려준다.

이를 위해 `McpClient`/`IsolatedMcpClient`가 공유하는 **structural 포트**를 정의한다(둘은 이미 동일 public surface: `start`/`listTools`/`callTool`/`stop`).

```ts
// src/mcp/reconnect/port.ts
/** McpClient / IsolatedMcpClient가 둘 다 만족하는 structural surface.
 *  supervisor는 이 포트만 안다 — 구체 client에 의존하지 않는다(DIP). */
export interface SupervisableMcpClient {
  start(): Promise<void>
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: unknown): Promise<McpCallResult>
  stop(): Promise<void>
  /** transport-exit 1회 통지. 둘 다 현재는 없으므로 §5에서 client에 1줄 추가
   *  (default-OFF: 핸들러 미등록이면 no-op). */
  onExit(handler: (reason?: string) => void): () => void
}

/** supervisor가 새 client 인스턴스를 만드는 팩토리(test seam + 격리 client 지원). */
export type McpClientFactory = (config: McpServerConfig) => SupervisableMcpClient
```

> `onExit`는 `McpClient`에 **이미 내부적으로 존재**(`client.ts:178` transport.onExit 구독)하지만 public이 아니다. §5에서 외부 구독 1개를 fan-out하는 public `onExit`를 추가한다(미사용 시 byte-identical).

### 4.2 backoff policy 타입

```ts
// src/mcp/reconnect/policy.ts
export interface BackoffPolicy {
  readonly fastRetryBaseMs: number   // Cursor Dv = 5_000
  readonly fastRetryMaxMs: number    // Cursor Nv = 60_000
  readonly periodicBaseMs: number    // Cursor Fv = 300_000
  readonly periodicMaxMs: number     // Cursor Uv = 1_800_000
  readonly maxFastAttempts: number   // fast 단계 시도수 (Cursor getFastRetryMaxAttempts), 기본 5
  readonly maxPeriodicCycles: number // periodic 사이클 cap (getMaxPeriodicCycles), 기본 5
  readonly stabilityThresholdMs: number // 안정 지속시 attempt 리셋 (getStabilityThresholdMs), 기본 60_000
}

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  fastRetryBaseMs: 5_000,
  fastRetryMaxMs: 60_000,
  periodicBaseMs: 300_000,
  periodicMaxMs: 1_800_000,
  maxFastAttempts: 5,
  maxPeriodicCycles: 5,
  stabilityThresholdMs: 60_000,
}

/** Cursor Fd 흡수: capped exponential + full-jitter. random은 주입(테스트 결정성). */
export const backoffDelay = (
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number => {
  const capped = Math.min(baseMs * 2 ** attempt, maxMs)
  return capped <= baseMs ? baseMs : baseMs + random() * (capped - baseMs)
}
```

`backoffDelay`는 `Fd`와 정확히 동일하되 `random`을 주입 가능(테스트는 `() => 0` 또는 `() => 0.5` 고정). `attempt=0` ⇒ 정확히 `baseMs`(jitter 없음) — Cursor와 byte-identical.

### 4.3 상태 머신

```
                 start() 성공
   (init) ─────────────────────────────▶  HEALTHY
                                              │ onExit(crash)
                                              ▼
                                           CRASHED
                                              │ schedule(delay = backoff)
                                              ▼
                                         BACKING_OFF ──(timer fired)──▶ RESTARTING
                                              ▲                              │
                              start() 실패하고  │                start() 성공 │ start() 실패
                              아직 cap 미만이면 │                              ▼     │
                                              └──────────────────────────HEALTHY    │
                                                                            │        │
                              stabilityThresholdMs 무사고 ⇒ attempt 리셋 ◀──┘        │
                                                                                     ▼
                                                cap 초과(maxFastAttempts 후
                                                periodic도 maxPeriodicCycles 초과)
                                                            │
                                                            ▼
                                                        DEGRADED (영구 give-up)
```

- **HEALTHY**: 정상. tool 호출 통과.
- **CRASHED**: onExit 수신 직후 1 tick. pending은 이미 client가 fail시킴(§2.1). 즉시 BACKING_OFF로.
- **BACKING_OFF**: `backoffDelay`로 계산한 지연만큼 타이머 대기. attempt < maxFastAttempts면 fast base/max, 그 이후엔 periodic base/max + periodicCycle 카운트.
- **RESTARTING**: 새 client 인스턴스 생성 → `start()`(initialize) → `listTools()`. 성공 ⇒ HEALTHY로, 내부 client 참조 교체, `restartedAt` 기록. 실패 ⇒ attempt++ 후 BACKING_OFF.
- **DEGRADED**: maxFastAttempts + maxPeriodicCycles 모두 소진. 영구 give-up. 이후 tool 호출은 §2.1과 **동일한** `McpError("…is not running")` (byte-identical 실패 메시지로 fallback). 더 이상 타이머 없음.

**stability reset**: RESTARTING→HEALTHY 전이 후 `stabilityThresholdMs` 동안 다음 onExit가 없으면 `attempt`/`periodicCycle`을 0으로 리셋(다음 크래시는 fresh fast-retry). 구현은 타이머가 아니라 **다음 crash 시점에 `now() - restartedAt >= stabilityThresholdMs` 비교**로 — lazy, 추가 타이머 불필요.

### 4.4 Supervisor (closed-port)

```ts
// src/mcp/reconnect/supervisor.ts
export interface SupervisorDeps {
  readonly factory: McpClientFactory          // 새 client 인스턴스 생성
  readonly policy: BackoffPolicy              // §4.2
  readonly now: () => number                  // 주입 clock (idiom: connectors/types.ts ClockPort)
  readonly setTimer: (fn: () => void, ms: number) => () => void  // 주입 timer; cancel 반환
  readonly random?: () => number              // jitter 소스 (default Math.random)
  readonly onStateChange?: (s: SupervisorSnapshot) => void       // 관찰(로그/pill), 부작용 없음
  readonly pendingPolicy?: "fail-fast" | "queue"  // 재시작 중 호출 정책 (default "fail-fast")
  readonly queueWaitMaxMs?: number            // "queue" 모드에서 client 대기 상한 (default 0 = fail-fast와 동일)
}

export interface SupervisorSnapshot {
  readonly serverName: string
  readonly state: "healthy" | "crashed" | "backing-off" | "restarting" | "degraded"
  readonly fastAttempt: number
  readonly periodicCycle: number
  readonly restartEpoch: number               // Cursor connectionGeneration 흡수: stale guard
  readonly lastDiagnostic?: string            // Cursor lastStartupDiagnostic 흡수
  readonly nextRetryInMs?: number
}

export class McpReconnectSupervisor {
  static async create(config: McpServerConfig, deps: SupervisorDeps): Promise<McpReconnectSupervisor>
  /** 항상 "현재 살아있는" client. DEGRADED면 마지막 죽은 client(ensureReady가 동일 에러). */
  current(): SupervisableMcpClient
  /** indirection 진입점. 내부적으로 current()로 위임하되 pendingPolicy 적용. */
  callTool(name: string, args: unknown): Promise<McpCallResult>
  listTools(): Promise<McpToolDef[]>
  snapshot(): SupervisorSnapshot
  /** 영구 정지. 진행중 타이머 취소 + 내부 client.stop(). 멱등. */
  stop(): Promise<void>
}
```

- **globals 없음**, **slice-fenced `@/...` import**만, `now`/`setTimer`/`random` 모두 주입.
- `setTimer`는 cancel 함수를 반환 → BACKING_OFF 중 `stop()` 시 즉시 타이머 해제(누수 0).
- `restartEpoch`: 재시작마다 ++. RESTARTING의 비동기 `start()`가 끝났을 때 epoch가 바뀌었으면(중간에 `stop()` 호출) 결과를 폐기 — Cursor `isCurrentConnectionGeneration` 흡수.

### 4.5 재시작 중 pending tool 호출 정책

- **fail-fast (기본)**: 상태 ≠ HEALTHY면 즉시 §2.1과 동일 `McpError("…is not running")` 반환. 모델이 자연스레 재시도/우회. **오늘 사용자가 보는 메시지와 동일** ⇒ default-OFF 미주입 시뿐 아니라 supervisor 켜도 메시지 호환.
- **queue (opt-in)**: `pendingPolicy:"queue"` + `queueWaitMaxMs>0`이면, 호출이 HEALTHY 복귀를 최대 `queueWaitMaxMs`만큼 대기(`now`/`setTimer` 기반). 복귀 시 새 client로 진행, 초과 시 fail-fast. **DEGRADED면 대기 없이 즉시 실패**(무한 대기 방지). 1차에서는 코드만 넣고 default는 fail-fast(보수적).

> queue는 멱등성에 주의: tool/call은 일반적으로 non-idempotent. 따라서 queue는 "아직 호출을 보내기 전" 단계에서만 대기하고, 한 번 wire로 나간 호출은 재시도하지 않는다(at-most-once). 이미 보낸 호출은 client가 fail시킨다(§2.1).

---

## 5. `McpClient`/`IsolatedMcpClient` 최소 변경 (public `onExit`)

supervisor가 크래시를 감지하려면 client가 exit를 외부에 통지해야 한다. 현재 `onTransportExit`(`client.ts:354`)는 내부 전용.

추가(둘 다):

```ts
// client.ts — 신규 필드 + public 메서드
private readonly exitHandlers = new Set<(reason?: string) => void>()
onExit(handler: (reason?: string) => void): () => void {
  this.exitHandlers.add(handler)
  return () => this.exitHandlers.delete(handler)
}
// onTransportExit 안에서 fan-out 1줄 추가:
private onTransportExit(): void {
  this.exited = true
  this.failAllPending(new McpError(`mcp server "${this.config.name}" exited`))
  for (const h of this.exitHandlers) h("transport exit")   // <- 신규. 핸들러 0개면 no-op.
}
```

**byte-identical 보장**: 핸들러가 0개면(= supervisor 미주입) 루프는 아무것도 안 한다. `failAllPending` 호출 순서/메시지 불변. `IsolatedMcpClient`도 동일 패턴(현재 transport-exit 통지가 없으므로 `PluginHost` proc-exit 훅에 동일 fan-out 추가; 미사용 시 no-op).

---

## 6. 통합 (wire)

### 6.1 bridge — client 대신 supervisor를 캡처

`mcp-bridge.ts`의 `mcpToolToTool`를 supervisor-aware 오버로드로:

```ts
// 신규: supervisor를 받는 변형. 기존 시그니처는 그대로 유지(byte-identical).
export const mcpToolToToolSupervised = (
  sup: McpReconnectSupervisor, def: McpToolDef, serverName: string,
): Tool => ({
  name: mcpToolName(serverName, def.name),
  ...
  async *execute(input, _ctx) {
    yield { type: "progress", message: `calling ${serverName} tool ${def.name}` }
    try {
      const res = await sup.callTool(def.name, input)   // indirection: 항상 살아있는 client
      yield { type: "result", result: { ok: res.ok, output: res.content } }
    } catch (e) {
      yield { type: "result", result: { ok: false, output: isMcpError(e) ? e.message : errMessage(e) } }
    }
  },
})
```

`loadMcpTools`에 **opt-in** 옵션 추가:

```ts
export interface LoadMcpToolsOpts {
  transportFor?: (config: McpServerConfig) => McpClientTransport
  /** 주입 시 각 서버를 supervisor로 감싸고 자동 재시작 활성화. 미주입 ⇒ 오늘 경로. */
  supervisorDepsFor?: (config: McpServerConfig) => SupervisorDeps
}
```

`supervisorDepsFor`가 있으면 서버별로 `McpReconnectSupervisor.create(config, deps)` → `sup.listTools()` → `mcpToolToToolSupervised(sup, def, …)`. 없으면 **기존 코드 경로 그대로**(`mcp-bridge.ts:146-167` 무변경 분기). 반환 타입은 `clients: McpClient[]` 호환을 위해 supervisor 모드에서는 `sup.current()`를 stop 대상으로 노출하거나, `Features`에 `mcpSupervisors`를 별도로 싣는다(§6.2).

### 6.2 CLI wire (`internal.ts:635`)

```ts
const supervisorDepsFor = mcpAutoRestartEnabled()   // QUANTA_MCP_AUTORESTART=1
  ? (config: McpServerConfig): SupervisorDeps => ({
      factory: (c) => new McpClient(c, clientOptsFor(c)),  // 또는 isolated when MCP_USE_ISOLATED_SPAWN
      policy: DEFAULT_BACKOFF_POLICY,
      now: () => Date.now(),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
      onStateChange: (s) => slog.info("mcp.supervisor.state", { server: s.serverName, state: s.state }),
    })
  : undefined
const { tools, clients } = await loadMcpTools(mcpConfigs, elicitationPrompterFor, { supervisorDepsFor })
```

`QUANTA_MCP_AUTORESTART` 미설정 ⇒ `supervisorDepsFor === undefined` ⇒ `loadMcpTools`가 기존 분기 ⇒ **byte-identical**. (env 헬퍼는 `isolatedMcpEnabledFromEnv` 패턴 그대로.)

### 6.3 재시작 후 initialize/tools-list + tool 이름 안정성

RESTARTING은 새 client에 `start()`(= `initialize` + `notifications/initialized`, `client.ts:181-189`) → `listTools()`를 다시 돈다. tool 이름은 `mcpToolName(serverName, def.name)`(`mcp-bridge.ts:37`)로 **`def.name`과 `serverName`만의 함수**이므로, 동일 서버가 동일 tool을 다시 advertise하면 이름은 byte-identical.

- **tool 집합이 바뀐 경우**(재시작 후 서버가 다른 tool 목록): 1차 범위에서는 **최초 로드 시점의 tool 집합을 고정**한다(레지스트리는 세션 시작 시 1회 구성, `internal.ts`). 재시작으로 사라진 tool 호출은 fail(서버가 `-32601` 또는 unknown). 동적 tool 재등록(`onToolsChanged`, Cursor `_onToolsChanged`)은 §8 후속. 이로써 tool 이름/스키마 안정성이 보장되고 레지스트리 mutation 위험이 없다.

---

## 7. Edge cases

| 케이스 | 처리 |
|---|---|
| **restart storm** | fast `maxFastAttempts`(5) 소진 → periodic 단계 진입, periodic `maxPeriodicCycles`(5) 소진 → **DEGRADED 영구 정지**. 타이머 더 안 검. |
| **startup에서 즉사하는 서버** | 첫 `start()` 실패도 RESTARTING 실패로 취급 → backoff 재시도. maxFastAttempts 후 give-up. (단, **최초 로드 시 첫 start 실패**는 오늘처럼 그 서버 skip하되 supervisor를 DEGRADED로 만들 수도, 혹은 backoff 재시도를 시작할 수도 — 정책: supervisor 모드에서는 backoff 재시도 시작. default-OFF 모드는 오늘대로 skip.) |
| **재시작 중 in-flight elicitation** | client 크래시 시 transport exit ⇒ inbound elicitation 핸들러도 같이 죽음. 새 client는 fresh `elicitationPrompter`로 시작(supervisor `factory`가 재구성). 진행중 lease는 client와 함께 소멸 — 새 elicitation은 새 client에서 새 lease. 이중 prompt 없음(죽은 client는 더 이상 inbound 안 받음). |
| **멱등성** | tool/call은 non-idempotent. queue 모드도 "wire로 나가기 전"만 대기(at-most-once, §4.5). 이미 보낸 호출은 재전송 안 함. |
| **stop() 도중 재시작 레이스** | `restartEpoch` stale guard(§4.4): `stop()`은 epoch++ + 타이머 cancel. RESTARTING의 비동기 `start()`가 늦게 끝나면 epoch 불일치로 결과 폐기 + 새 client 즉시 stop. |
| **stability flapping** | 재시작 직후 `stabilityThresholdMs` 내 재크래시면 attempt 누적(공격적 backoff 유지). 임계 넘겨 안정되면 다음 크래시는 attempt=0 리셋. |
| **clock 역행/jitter=1.0** | `backoffDelay`는 `random() ∈ [0,1)` 가정; clamp로 `[base, max]` 벗어나지 않음. `now` 역행 시 stability 비교는 `>=`라 안전(false negative만, 무한 대기 없음). |

---

## 8. 후속(이번 RFC 밖)
- **active health-probe**(Cursor `getMaxDegradedProbeFailures`/`probeConnection`): DEGRADED 진입 전 ping. ROI: 좀비 서버(프로세스는 살아있으나 응답 없음) 감지. 비용: probe 메서드 정의 필요.
- **동적 tool 재등록**(`onToolsChanged`): 재시작 후 tool 집합 변경 반영. ROI: tool 추가하는 서버. 비용: 레지스트리 mutation 경로 — 신중.
- **원격 동적 config**: non-goal 유지(우리는 정적 config 철학).

---

## 9. 테스트 계획 (hellgate, 주입 clock — 실제 timer 0개)

신규: `src/mcp/reconnect/__tests__/supervisor.hellgate.test.ts`, `policy.hellgate.test.ts`.

가상 시계 + 가상 timer 헬퍼(idiom: `connectors/__tests__/rest-registry-outage-hellgate.test.ts:63`):

```ts
const makeClock = () => { let now = 0; const timers: Array<{at:number;fn:()=>void}> = []
  return {
    now: () => now,
    setTimer: (fn:()=>void, ms:number) => { const e={at:now+ms,fn}; timers.push(e); return ()=>{const i=timers.indexOf(e); if(i>=0)timers.splice(i,1)} },
    advance: (ms:number) => { now+=ms; for (const e of timers.filter(t=>t.at<=now).sort((a,b)=>a.at-b.at)){ const i=timers.indexOf(e); if(i>=0){timers.splice(i,1); e.fn()} } },
  } }
```

1. **crash → restart → tool works again**: fake client가 1회 onExit 발화 → `advance(fastRetryBaseMs)` → factory가 새 client 반환 → `callTool` 성공. state: healthy→crashed→backing-off→restarting→healthy 전이 검증.
2. **backoff 타이밍(jitter 주입)**: `random:()=>0` ⇒ delay 정확히 `base*2^attempt` clamp 값. `random:()=>0.999…` ⇒ 상한 근처. attempt별 delay가 `backoffDelay`와 일치(=Cursor `Fd` 동치). `advance(delay-1)`로는 재시작 안 됨, `advance(delay)`로 됨.
3. **storm cap → give-up**: factory가 항상 `start()` throw. maxFastAttempts + maxPeriodicCycles 만큼 advance 반복 후 state=DEGRADED. 이후 advance 무한히 해도 factory 호출 안 늘어남(타이머 0).
4. **startup 즉사 서버**: 첫 `start()`부터 실패 → backoff 재시도 → cap 후 DEGRADED. tool 호출은 오늘과 **동일 메시지** `…is not running`.
5. **stability reset**: 재시작 성공 후 `advance(stabilityThresholdMs)` → 재크래시 시 attempt=0(fast base 지연). vs `advance(stabilityThresholdMs-1)` 후 재크래시 → attempt 누적(더 긴 지연).
6. **stop during backing-off**: BACKING_OFF 중 `stop()` → 타이머 cancel(advance해도 재시작 안 함) + client.stop 호출. epoch stale guard로 늦은 start 결과 폐기.
7. **queue 모드**: `pendingPolicy:"queue", queueWaitMaxMs:N`. 재시작 중 `callTool`이 HEALTHY 복귀까지 대기 후 성공; `queueWaitMaxMs` 초과 시 fail-fast. DEGRADED면 즉시 실패(무한 대기 없음).
8. **DEFAULT-OFF byte-identical 회귀**: `loadMcpTools(servers, undefined)` 및 `supervisorDepsFor` 미주입 → tool 집합/이름/스키마, 크래시 후 `McpError` 메시지가 §2와 **완전 동일**. `onExit` 핸들러 0개일 때 `onTransportExit`가 기존과 동일 부작용만 일으킴(snapshot 비교).
9. **policy clamp**: `backoffDelay(0, base, max)` === base(jitter 없음, Cursor 동치). `Ds`-류 clamp가 비정상 config(음수/max<base)에서도 `[base,max]` 안에 머무름.

---

## 10. 파일별 변경 목록

### 신규
| 파일 | 내용 |
|---|---|
| `src/mcp/reconnect/port.ts` | `SupervisableMcpClient`, `McpClientFactory` |
| `src/mcp/reconnect/policy.ts` | `BackoffPolicy`, `DEFAULT_BACKOFF_POLICY`, `backoffDelay` (Cursor `Fd` 흡수) |
| `src/mcp/reconnect/supervisor.ts` | `McpReconnectSupervisor`, `SupervisorDeps`, `SupervisorSnapshot`, 상태머신 |
| `src/mcp/reconnect/index.ts` | leaf barrel (selective re-export) |
| `src/mcp/reconnect/__tests__/supervisor.hellgate.test.ts` | §9 1–8 |
| `src/mcp/reconnect/__tests__/policy.hellgate.test.ts` | §9 2,9 |
| `docs/decisions/0435-mcp-auto-restart-supervisor.md` | ADR |

### 편집
| 파일 | 변경 |
|---|---|
| `src/mcp/client.ts` | public `onExit` + `onTransportExit` fan-out 1줄 (§5). 미사용 시 byte-identical. |
| `src/mcp/isolated-client.ts` | 동일 패턴 public `onExit` (proc-exit 훅). |
| `src/mcp/index.ts` | reconnect barrel 항목 selective export 추가. |
| `src/agent/mcp-bridge.ts` | `mcpToolToToolSupervised`, `LoadMcpToolsOpts.supervisorDepsFor`, `loadMcpTools` opt-in 분기. 미주입 분기 무변경. |
| `src/apps/cli/internal.ts` | `mcpAutoRestartEnabled()` env 헬퍼 + `supervisorDepsFor` 구성 → `loadMcpTools` 전달. `Features`에 `mcpSupervisors?` 추가(stop 대상). |

### slice fence
- `@/mcp/reconnect`는 `@/mcp`(types, client) + `@/shared`만 import. `@/agent`/`@/tool` import 금지(기존 mcp slice 규칙).
- bridge(`@/agent`)만 supervisor + tool을 조립(assembler 역할, `mcp-bridge.ts:20-26` 주석의 slice 규칙 그대로).

---

## 11. 대략 공수
- `policy.ts` + 테스트: 0.5d (순수 함수, Cursor 직접 흡수).
- `port.ts` + `client.ts`/`isolated-client.ts` `onExit`: 0.5d.
- `supervisor.ts` 상태머신 + hellgate: 1.5d (핵심 위험 — 상태/epoch/타이머 누수).
- bridge + CLI wire + default-OFF 회귀: 0.5d.
- **합계 ~3d** (1 worktree-isolated agent, hellgate-first TDD).

---

## 12. SOTA++ 체크리스트
- [x] closed-port (`SupervisableMcpClient`, `McpClientFactory`, `SupervisorDeps` 전부 주입)
- [x] no globals — `now`/`setTimer`/`random` 주입, 실제 timer는 CLI wire에서만
- [x] default-OFF byte-identical (§5 fan-out no-op, §6.2 env gate, §9-8 회귀)
- [x] Cursor 알고리즘 정확 흡수 (capped-exp + full-jitter `Fd`, 2-phase, stability, epoch guard)
- [x] non-idempotent tool 안전(at-most-once, §4.5)
- [x] slice-fenced `@/...` import, assembler는 `@/agent`만
- [x] 기존 idiom 준수(`ClockPort` now-injection, `isolatedMcpEnabledFromEnv` env-gate, hellgate fake-clock)
