# R05 integration-delta — APPLIED (W2-I, `29d7e4ff1`)

Status: **applied** on integrated source. Worker originally left host/barrel for I-stage. W2-I applied `src/side-agent/index.ts` and assembler timer ports. Event-bus for process-backed `trigger.kind === "event"` remains uninjected (`invalid-spec` without `events`).

## Barrel (`src/side-agent/index.ts`)

Optional public exports now live in owner files. Tests import them by path or via
existing `./process` re-exports. Integrator may add:

```ts
export { SIDE_AGENT_IPC_VERSION } from "./process" // already re-exported via process types
export {
  createDaemonEngine,
  normalizeRunnerResult,
  validateSideAgentSpec,
  type DaemonEngine,
  type PassOutcome,
} from "./control"
export type { CharterPassResult } from "./worker-charter-runner"
```

`SIDE_AGENT_IPC_VERSION` is already exported from `./process`, which the barrel
already re-exports. No required new barrel symbol for compilation of current
callers.

Do **not** re-export `worker-charter-runner` from the leaf barrel — it is the
child composition root (`@/agent`/`@/llm`/`@/tool`).

## Host assembler (`src/host/runtime/agent-config-assembler.ts`)

`createProcessSideAgentDaemonRegistry` now accepts optional:

- `setInterval` / `clearInterval` — cadence (interval trigger)
- `events` — event trigger (required for `trigger.kind === "event"`; missing
  source is `invalid-spec`, same as in-process)

Today the assembler only passes `fork`, `scheduler`, `now`, `workerModulePath`,
`parentDepth`, `cwd`. This worker defaults omitted timers to **global**
`setInterval`/`clearInterval` so interval re-wake works before I-stage. W2-I
should inject the same timer ports the in-process path already uses:

```ts
cfg.sideAgentDaemons = createProcessSideAgentDaemonRegistry({
  fork: nodeProcessForkPort,
  scheduler: { schedule: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  now: () => Date.now(),
  workerModulePath: sideAgentWorkerModulePath(),
  parentDepth: cfg.depth ?? 0,
  cwd: cfg.cwd,
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  // events: session event bus, if event-triggered process daemons are in product scope
})
```

`autoCharterOnReady` is false on the registry path (parent sends each charter).
Supervisor-direct (`createSupervisedProcessDaemon` without the registry) still
defaults `autoCharterOnReady: true` so existing supervisor hellgates stay green.

## `src/agent/side-agent-runner.ts`

No change required. `subagentRunnerToSidePass` still returns one finding or
`null`. The widened `SideAgentRunnerPort` return (`T | T[] | null`) accepts that.

## What this worker did NOT claim

- Host event-bus wiring for process-backed event triggers (I-stage / product
  decision). Without `events`, `spawn({ trigger: { kind: "event", ... } })`
  throws `invalid-spec`.
- Child LLM still emits at most one model finding per charter (multi-finding OS
  rail uses `QUANTA_SIDE_AGENT_TEST_MODE=multi`). Protocol allows N findings.
- `teamIdle` / `idleSince` remain in-process-only.
