# ALBB-11 — HITL admissibility production wiring (`allowlistEscalated` + ASM)

**Priority:** P2 (both defects are default-OFF inert-capability; no correctness or
security regression today — the live gate is byte-identical to legacy. Fix is a
UX/attribution activation, not a hole. Downgraded from P1.)
**Wave:** B
**Depends on:** none
**Owner (real seams, ground-truthed):**
- `src/apps/cli/repl/runtime-context-compose.ts` — `buildAdmissibility` (the SOLE
  live producer of the `config.admissibility` bundle) for the `allowlistEscalated` mint.
- `src/agent/dispatch.ts:395-400` — the gate-opts spread for ASM threading.
- NOT `session-bootstrap.ts` (the old owner line was wrong — bootstrap does not
  assemble the admissibility bundle).

## Goal

Activate the Round-4 HITL dedup/coalesce (`allowlistEscalated`) and the
approval-state-machine (ASM) attribution on the LIVE dispatch path. Today both
capabilities are fully built and unit-tested but never reach production because
the comp-root never mints the Set and dispatch never threads the ASM handle.

## Problem (ground-truthed against current code)

### Defect 1 — `allowlistEscalated` never minted → coalesce/dedup dead on the live path

`src/agent/admissibility-gate/hitl.ts:243` gates the Round-4 concurrent-coalesce
block on the Set's *presence*:

```ts
// hitl.ts:243
if (opts.allowlistEscalated !== undefined) {
  const pending = pendingReviewMapFor(opts.allowlistEscalated)
  ...            // at-most-once reviewer prompt per actionKey across concurrent callers
} else {
  dec = await runReview()   // legacy: every caller re-prompts
}
```

The same field also drives single-shot dedup at `hitl.ts:191`
(`if (opts.allowlistEscalated?.has(actionKey)) return runPreToolUseHook(...)`) and
the post-approve record at `hitl.ts:274` (`opts.allowlistEscalated?.add(actionKey)`).
All three are `?.`/`!== undefined`-guarded ⇒ **when the Set is absent the entire
dedup/coalesce feature is inert and the gate re-prompts on every structurally
equivalent escalation.**

The SOLE live producer of the `config.admissibility` bundle is
`buildAdmissibility` at `src/apps/cli/repl/runtime-context-compose.ts:533-611`.
Its returned bundle (`return { ...permissionStore, reviewerPort, defaultReviewer,
...circumventionTracker }` at 599-611) **never mints `allowlistEscalated`.** That
bundle flows `RuntimeContext.admissibility()` → `config.ts:313`
(`admissibility: d.admissibility`) → `config.admissibility`, so on the live CLI
path `opts.allowlistEscalated` is always `undefined`. Only tests hand-pass a Set,
so the coalesce hellgate is green while production runs the legacy re-prompt path.

### Defect 2 — ASM attached to top-level config but not threaded into gate opts

The approval-state-machine is wired onto the **top-level** `AgentConfig.base` at
`src/host/runtime/agent-arg-builder/observability-wire.ts:94-96` (gated by
`QUANTA_OBSERVABILITY`, default-OFF):

```ts
...(wire.approvalStateMachine !== undefined
  ? { approvalStateMachine: wire.approvalStateMachine }
  : {}),
```

But `dispatch.ts:395-400` builds the gate opts by spreading ONLY the
admissibility sub-bundle:

```ts
const gated = await runAdmissibilityGate(call, config, permission, action, autoClassifier, {
  ...(config.admissibility ?? {}),          // dispatch.ts:396
  onInputMutation: (next) => { rewritten = { value: next } },
})
```

The admissibility bundle type (`src/agent/types/wire-slots-core.ts:144-179`)
**omits `approvalStateMachine`** — it is a top-level `config` field, not an
`admissibility.*` field. Meanwhile `hitl.ts:211-213` reads it only from `opts`:

```ts
const gate = createApprovalGate(
  opts.approvalStateMachine !== undefined ? { approvalSM: opts.approvalStateMachine } : {},
)
```

⇒ On the live dispatch path `opts.approvalStateMachine` is always `undefined`, so
`createApprovalGate` gets the no-op default and **ASM `open`/`settle` never fire**
for reviewer escalations even with `QUANTA_OBSERVABILITY` on. Objective/RunLedger
attribution of approvals is silently lost.

## Required changes (single-seam, absent-implies-byte-identical-legacy)

### 1. Mint `allowlistEscalated` once per session in `buildAdmissibility`

