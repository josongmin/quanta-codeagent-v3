# R05 receipt

Status: **implemented** (not verified by integrator)

Package: `@/side-agent` (`src/side-agent/`)
Findings: H-SA-02 (P1), H-SA-01 (P2)
HEAD: `16cabfde464e354a4c3e98f3b7ffbc6e57f1086f`
Worker: W2-A / R05
Worktree: `/Users/songmin/quanta-codeagent-v3-w2-r05`
Branch: `sep8-w2-r05`

## Findings

- **H-SA-02:** process backer ignored `spec.trigger` / `maxWakes` / `idleReapMs` and counted `wakesDone` per finding. Parent-owned `createDaemonEngine` now owns validate/arm/wake/bounds for both backers. Process `runPass` sends a versioned charter and awaits a wake terminal. `wakesDone` increments once per completed terminal (`findings` / `no_finding` / `failed`), never per finding, never on cancelled/child-death.
- **H-SA-01:** LLM null / import failure / throw no longer emit `runCharterPass(..., "pass returned no finding")`. Child emits `no_finding` (null miss, empty task) or `failed` (import/provider/throw). Failure is status, not a feed row. Silence is not decoded as a finding.

## Files changed

Source:

- `src/side-agent/control.ts` (new) — shared spec validation + wake engine
- `src/side-agent/registry.ts` — in-process backer is a `runPass` adapter
- `src/side-agent/process-registry.ts` — process backer uses the same engine; IPC waiter
- `src/side-agent/process.ts` — IPC `version`/`wakeId`; terminals; `autoCharterOnReady` (supervisor-direct default true); `send`/`onIpc`/`onChildExit`
- `src/side-agent/types.ts` — runner may return a list of findings for one wake
- `src/side-agent/worker-entry.mjs` — terminals; no synthetic finding
- `src/side-agent/worker-charter-runner.ts` — `CharterPassResult` (`finding` | `no_finding` | `failed`)

Tests:

- `tests/unit/side-agent-process-registry-hellgate.test.ts`
- `tests/integration/side-agent-process-os-fork-e2e.test.ts`
- `tests/integration/side-agent-process-llm-charter-e2e.test.ts`
- `tests/unit/sep8-remediation/r05/h-sa-control-contract.test.ts`
- `tests/integration/sep8-remediation/r05/h-sa-os-child-protocol.test.ts`

Artifacts:

- `docs/plans/sep-8-structural-remediation/work/R05/receipt.md`
- `docs/plans/sep-8-structural-remediation/work/R05/integration-delta.md`

Not edited: `src/side-agent/index.ts`, `src/host/**`, `src/agent/side-agent-runner.ts`, README/ACTIONS/WAVES/waves.json/verify-waves.mjs/W0.md.

## Removed path

- Process registry `state.wakes += 1` per finding
- One-shot charter-on-ready as the process *registry* cadence (supervisor-direct still one-shots)
- Child `pass returned no finding` synthetic finding / deterministic degrade on LLM miss
- Parent treating IPC silence as a finding

## Commands

```sh
bun test tests/unit/sep8-remediation/r05 tests/integration/sep8-remediation/r05 tests/unit/side-agent-process-registry-hellgate.test.ts
# → 38 pass, 0 fail

bun test tests/unit/side-agent-hellgate.test.ts tests/unit/side-agent-process-supervisor-hellgate.test.ts tests/integration/side-agent-process-os-fork-e2e.test.ts tests/integration/side-agent-ipc-kill-mid-result-e2e.test.ts tests/integration/side-agent-process-llm-charter-e2e.test.ts tests/integration/side-agent-process-wire-e2e.test.ts
# → pass

bunx @biomejs/biome check src/side-agent/{control,registry,process-registry,process,types,worker-charter-runner}.ts
# → clean

bun test tests/unit/god-code-ratchet.test.ts
# → pass (no 900–999 entrant; no allowlist raise)
```

Line counts: `registry.ts` 257, `process-registry.ts` 387, `control.ts` ~270. Not in the 900–999 cohort.

## RED → GREEN → mutation

RED (HEAD): process spawn did not validate spec; no interval re-wake; `wakesDone` followed finding count; LLM null emitted a finding.

GREEN: shared contract suite on both backers (invalid spec, repeated interval, maxWakes, idle reap, multi-finding one wake, no_finding empty feed, failed empty feed). OS fork of `worker-entry.mjs`: no_finding, throw/failed, multi-finding, late terminal ignored, stop clears timer.

Mutation that must stay RED:

- Restore `state.wakes += 1` per finding → r05 source + behavioral `wakesDone === 1` fail.
- Restore `"pass returned no finding"` in `worker-entry.mjs` → r05 source scan fail.
- Count cancelled/child-death as a completed wake that `supervisor.stop()`s at `maxWakes: 1` → ipc-kill registry `failed` wait times out.

## Remaining gap (I-delta)

See `integration-delta.md`. Host assembler still omits `setInterval`/`clearInterval`/`events`; process registry defaults to global timers so production interval re-wake works without I-stage. Barrel does not export `control.ts`. `autoCharterOnReady` default remains true for supervisor-direct tests.
