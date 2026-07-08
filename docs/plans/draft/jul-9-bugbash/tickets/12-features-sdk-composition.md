# ALBB-12 — Features composition: TaskRegistry SSOT + SDK optional-port parity

**Priority:** P1 (claim 1 — silent wrong tool output). Claims 2–3 are parity/observability.
**Wave:** C
**Depends on:** none
**Owner:** `src/agent/features.ts`, `src/agent/tier1/subagent-introspect.ts`, `src/agent/optional-ports.ts`, `src/sdk/embed.ts`, `src/sdk/run.ts`

## Goal

Make the per-session `TaskRegistry` a composition INVARIANT (not a wiring convention the
host is trusted to honor), close the SDK-embed optional-port parity gap, and make a lossy
event stream observable. Model the fix on how Claude Code / Codex treat the subagent task
table as a single session-owned handle threaded to every subagent tool.

## Problem (ground-truthed 2026-07-09)

### Claim 1 — split TaskRegistry silently empties `list_agents` / `followup_task`  (REAL, P1)

`buildSubagentBlock` mints the registry (`R1`) and returns it, but **never writes it back
onto `config.subagent.taskRegistry`**:

- `src/agent/tier1/subagent.ts:160` — `const reg = agentTool.registry` (the live R1 the
  trio + 6-tool set spawn into). It is returned as `SubagentBlock.taskRegistry` (`subagent.ts:269`)
  and surfaced by `buildSessionFeatures` as `taskRegistry: subagent?.taskRegistry`
  (`src/agent/features.ts:268`) — but it is **not** assigned back onto the *shared*
  `config.subagent` object that later blocks read.

The introspect block reads that config field and falls open to a FRESH empty registry:

- `src/agent/tier1/subagent-introspect.ts:39` —
  `const registry = sub.taskRegistry ?? new TaskRegistry()`

Because `buildSubagentIntrospectBlock` runs from the same `SESSION_FEATURE_BLOCKS` loop
(`features.ts:189`, driven at `features.ts:212`) that consumes the SAME `config`
`buildSubagentBlock` was handed (`features.ts:208`), the `?? new TaskRegistry()` fallback
fires **whenever the surface did not pre-seed `config.subagent.taskRegistry`** →
`list_agents` / `followup_task` observe an empty R2 while the agent tool spawns into R1.
Silent wrong output (an empty agent list), never a crash.

**Reachability is broad — not limited to "pills off":**

- CLI mainline: `taskRegistry` is allocated ONLY when
  `subagentForPills = pillsEnabled && !hideTasks && QUANTA_SUBAGENT !== undefined`
  (`src/apps/cli/repl/cli-feature-config.ts:111`, allocated at
  `src/apps/cli/repl/factories/lifecycle.ts:36`). Pills hidden, tasks-pill hidden, or the
  gate reaching `internal.ts:349` without the pill handle ⇒ **no taskRegistry** ⇒ split.
- **Every non-CLI surface that env-gates introspect via `wireSubagentToolGates`**
  (`src/agent/optional-ports.ts:596-623`): on `QUANTA_SUBAGENT_INTROSPECT=on` it sets
  `subagent.enableIntrospect = true` (`:609`) and mints an `AgentMetaRegistry` side-table
  (`:615-617`) — but it **never mints or threads a `taskRegistry`**. So daemon/ide/headless/
  bench/eval and the SDK all get the split by construction when they gate introspect on.

**Witness in the current suite:** the followup hellgate has to *manually* patch the registry
in to make the shared-registry assertion pass —
`tests/unit/subagent-knobs-wire-hellgate.test.ts:139-140`
(`;(wired as AgentConfig).subagent = { ...wired.subagent, taskRegistry: registry }`),
with the comment *"The introspect builder shares config.subagent.taskRegistry with the
trio/6-tool spawn path; wire one …"*. That manual patch is the split leaking through the
test seam: production `wireOptionalAgentPorts` does not do it.

