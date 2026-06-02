# ADR-0451 — per-subagent model / role / effort override

**Status:** Accepted (2026-06-02)
**Type:** Structural wiring slice (absorbs Cursor `SubagentModelOverride`).
**Scope:** `src/subagent/types.ts` (three optional request fields),
`src/subagent/agent-tool.ts` (three optional input-schema fields + `buildRequest`
threading), `src/agent/subagent-runner.ts` (`buildChildConfig` resolves the
child's LLM port + effort), and the hellgate
`tests/unit/subagent-model-override-hellgate.test.ts`. No other files touched.
Default-OFF: a request with none of the three fields produces a byte-identical
child config.

ADR-number note: 0450 was the highest existing decision; this slice took the
next clearly-free number, 0451.

## Context

The model-override infrastructure already existed but was NOT connected to the
subagent spawn path:

- `src/llm/role-model-override/` (ADR-0256) — `RoleModelResolver.resolve(role,
  defaultModel)` maps a dispatch role → model id; falls through to the default
  for unknown roles; never throws. Already used by the fast-apply fallback.
- `src/llm/model-swap.ts` — `ModelCandidate { id, port }`; the loop's
  skill-model-swap (`resolveSkillTurnOverride` in `src/agent/loop.ts`, ~L491)
  swaps the per-turn LLM port via `config.modelCandidates.find(c => c.id ===
  id).port`.
- `src/agent/effort.ts` — `EffortLevel` named tiers + `effortToTokenBudget`;
  the loop reads `AgentConfig.sessionEffort()` per turn and caps the thinking
  budget from it.

But `SubagentRequest` had no `model`/`role`/`effort` field, the `agent` tool
schema did not expose them, and `buildChildConfig` set `llm: parent.llm`
verbatim — so a parent could not assign a specific model/effort to a child it
spawned (Cursor's `SubagentModelOverride`: a planner on a deep-reasoning model
delegating edits to a fast minimal-diff model).

## Decision

Thread model/role/effort end-to-end, REUSING the existing mechanisms — no new
model registry is introduced.

1. **Slice request fields** (`SubagentRequest`): add optional `model?: string`,
   `role?: string`, `effort?: string`. They stay plain strings because the
   `@/subagent` slice may only import `@/tool` / `@/shared` (RFC 3.1 slice
   isolation, enforced by biome) — it owns no `Role` / `EffortLevel` / `ModelId`
   enum. This mirrors the existing `TaskKind` precedent: the slice carries an
   agnostic value; the agent-side host interprets it.

2. **Tool input schema** (`agent-tool.ts`): `model` (string), `role` (string),
   `effort` (enum `default|low|medium|high|max`). `buildRequest` omits each when
   absent (no `undefined` keys ⇒ no-override path byte-identical).

3. **Child config resolution** (`buildChildConfig` / `resolveChildLlm` /
   `resolveChildEffort` in `subagent-runner.ts`):

   - **Model precedence (highest first):**
     1. explicit `req.model` → swap to the matching `parent.modelCandidates`
        entry's port.
     2. `req.role` → `parent.roleModelResolver.resolve(role, parentModel)`; if
        the resolved id differs from the parent's model, swap to its candidate.
     3. neither (or a role that resolves back to the parent model) → `parent.llm`
        verbatim (byte-identical).
   - The swap REUSES the exact id→port lookup the loop's skill-model-swap uses
     (`modelCandidates.find(c => c.id === id).port`).
   - **Effort:** a recognised `EffortLevel` (via `parseEffort`) is wired as the
     child's `sessionEffort: () => level` thunk — the SAME seam the loop reads to
     derive a thinking budget through `effortToTokenBudget`. An unrecognised
     string votes for nothing (defers to the parent's effort), mirroring
     `resolveEffort`'s numeric-advisory rule.

4. **Fail-closed on a bad model.** Unlike the skill path (which leaves
   `config.llm` untouched on an unknown id — advisory degrade), a subagent
   override that names a model id with NO matching candidate (explicit, or a
   role that resolves to a non-candidate) throws `UnknownSubagentModelError`
   from `buildChildConfig`. The child loop is NEVER forked on the wrong model.
   The runner's callers convert the throw to a recoverable result: the
   foreground `agent` tool catches it → `deny("Subagent error: …")`; the
   background path → `registry.fail(taskId, …)`. No crash, no silent fallback.

## Consequences

- **Default-OFF / byte-identical:** absent `model`/`role`/`effort` ⇒
  `child.llm === parent.llm` (reference-identical) and no `sessionEffort` wired —
  the exact pre-0451 child config. Locked by HELL-SMO-05 / HELL-SMO-11.
- **No reinvention:** the id→port swap reuses `modelCandidates` (the
  skill-model-swap mechanism); role resolution reuses the ADR-0256
  `RoleModelResolver`; effort reuses `sessionEffort` + `effortToTokenBudget`.
- **Slice isolation preserved:** `@/subagent` still imports only `@/tool` /
  `@/shared`; all interpretation (string → `Role` via the resolver's
  type-erased contract, string → `EffortLevel` via `parseEffort`, id → port via
  `modelCandidates`) happens in `@/agent`.
- **Wiring is live, not deferred:** the resolution runs inside the spawn path
  every call. It only changes behavior when a field is present and the host has
  wired `modelCandidates` / `roleModelResolver`; otherwise (e.g. a role with no
  resolver) it stays on the parent model.

## Alternatives considered

- *Advisory degrade on unknown model (like the skill path).* Rejected: a
  delegating parent that explicitly picks a model is expressing intent; silently
  running the child on the parent's model would mask a misconfiguration and
  could run an expensive deep-reasoning task on the wrong model. Fail-closed is
  the safe default for a delegation boundary.
- *Putting `Role` / `EffortLevel` types on `SubagentRequest`.* Rejected: would
  force `@/subagent` to import `@/llm` / `@/agent`, violating slice isolation.
  Plain strings + host-side interpretation matches the existing `TaskKind`
  pattern.
- *A numeric `effort` budget on the child.* The loop has no per-config numeric
  thinking-budget slot (numeric effort is a per-turn skill advisory only), so a
  raw number has no clean reuse seam; we constrain the tool input to the named
  tiers and reuse `sessionEffort`.
