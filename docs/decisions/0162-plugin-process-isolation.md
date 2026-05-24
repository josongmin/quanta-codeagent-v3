# ADR-0162: Plugin process isolation — DXT UtilityProcess pattern (5s spawn timeout + 5s SIGTERM grace)

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0039 (plugin manifest — `.quanta-plugin/`), ADR-0007 (MCP stdio client), ADR-0136 (OS sandbox helper — orthogonal process boundary), ADR-0135 (permission-sandbox 2-layer), `KILL_GRACE_MS=2000` foundation in `src/runtime/guarded-spawn.ts`
- **SOTA 출처**: Claude DXT (Desktop Extension Toolkit) `UtilityProcess.fork({serviceName, stdio: pipe, allowLoadingUnsignedLibraries: true})` + `MessageChannelMain` pair + **5s spawn timeout** + **5s SIGTERM grace** → SIGKILL. v3 W11 흡수 (roadmap [[0130-extracted-source-absorption-roadmap]]).
- **참조**: `src/plugin-isolation/{types,bun-spawner,plugin-host,dxt-loader,lifecycle,index}.ts`, `src/mcp/isolated-client.ts`, `tests/unit/plugin-isolation-*-hellgate.test.ts`

## 맥락

ADR-0039 가 `.quanta-plugin/plugin.json` (manifest) + `.mcp.json` (MCP server) + `skills/*/SKILL.md` 3-leaf 레이아웃을 봉인했다. **manifest는 그대로 로드되지만**, MCP server / 외부 DXT 패키지를 띄울 때 우리는 `Bun.spawn(stdio:"pipe")` 한 줄짜리 lifecycle 만 가지고 있다 (`src/mcp/client.ts`):

| 축 | 오늘 quanta (McpClient) | Claude DXT UtilityProcess |
|---|---|---|
| 격리 프로세스 | ✅ child process | ✅ utility process |
| typed spawn port | ❌ `Bun.spawn` 직접 호출 | ✅ `UtilityProcess.fork({serviceName})` |
| serviceName 라벨 | ❌ (config.name 만) | ✅ OS-level 라벨 (Activity Monitor / ps) |
| spawn timeout | ❌ (request-level 만) | ✅ **5s** — 첫 message 전 timeout |
| SIGTERM grace | ✅ 2s (escalatingKill) | ✅ **5s** — DXT 표준 |
| MessageChannelMain | ❌ stdio JSON-RPC 한 채널 | ✅ paired channel (확장 가능) |
| auto-restart on crash | ❌ stop 단발 | ✅ N-attempt rolling window |
| heartbeat | ❌ 없음 | ✅ idle ping (dead-process detection) |
| `allowLoadingUnsignedLibraries` 옵트인 | ❌ | ✅ flag 명시 |

3rd-party plugin (특히 native bindings 또는 unsigned shared libraries 를 로드하는 DXT) 가 우리 process 안에서 crash 하면 `quanta` agent 전체가 죽는다. Claude DXT 의 패턴은 **외부 코드 = 별도 process**, 부모는 typed RPC 로만 통신.

우리는 이 **PATTERN 을 흡수**한다. Phase 1 = typed `IsolatedProcessSpawnerPort` + `Bun.spawn`-기반 adapter (UtilityProcess 는 Electron 전용; Bun + stdio + line-framed JSON-RPC envelope 으로 동일 contract 봉인) + 5s spawn timeout + 5s SIGTERM grace + auto-restart + heartbeat + DXT loader stub + MCP backward-compat (opt-in `MCP_USE_ISOLATED_SPAWN=1`).

**`src/runtime/guarded-spawn.ts` 의 2s `KILL_GRACE_MS` foundation 은 건드리지 않는다** — shell tool / sandbox 의 byte-identical 계약. Plugin isolation 은 **위에 쌓는** layer 로, 자체적인 5s grace 를 갖는다 (DXT 표준).

## 결정

신규 plane-clean slice `src/plugin-isolation/` (5 modules + barrel) + MCP integration adapter 1 개:

### 1. `types.ts` — port + handle 인터페이스

```ts
export interface IsolatedProcess {
  readonly pid: number
  readonly serviceName: string
  send(msg: unknown): void
  onMessage(handler: (msg: unknown) => void): () => void  // unsubscribe
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>
  readonly exitPromise: Promise<{ code: number | null; signal: string | null }>
}

export interface SpawnOpts {
  readonly entry: string
  readonly args?: ReadonlyArray<string>
  readonly serviceName: string
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly allowLoadingUnsignedLibraries?: boolean
  readonly spawnTimeoutMs?: number            // default DEFAULT_SPAWN_TIMEOUT_MS (5000)
  readonly gracefulKillMs?: number            // default DEFAULT_GRACEFUL_KILL_MS (5000)
  readonly signal?: AbortSignal
}

export interface IsolatedProcessSpawnerPort {
  spawn(opts: SpawnOpts): Promise<IsolatedProcess>
}

export const DEFAULT_SPAWN_TIMEOUT_MS = 5_000
export const DEFAULT_GRACEFUL_KILL_MS = 5_000   // DXT 표준 (runtime/guarded-spawn KILL_GRACE_MS=2s 와 별개)
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024   // 10MB single-line cap
```