### Claim 2 — SDK embed skips `wireOptionalAgentPorts` (REAL, parity)

`src/sdk/embed.ts:163-164` calls the assembler and loop directly with NO optional-port wire:

```ts
const cfg = assembleAgentConfig({ mode, base }, env)   // embed.ts:163
return runAgent(cfg)                                    // embed.ts:164
```

`wireOptionalAgentPorts` is the documented FINAL composition transform each surface must
run with its own env view (slice-boundary invariant, `src/agent/optional-ports.ts:93-99`).
Every other surface calls it (`src/apps/cli/index.ts:76`, agent mode-presets daemon/ide/
headless, bench/eval drivers — 15 non-test callsites). **Embed is the sole surface missing
it.** Consequence: `QUANTA_REFUSAL_FALLBACK`, the subagent tool-gates (batch/introspect/
followup), the closeout critic, fast-apply fallback/merge, and stream taps are all silently
inert for SDK consumers even when their env gates are on. `env` is already in scope at
`embed.ts:119` (`opts.env ?? process.env`).

### Claim 3 — `AgentRun.droppedEvents` unobservable (REAL, observability-only, minor)

`EventChannel.droppedEvents` increments on drop-oldest overflow (`src/sdk/run.ts:53`,
`:66`), but the `AgentRun` interface (`src/sdk/run.ts:31`) and the returned handle
(`src/sdk/run.ts:153-157`) expose ONLY `[Symbol.asyncIterator]` + `then`. A consumer whose
buffer overflows has no way to learn the stream was lossy — silent partial history.

## Required changes

### 1 — Fail-closed the shared registry at the seam (claim 1)

- **Write-back (in-place, minimal):** in `buildSessionFeatures`, right after
  `const subagent = buildSubagentBlock(config)` (`features.ts:208`) and BEFORE the
  `SESSION_FEATURE_BLOCKS` loop (`features.ts:212`), when `subagent?.taskRegistry` is
  present and `config.subagent` exists, assign
  `config.subagent.taskRegistry = subagent.taskRegistry`. `config.subagent` is the same
  object `buildSubagentIntrospectBlock` reads, so the introspect tools share R1 **by
  construction** — no host wiring required. Byte-identical when subagent is unconfigured
  (subagent undefined) or already pre-seeded (same instance).
- **Delete the fail-OPEN fallback:** remove `?? new TaskRegistry()` at
  `subagent-introspect.ts:39`. When `enableIntrospect`/`enableFollowup` is on but
  `sub.taskRegistry` is still absent (a genuinely split/mis-wired surface), **early-return
  `[]` with a once-per-process `logger.warn`** — mirroring `wireCloseoutCritic`'s
  no-reviewer warning posture at `optional-ports.ts:452-458`. A split registry becomes a
  VISIBLE fail-open no-op (tool not registered + one stderr line) instead of a silent empty
  list. This is the Claude Code / Codex baseline: the subagent task table is one
  session-owned handle; a builder that can't reach it does not silently fabricate a second.
- **Belt-and-suspenders for env-gated surfaces:** in `wireSubagentToolGates`
  (`optional-ports.ts:596`), when `wantIntrospect || wantFollowup` and
  `next.subagent.taskRegistry === undefined`, mint one shared `TaskRegistry` and thread it
  into `subagent` alongside the existing `AgentMetaRegistry` mint (`:615-617`), caller-wins
  (never overwrite a host-provided instance). This closes the split for daemon/ide/headless/
  bench/eval/SDK the same way `subagentAgentMeta` is already closed.

### 2 — SDK embed optional-port parity (claim 2)

- Call `wireOptionalAgentPorts(cfg, env)` on the ASSEMBLED cfg in `embed.ts`, between
  `assembleAgentConfig` (`:163`) and `runAgent` (`:164`), using embed's own env view
  (`env` from `embed.ts:119`). This matches the slice-boundary contract
  (`optional-ports.ts:93-99`) and gives SDK consumers the same env-gated ports every other
  surface has. **Measure-first / default-OFF:** with no `QUANTA_*` gate set, every gate in
  `wireOptionalAgentPorts` stays off ⇒ cfg is unchanged ⇒ embed is byte-identical to today.

