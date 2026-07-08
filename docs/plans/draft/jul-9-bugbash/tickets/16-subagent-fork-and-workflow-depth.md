# ALBB-16 — Subagent fork: live-WM `fork_turns`, 6-tool parity, workflow depth reset

**Priority:** P1
**Wave:** C
**Depends on:** ALBB-12 (registry)
**Owner:** `src/agent/tier1/subagent.ts`, `src/subagent/dispatch-6.ts`, `src/agent/workflow-agent-adapter.ts`
**Verdict:** keep — three defects share the fork / depth-accounting theme over the same owner files. Kept as ONE ticket (no merge target).
**Blast radius:** all three sit behind default-OFF opt-ins (`config.subagent` gated; `fork_turns` defaults `"none"`; `enableWorkflow` off by default) — so no live regression today, but #3 silently weakens the recursion bound the moment `enableWorkflow` is flipped.

## Goal

Absorb Codex `fork_turns(none | all | N)` faithfully (live working-memory, not the seed), give the 6-tool `spawn_agent` path the SAME fork inheritance the trio has, and stop the workflow adapter from resetting recursion depth to a constant `1`.

## Problem

### 1. `fork_turns` reads the SEED transcript, not live working-memory

`buildSubagentBlock` wires the trio's `forkPrompt` to close over `config.messages` — the session SEED array captured at block-build time, NOT the loop's live working-memory buffer. The code comment admits the gap outright.

`src/agent/tier1/subagent.ts:132-142`:
```ts
// GAP8a fork_turns — ... Sources
// `config.messages` (the session SEED transcript — same convention as the
// advisor's transcriptSource; the loop's live working-memory is a separate
// buffer). ...
forkPrompt: (prompt, spec) =>
  composeForkedPrompt(
    prompt,
    buildForkTurnsPreamble(config.messages ?? [], spec, redactTranscript),
  ),
```

`buildForkTurnsPreamble` / `selectForkTurns` (`src/agent/fork-turns.ts:27-53`) are pure and correct — they just get handed a STALE array. A child spawned mid-session with `fork_turns:"all"` or `fork_turns:N` inherits only the pre-session seed; every user/assistant turn accrued after the block was built is invisible. This is a **silent under-inheritance**, not an error — the preamble is byte-plausible, just missing the turns that matter.

The proven fix pattern already lives one slice over: the advisor threads a lazy live-transcript thunk, `transcriptSource?: () => readonly Message[]` (`src/agent/tier1/advisor.ts:140`), resolved at consult time in `resolveForwardHistory` (`advisor.ts:160-171`). `fork_turns` should mirror it exactly — no new abstraction.

### 2. 6-tool `spawn_agent` has ZERO fork inheritance

`forkPrompt` exists ONLY on the trio `createAgentTool` (`src/subagent/agent-tool.ts:187`, applied in `applyForkPromptIfNeeded` at `agent-tool.ts:419-422`, called `agent-tool.ts:467`). The 6-tool dispatch path never receives it:

- `Subagent6Deps` (`src/subagent/dispatch-6.ts:40-80`) has **no `forkPrompt` field**.
- `routeSpawnAgent` (`dispatch-6.ts:154-168`) forwards `runner/registry/maxDepth/parentDepth/maxConcurrent/agentMeta/cwd/requesterLineage` — but no fork composer.
- `handleSpawnAgent` builds the child request with the prompt RAW — `src/subagent/handlers-6.ts:643` `prompt: input.prompt` — no preamble composition anywhere in the handler.

So under `config.subagent.enable6Tools === true`, a `spawn_agent(fork_turns:"all")` call inherits nothing. The tool's own `fork_turns` input (if surfaced) is a silent no-op. This is a **feature-parity hole**, not a crash.

### 3. Workflow adapter hard-resets recursion depth to `1`

`workflowTools` stamps a CONSTANT depth on every workflow-launched child:

`src/agent/tier1/subagent.ts:91-96`:
```ts
createRunWorkflowTool({
  agentRun: subagentRunnerToAgentRunPort(runner, { depth: 1 }),
  ...
})
```

The adapter's own default is the same constant — `src/agent/workflow-agent-adapter.ts:42` `depth: options.depth ?? 1`. But the runner's recursion bound is `req.depth > maxDepth ⇒ deny` (`src/agent/subagent-runner.ts:743-745`), and a spawned child ITSELF carries `subagent` config forward (`subagent-runner.ts:688` `...(parent.subagent ? { subagent: parent.subagent } : {})`), so a deep child can create its own `run_workflow` tool. When it does, `subagentRunnerToAgentRunPort(runner, { depth: 1 })` **resets the accumulated depth to `1`**, regardless of how deep the parent already was. A nested-workflow spawn from a parent already at `maxDepth` therefore proceeds at depth `1` instead of being denied — the recursion bound is bypassable via the workflow tool.

Note the SAME file already threads real accumulated depth on the two sibling spawn paths:
- CSV: `subagent.ts:188` `buildInMemoryBatchRunPort(runner, config.depth ?? 0)`
- 6-tool: `subagent.ts:210` `...(config.depth !== undefined ? { parentDepth: config.depth } : {})` (⇒ `handlers-6.ts:549-550` `childDepth = parentDepth + 1`)