`spawn` 은 **첫 ready-marker (stdout 첫 line, NUL-byte free, ≤MAX_MESSAGE_BYTES)** 를 받으면 resolve. Timeout 이 먼저 fire 하면 child kill + reject. **NO-THROW after handle returned** — handle 의 `send` / `onMessage` 는 process exit 후 noop / unsubscribe.

### 2. `bun-spawner.ts` — `Bun.spawn` adapter

UtilityProcess 는 Electron 전용. 우리 surface (CLI + Bun) 에서는 `Bun.spawn({stdio:"pipe"})` + stdout line-framed JSON envelope 로 동일 contract 제공:

- `serviceName` 은 `QUANTA_SERVICE_NAME` env var 로 child 에 전달 (외부에서 ps 로 식별 가능)
- `allowLoadingUnsignedLibraries: true` 일 때 `QUANTA_ALLOW_UNSIGNED=1` env 추가 (child 가 native bindings load 시 환경 검사)
- env: PATH 자동 + caller env merge (host secret 자동 inherit 안 함, McpClient 와 동일 posture)
- spawn timeout: child 가 첫 ready line (`\n` 종결 NUL-free) 출력 전 5s 경과 → kill + reject `IsolatedSpawnTimeout`
- graceful kill: SIGTERM → 5s 후 child 미 exit 시 SIGKILL (자체 timer; runtime/guarded-spawn 의 2s grace 와 별개)
- message size: 10MB 초과 단일 line → drop + warn (DoS 방지)
- `onMessage` 는 unsubscribe closure 반환 (test 가 listener leak 안 함)

### 3. `plugin-host.ts` — JSON-RPC 2.0 wrapper

```ts
export class PluginHost {
  constructor(proc: IsolatedProcess, opts?: { defaultCallTimeoutMs?: number })
  call(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  notify(method: string, params?: unknown): void
  onNotification(method: string, handler: (params: unknown) => void): () => void
  stop(): Promise<void>   // SIGTERM → grace → SIGKILL; idempotent
}
```

- correlation: incrementing `id` (Map<id, {resolve, reject, timer}>)
- per-call timeout: default `DEFAULT_CALL_TIMEOUT_MS=30_000`
- abort: `AbortSignal` cancel → delete pending + reject `IsolatedCallAborted`
- duplicate id from child → reject + warn (typed `IsolatedDuplicateId`)
- corrupted JSON (non-object / missing jsonrpc) → drop + warn
- unknown method (notification 라우팅 miss) → warn (no throw)
- process exit → fail-all-pending

### 4. `dxt-loader.ts` — DXT manifest schema + launch

Strict Zod schema for `.dxt` manifest (Claude DXT subset):

```ts
export const DxtManifestSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  version: z.string().min(1),
  entry: z.string().min(1),                    // relative path within .dxt root
  serviceName: z.string().min(1).max(64),      // OS-visible label
  allowLoadingUnsignedLibraries: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict()

export const validateDxt: (manifestPath: string) => Promise<DxtManifest>
export const launchDxt: (manifestPath: string, port: IsolatedProcessSpawnerPort) => Promise<PluginHost>
```

- manifest > 1MB → typed error (`DxtManifestTooLarge`)
- unicode in serviceName 거부 (ASCII-only via regex)
- entry 가 manifest dir 밖으로 escape 시 reject (path traversal)

### 5. `lifecycle.ts` — auto-restart + heartbeat

```ts
export interface LifecyclePolicy {
  readonly maxRestarts: number             // default 3
  readonly restartWindowMs: number         // default 60_000
  readonly heartbeatIntervalMs: number     // default 10_000
  readonly heartbeatMissThreshold: number  // default 2 (= 20s silence → dead)
}

export class PluginLifecycleManager {
  constructor(spawner: IsolatedProcessSpawnerPort, factory: () => SpawnOpts, opts?: { policy?: Partial<LifecyclePolicy>; clock?: () => number })
  start(): Promise<PluginHost>
  stop(): Promise<void>
  readonly state: "starting" | "running" | "restarting" | "dead" | "stopped"
}
```