### 3 — Observable dropped-event counter (claim 3)

- Add a `readonly droppedEvents: number` getter to the `AgentRun` interface
  (`run.ts:31`) and the returned handle (`run.ts:153-157`), delegating to
  `channel.droppedEvents` (narrowest fix). Optional follow-up: emit a single diagnostic
  `AgentEvent` the first time `droppedEvents` crosses 0 so a lossy stream is observable
  in-band, not only by polling.

## Acceptance

- With introspect on and NO host `taskRegistry`, `list_agents` reports the SAME task ids the
  `agent`/6-tool spawn path created (shared R1) — on the CLI mainline AND on any
  `wireSubagentToolGates` surface (SDK/daemon/…).
- A genuinely split surface (introspect on, registry unreachable) yields NO `list_agents`
  tool + exactly one stderr warning — a visible fail-open, not a silent empty list.
- `QUANTA_REFUSAL_FALLBACK=on` (and subagent gates) activate through the SDK embed path,
  parity with CLI/bench; unset gates ⇒ embed byte-identical.
- `AgentRun.droppedEvents` is readable on the returned handle.

## Proof rails (red-on-injection / behavioral — must FAIL if the defect returns)

- **Claim 1 — shared-registry-by-construction (new / extend
  `tests/unit/subagent-introspect-hellgate.test.ts`):** assemble a real config with
  `subagent` configured + `enableIntrospect`, run `buildSessionFeatures`, spawn one task via
  the `agent`/6-tool path, then drive the registered `list_agents` tool and assert it reports
  that task's id — WITHOUT pre-seeding `config.subagent.taskRegistry` (the current tests all
  pre-seed; this new one must NOT).
  *Injection:* if the write-back at `features.ts:208` is reverted (introspect builder falls
  to a fresh registry), `list_agents` returns `[]` and the assertion fails. Kill the manual
  patch at `tests/unit/subagent-knobs-wire-hellgate.test.ts:139-140` so the followup test
  proves the wire end-to-end instead of masking it.
- **Claim 1 — fail-closed visibility:** assert that with `enableIntrospect` on but the
  registry forcibly unreachable, `buildSubagentIntrospectBlock` returns `[]` (no
  `list_agents`) and `logger.warn` fired once. *Injection:* restoring `?? new TaskRegistry()`
  makes the block return a `list_agents` tool over an empty registry → assertion fails.
- **Claim 2 — embed optional-port parity (new
  `tests/unit/sdk/embed-optional-ports-parity.test.ts`, alongside
  `tests/unit/sdk/embed.test.ts`):** build via `createAnalysisAgent({ … env: {
  QUANTA_REFUSAL_FALLBACK: "on" }})` and assert the refusal-fallback port is present on the
  cfg the loop runs under (or its observable effect fires). *Injection:* removing the
  `wireOptionalAgentPorts` call in embed makes the port absent → assertion fails. Pair with a
  DEFAULT-OFF assertion: no env gates ⇒ cfg identical to the pre-wire assemble (byte-identical
  guard).
- **Claim 3:** overflow a tiny `eventBufferSize` embed run and assert
  `agentRun.droppedEvents > 0`. *Injection:* dropping the getter ⇒ `undefined`/type error.

```sh
bun test tests/unit/subagent-introspect-hellgate.test.ts
bun test tests/unit/subagent-knobs-wire-hellgate.test.ts
bun test tests/unit/sdk/embed.test.ts
bun test tests/unit/agent/optional-ports-wire.test.ts
bun test tests/unit/composition-root-gated-port-activation-r3-hellgate.test.ts
# new:
bun test tests/unit/sdk/embed-optional-ports-parity.test.ts
```