Only the workflow path is stuck on the constant. This is the **most consequential** of the three — it weakens a safety bound, not just a convenience feature.

> Ticket-drift note: earlier drafts cited the depth defect at `workflow-agent-adapter.ts:42`. That line is only the `?? 1` FALLBACK default; the load-bearing hardcode is the call site `tier1/subagent.ts:92`. Fix the call site; the adapter's `?? 1` fallback stays as-is (byte-identical when no depth is passed).

## Required changes

All three land **default-OFF / fail-closed**; efficacy of `fork_turns` itself is measure-first (A/B before flipping any default from `"none"`).

1. **`fork_turns` → live WM (fail-closed to seed).** Add a `transcriptSource?: () => readonly Message[]` option to `buildSubagentBlock`'s inputs (composition root injects the loop's live working-memory getter), mirroring `advisor.ts:140` verbatim. Have `forkPrompt` call it LAZILY at spawn time. Absent thunk ⇒ fall back to `config.messages ?? []` (byte-identical to today). No new selection logic — `buildForkTurnsPreamble` is unchanged; only its INPUT array becomes live.

2. **6-tool fork parity via ONE shared source.** Add `forkPrompt?: (prompt: string, spec: "none" | "all" | number) => string` to `Subagent6Deps` (`dispatch-6.ts:40`). Forward it in `routeSpawnAgent` (`dispatch-6.ts:154`) and compose the preamble in `handleSpawnAgent` before building the `SubagentRequest` (`handlers-6.ts:642`) — reading the parsed `input.fork_turns ?? "none"` exactly as the trio does. Inject the **SAME closure** the trio uses from `tier1/subagent.ts` (thread `forkPrompt` into `createSubagent6Tools` alongside the existing `parentDepth`). One shared `forkPrompt` origin ⇒ the trio and 6-tool preambles are byte-identical by construction — no divergent second implementation. Absent ⇒ raw prompt (byte-identical legacy).

3. **Workflow depth = accumulated + 1.** Change `tier1/subagent.ts:92` to `subagentRunnerToAgentRunPort(runner, { depth: (config.depth ?? 0) + 1 })`, matching the CSV (`:188`) and 6-tool (`:210`) siblings already in the same builder. The adapter's `?? 1` default is untouched (only relevant when a caller passes nothing). This makes a nested-workflow spawn from a deep parent hit the runner's `req.depth > maxDepth` deny instead of resetting to `1`.

## Acceptance

- Mid-session fork inherits turns accrued AFTER the seed (live WM), and with no thunk wired falls back to the seed byte-for-byte.
- A `spawn_agent(fork_turns)` under `enable6Tools` produces the inherited-context preamble, identical to the trio's for the same transcript+spec.
- A `run_workflow` `agent` step spawned from a parent at `config.depth = maxDepth` is DENIED (`"max subagent depth exceeded"`) instead of running at depth `1`.

## Proof rails

Behavioral / red-on-injection (each must go RED if the defect is reintroduced — no vacuous compile asserts):

1. **Depth-reset guard (new).** Extend `tests/unit/workflow/workflow-agent-adapter-hellgate.test.ts` (peer of the existing `depth + agentType + signal` case at line 51) with a `tier1/subagent.ts`-level test: build the block with `config.depth = maxDepth` and `config.subagent.enableWorkflow = true`, drive the minted `run_workflow` tool over a spy runner, and assert the runner receives `req.depth = maxDepth + 1` (⇒ its `subagent-runner.ts:743` deny fires and the step maps to `"max subagent depth exceeded"`). MUTATION: the current `{ depth: 1 }` impl must fail this (it would pass `1`).

2. **Live-WM fork (mutation over static seed).** New `tests/unit/subagent-fork-live-wm.test.ts` (or extend `tests/unit/fork-turns-hellgate.test.ts`): wire `buildSubagentBlock` with a mutable transcript array whose length GROWS after block build, spawn with `fork_turns:"all"`, and assert the child preamble contains a turn appended AFTER build. MUTATION: the static-`config.messages` impl must go RED (it omits the post-build turn). Add the fail-closed twin: no `transcriptSource` ⇒ preamble byte-identical to the seed-sourced one.

3. **6-tool parity (paired trio control).** New `tests/unit/subagent-6-fork-parity.test.ts` (peer of `tests/unit/subagent-6-tools-hellgate.test.ts`): dispatch `spawn_agent(fork_turns:"all")` through `dispatchSubagent6` with the shared `forkPrompt` wired, capture the child `SubagentRequest.prompt` at a spy runner, assert the inherited-context preamble is present; PAIR with a trio `createAgentTool` spawn over the SAME transcript+spec and assert the two child prompts are **byte-identical** (proves single shared source, not a divergent reimplementation). MUTATION: the current no-`forkPrompt`-in-`Subagent6Deps` impl must go RED (raw prompt, no preamble).

```sh
bun test tests/unit/workflow/workflow-agent-adapter-hellgate.test.ts
bun test tests/unit/fork-turns-hellgate.test.ts tests/unit/subagent-fork-live-wm.test.ts
bun test tests/unit/subagent-6-tools-hellgate.test.ts tests/unit/subagent-6-fork-parity.test.ts
bun test tests/integration/subagent-fork-e2e.test.ts
```