- rolling-window restart counter (clock-injected for test determinism)
- heartbeat = `ping`/`pong` JSON-RPC notification on `heartbeatIntervalMs` cadence
- 2 consecutive misses → child killed + restart attempt
- max restarts exceeded → state `"dead"` + permanent stop
- parent SIGTERM cascade: lifecycle `stop()` propagates SIGTERM to child host

### 6. `src/mcp/isolated-client.ts` — opt-in MCP integration

Default-OFF (`MCP_USE_ISOLATED_SPAWN=1` 명시 시만). 기존 `McpClient` (Bun.spawn 직접) 보존 — backward compat.

`IsolatedMcpClient` 동일 public surface (`start` / `listTools` / `callTool` / `stop`) 이지만 spawn 을 `IsolatedProcessSpawnerPort` 로 위임. 5s spawn timeout + 5s SIGTERM grace + lifecycle manager wire option.

### 디시플린

- **SRP**: spawner / host / dxt / lifecycle / mcp-integration 각 분리
- **OCP**: `IsolatedProcessSpawnerPort` pluggable (Bun ↔ Node `child_process` ↔ future Electron `UtilityProcess`)
- **DIP**: clock injected (lifecycle), spawner injected (lifecycle / dxt-loader), fs injected (dxt-loader)
- **closed-port**: 모든 외부 dep port; slice 외부에서는 barrel 만
- **Backward compat**: `src/runtime/guarded-spawn.ts` (2s grace) / `src/mcp/client.ts` (Bun.spawn 직접) 그대로
- **default-OFF**: `MCP_USE_ISOLATED_SPAWN=1` 명시 시만 활성

## 결과

- 신규 slice `src/plugin-isolation/` (5 modules + barrel)
- 신규 `src/mcp/isolated-client.ts` (opt-in adapter)
- 신규 hellgate × 5 (spawner / host / dxt-loader / lifecycle / mcp-integration) — 각 12+ 케이스
- 신규 unit × 5 (행복 경로 + 회귀 sealing)
- 신규 feature catalog yaml × 5 (`09-integration/`)

## Invariants preserved

1. `src/runtime/guarded-spawn.ts` `KILL_GRACE_MS=2000` 불변 (shell tool / sandbox byte-identical)
2. `src/mcp/client.ts` API + 동작 불변 (`MCP_USE_ISOLATED_SPAWN` 미설정 시 path 동일)
3. Plugin manifest (ADR-0039) layout 불변 — DXT 는 별도 manifest, `.quanta-plugin/` 와 공존
4. `byte-identical replay` (smoke battery, [[codex-absorption-complete]])
5. typed-envelope superset (`quanta.ipc.v1` 확장 호환)

## Tradeoffs

- **UtilityProcess vs Bun.spawn**: Electron `UtilityProcess` 는 V8 isolate + MessageChannelMain 진짜 격리. 우리는 OS process + stdio. 다음 단계 (desktop 진출) 에서 `IsolatedProcessSpawnerPort` impl 만 교체하면 됨 (OCP).
- **5s spawn / 5s grace는 magic number** — DXT 가 검증된 값이고 (Claude Desktop production), runtime/guarded-spawn 의 2s 와 의도적으로 다름 (외부 plugin 은 init 비용 큼). Named constant 로 박았으니 변경 1 곳.
- **heartbeat overhead**: 10s interval × JSON-RPC notification 2-side = 미세. opt-out 가능 (`heartbeatIntervalMs: 0`).
- **MessageChannelMain 부재**: Bun stdio 는 단일 channel. paired channel 이 필요한 경우 (audio + control 등) 는 stdio multiplex 로 우회. desktop 진출 후 UtilityProcess 어댑터로 자연스럽게 해결.

## Out of scope (deferred)

- **실제 Electron `UtilityProcess` 어댑터** — 데스크톱 surface 진출 후 (W11 Phase 2)
- **`MessageChannelMain` paired channel** — stdio multiplex 로 우회. desktop 진출 시 자연스럽게 해결
- **plugin allowlist DB** — [[0130-extracted-source-absorption-roadmap]] negative invariant 6: blocklist 메커니즘은 over-engineering. 본 ADR scope 밖.
- **plugin signing verification** — `allowLoadingUnsignedLibraries: false` 가 기본; codesign check 는 desktop 단계.

## References

- Memory: [[extracted-source-novel-findings-2026-05-24]] R6 "Claude DXT UtilityProcess + MessageChannelMain + 5s spawn timeout + 5s SIGTERM grace" entry
- Roadmap: [[0130-extracted-source-absorption-roadmap]] W11 entry
- Foundation: `src/runtime/guarded-spawn.ts` (2s grace — 본 ADR 의 5s grace 와 별개)
- Existing MCP: `src/mcp/client.ts` (이 ADR 후 보존; opt-in 으로 isolated 경로 추가)
