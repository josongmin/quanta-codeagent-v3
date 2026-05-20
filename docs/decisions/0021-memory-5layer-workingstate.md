# ADR-0021 — Memory 5-layer: artifact rail + WorkingState L3

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 6

## Context

Codex `memory-model-audit.md` defines a 5-layer memory model:

- **L1 Policy** — instruction stack (system / dev / app / mode /
  repo-local / skill).
- **L2 Thread** — conversation message history.
- **L3 Working** — current task state: owner shortlist, hypothesis,
  blockers, deferred validation, next-step queue.
- **L4 Artifact** — workspace files used as durable state substrate.
- **L5 Subagent** — child session memory (forked context).

Our pre-Phase-6 state:
- L1 = TurnContext.instructionStack (Phase 0 added repoRules; remainder in
  system prompt).
- L2 = `src/memory/working.ts` `WorkingMemory` (message buffer).
- **L3 — MISSING.** No explicit working-state type.
- L4 — workspace files (implicit; no policy).
- L5 = `src/subagent/`.

Plus we have a persistent recall/embed memory store in `src/memory/` —
this is OUR ADDITION beyond Codex's contract. Codex explicitly calls out
that a dedicated long-term memory CRUD tool is NON-CLAIM in their world;
ours exists and must keep working. Phase 6 only ADDS L3 + L4 layers and
clarifies that recalled memory is a routing hint, not authority.

## Decision

### L3 — WorkingState
`src/agent/working-state.ts`:

```ts
interface WorkingState {
  ownerShortlist: { file, reason }[]
  hypothesis?: string
  blockers: { what, surface }[]
  nextStepQueue: { what, deferred? }[]
  deferredValidation: { rail, reason }[]
}
```

- `emptyWorkingState()` — zero state.
- `createWorkingStateSession()` — session-scoped handle with `mutate(patch)`
  / `snapshot()` semantics. The session is wired into the agent loop and
  exposed through ToolContext (`workingState?: WorkingStateHandle`).
- `renderWorkingStateBlock(state)` — markdown block for the per-turn
  reminder; returns `undefined` when state is empty (no clutter).

### Meta-tool: `update_working_state`
`src/tool/update-working-state.ts`:
- Input fields each REPLACE (not append) the corresponding state field.
- `hypothesis: null` clears the hypothesis.
- Conditionally registered when `AgentConfig.workingState?.enabled === true`.

### L4 — Artifact-as-memory policy
`src/agent/prompt.ts` `buildSystemPrompt` gains one paragraph between the
trust ladder and budget discipline blocks:

```
Durable state belongs in workspace files. If you produce analysis,
decisions, or design that future turns may need, write it as an artifact
(markdown in docs/, an ADR, or a feature note) — not as a verbose summary
in chat. Memory recall is a routing hint, not durable storage; artifacts
are SSOT.
```

### Memory recall block label
`buildDynamicContext` labels the existing memory block as:

```
## Memory hints (routing hints only — not proof)
```

This codifies Codex's trust ladder structurally — memory cannot be promoted
to proof in the model's reading.

## Mechanism

- `WorkingStatePatch` fields are spelled `T | undefined` so zod
  `.optional()` parse outputs are assignable under
  `exactOptionalPropertyTypes: true`.
- Tool slice isolation: ToolContext gains an optional `workingState?:
  WorkingStateHandle` shape declared in `@/tool/types.ts` as a duck-typed
  mirror — no cross-slice import of `@/agent`.
- The session handle is allocated only when the feature is enabled;
  absent ⇒ no allocation, the per-turn block is omitted, the tool is not
  registered (byte-identical).

## Consequences

- The model has a structural scratchpad it can update each turn (owner
  shortlist, blockers, deferred validation) that survives compaction
  because it rides the reminder, not the history.
- "Memory hints" are now visibly distinct from "Repo-local rules"
  (authority) in the reminder, so the model's reading aligns with the
  trust ladder.
- Phase 4 (`CODE_MOD_CLOSEOUT_REMINDER` 4-surface) and Phase 6
  (WorkingState) compose: working-state can carry the
  blockers/next-step queue across turns, and the closeout walks the four
  surfaces with that state in hand.

## Tests

- `tests/unit/working-state.test.ts` — emptiness, mutate semantics,
  rendering.
- `tests/unit/update-working-state.test.ts` — patch replaces (not
  appends), hypothesis:null clears, output summary.
- `tests/unit/prompt.test.ts` — block ordering, memory-hint label.
- `tests/integration/agent-features.test.ts` — `workingState.enabled=true`
  registers the tool; absent leaves the registry unchanged.

## References

- Codex `memory-model-audit.md` (5-layer).
- Codex `task-management-and-todo-audit.md` §8 (working queue lanes).