In `runtime-context-compose.ts` `buildAdmissibility` (near line 533, before the
`return`), mint one Set per bootstrap and spread it into the returned bundle:

```ts
// ADR-0070 / Round-4 — one run-scoped dedup Set per session bootstrap. The
// coalesce WeakMap (`pendingReviewsByRun`, hitl.ts:144) is keyed by THIS handle,
// so a fresh Set per session gives naturally-isolated dedup state that is GC'd
// with the session — no explicit clear/recycle needed.
const allowlistEscalated = new Set<string>()
return {
  ...(permissionStore !== undefined ? { permissionStore } : {}),
  reviewerPort,
  defaultReviewer: selectDefaultReviewer({ ... }),
  allowlistEscalated,
  ...(circumventionTracker !== undefined ? { circumventionTracker } : {}),
}
```

This is the SOTA baseline (Claude Code / Cursor parity): an approved-once
escalation within a run does not re-prompt for a structurally-equivalent call, and
concurrent equivalent escalations coalesce to ONE reviewer prompt. Because dedup is
keyed on the existing `actionKey` SSOT (`reviewActionKeyOf`, hitl.ts:186) there is
**no arbitrary threshold** introduced. This is a pure UX dedup with an already-green
hellgate pinning it — wire it LIVE.

> Delete the old change item "Recycle/clear Set on session end." It is WRONG:
> `pendingReviewsByRun` is a `WeakMap<Set, …>` (hitl.ts:144), so the pending-review
> map is reclaimed automatically when the session Set is dropped. An explicit clear
> is dead code.

### 2. Thread top-level `config.approvalStateMachine` into gate opts

At `dispatch.ts:395-400`, spread the ASM from top-level config into the gate opts
(single seam, presence-gated so absent ⇒ byte-identical legacy):

```ts
const gated = await runAdmissibilityGate(call, config, permission, action, autoClassifier, {
  ...(config.admissibility ?? {}),
  ...(config.approvalStateMachine !== undefined
    ? { approvalStateMachine: config.approvalStateMachine }
    : {}),
  onInputMutation: (next) => { rewritten = { value: next } },
})
```

Do NOT move ASM into the `admissibility` bundle type — it is a cross-cutting
observability port (objective/runLedger sibling) owned by `observability-wire`;
threading it at the single dispatch seam keeps the bundle boundary clean.

**Measure-first:** ASM stays gated by the existing `QUANTA_OBSERVABILITY` flag
(default-OFF). The Set mint is a pure UX dedup with an existing regression pin, so
it lands live; no efficacy A/B is required for it.

## Acceptance

- On the live CLI comp-root path (driving the REAL `buildAdmissibility`, NOT a
  hand-passed Set), two concurrent same-`actionKey` escalations coalesce to ONE
  reviewer prompt.
- With `QUANTA_OBSERVABILITY` on, ASM `request`/`settle` fire exactly once per
  reviewer escalation on the `dispatch.ts` path.
- `admissibility-gate-coalesce-r4-followup-hellgate` stays green as the
  behavior-preserving regression pin.

## Proof rails (red-on-injection, not vacuous)

Existing pins (must stay green):

```sh
bun test tests/unit/admissibility-gate-coalesce-r4-followup-hellgate.test.ts
bun test tests/integration/review-kind-gate-hell.test.ts
```

New behavioral test — `tests/integration/albb-11-comproot-hitl-wiring.test.ts`:

- **(a) coalesce via real comp-root:** call `buildAdmissibility` (or
  `composeCliRuntimeContext` → `admissibility()`) to obtain the production bundle,
  assert `bundle.allowlistEscalated instanceof Set`, then fire two concurrent
  `reviewAndDecide`/gate calls with the SAME `actionKey` through that bundle and
  assert the reviewer port is invoked **exactly once**.
  *Red-on-injection:* delete the `const allowlistEscalated = new Set()` mint ⇒ the
  bundle field is `undefined` ⇒ two reviewer prompts ⇒ test fails.
- **(b) ASM fires on dispatch path:** with `QUANTA_OBSERVABILITY=1`, dispatch a
  tool through a config carrying a spy `approvalStateMachine`, and assert
  `request`/`settle` fire once per escalation.
  *Red-on-injection:* remove the `dispatch.ts` ASM spread ⇒ `opts.approvalStateMachine`
  is `undefined` ⇒ spy never called ⇒ test fails.

Both assertions observe REAL effects (prompt count, spy fire count), not compile
shape — a re-introduced defect turns them red.
