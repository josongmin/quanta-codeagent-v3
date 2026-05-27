# ADR-0343 — Per-turn rebuild of `withImageSanitizationRetry` wrap

- Status: **Deferred (negative decision)**. No code shipped. This ADR
  records the investigation and the conditions under which a
  supersede ADR would implement per-turn rebuild.
- Date: 2026-05-27
- Related:
  - ADR-0328 (`withImageSanitizationRetry` decorator) — the wrap whose
    rebuild this ADR considered.
  - ADR-0333 (production hookup of the wrap in `createRunAgentContext`)
    — the single-call site this ADR would have modified.
  - ADR-0337 (wm-live snapshot on retry) — already closes
    ADR-0333 §Limitations row 1 (stale `input.messages`); the only
    remaining limitation is the per-session toggle this ADR studied.

## Context

`maybeWrapImageSanitizationRetry(cfg, wm)` at `src/agent/loop.ts:2214`
is called exactly once per agent session, from `createRunAgentContext`
(`src/agent/loop.ts:2251`):

```ts
cfg.llm = maybeWrapImageSanitizationRetry(cfg, wm)
```

The wrap inspects `cfg.imageSanitizationRetry?.enabled` and returns
either the unmodified `cfg.llm` (default-OFF path, byte-identical to
pre-ADR-0328) or a wrapped `LLMPort` that retries on
`LLMError("invalid_image", …)`. **The wrap decision is fixed for the
lifetime of the agent run.**

ADR-0333 §Limitations row 2 already documented this:

> **Per-session, mid-session toggle unsupported.** The wrap is bound
> once at `createRunAgentContext`; toggling `cfg.imageSanitizationRetry`
> mid-session has no effect until the next session.

This ADR was the candidate slot to close that limitation by rebuilding
the wrap each turn.

## Investigation

### Implementation sketch (if we were to ship it)

The straightforward implementation has a hazard: `withImageSanitizationRetry`
in ADR-0328 does NOT mark its return value as wrapped (no `__inner`
field, no nominal type). A naive per-turn `cfg.llm = maybeWrap…(cfg, wm)`
would re-wrap an already-wrapped llm on every turn, growing the chain
unboundedly.

Two viable approaches:

1. **Original-llm snapshot.** Store `cfg.__originalLlm = cfg.llm`
   on first wrap; subsequent turns re-evaluate against the original.
   Adds a mutation on `cfg` (one field) at session start; touches
   `cfg` again each turn.
2. **Wrap marker on the decorator.** Modify
   `withImageSanitizationRetry` in ADR-0328 to attach a
   non-enumerable `__inner` reference; per-turn rebuild peels off
   the wrap by reading `__inner` and re-applies with the current
   options. More invasive (changes the ADR-0328 surface), but does
   not pollute `AgentConfig` with a private field.

Both approaches require a per-turn hook in `prepareTurnContext` or
the turn-loop preamble — sites that are part of the agent loop
critical path. `cfg.llm` is also read by callers other than
`runAgentTurn` (e.g. compaction subroutines); a per-turn mutation
must coordinate with those readers or the change leaks across turn
boundaries in unpredictable directions.

### Use-case search

The required justification for either implementation is a concrete
scenario where `cfg.imageSanitizationRetry.enabled` changes
mid-session. The investigation surveyed:

1. **Memory** (`agent-analysis-corpus`, `image-retry-*` entries):
   no mid-session toggle scenario recorded.
2. **Recent commit history** (`git log --grep='image\|retry'`,
   2026-05-27 backward):
   - `c2782fc6`, `e155f915` — ADR-0337 wm-live snapshot (different
     concern: input freshness on retry, not enable/disable toggle).
   - `dc821e90` — ADR-0332/0333 production hookup (session-start
     installation).
   - `3e7125b1`, `868a0f08` — ADR-0328 wrap landing (session-start
     wrap).
   - `bbfbc1fb`, `ee52908b` — ADR-0323 sanitization slice.
   No commit, ADR, or test scenario describes a user / system flow
   that toggles the retry mid-session.
3. **AgentConfig consumers** (`grep -rn 'imageSanitizationRetry'`):
   2 production reads (`loop.ts:2215`, `2218`, `2221`), 2 install-
   helper reads (ADR-0332). Zero readers expect mid-session change.
4. **Codex parity** (the absorption target): Codex's
   `replace_last_turn_images` recovery arm is similarly statically
   installed in `codex-rs/core/src/session/turn.rs`; Codex does not
   toggle the recovery mid-session.

**No user scenario exists. No system scenario exists. No upstream
parity scenario exists.**

## Decision

**Defer the implementation.** Do not ship per-turn rebuild logic.
Document the limitation in this ADR and the migration path so a
future user-driven request has a clear pickup point.

The decision aligns with the project-wide guideline in memory
`no-heuristics-only-validated`: *"n=1로 루프 변경 정당화 금지(측정
먼저)."* A change to the agent loop critical path requires a
validated scenario, not a speculative one.

### Negative invariant

**Per-turn rebuild of the image-retry wrap is intentionally NOT
implemented.** Callers needing to toggle the retry behavior MUST
start a new agent session. Mutating `cfg.imageSanitizationRetry`
mid-session is a no-op for the wrap-decision.

This negative invariant should be tested only when a future ADR
**rescinds** it — testing the absence of a wired feature is wheel-
spin under the slice-fence rules.

## Future trigger

A supersede ADR (numbered 0344+ at writing) SHOULD implement per-turn
rebuild when at least ONE of these conditions holds:

1. **User-initiated toggle.** A user issues a slash command
   (`/image-retry on|off`) or an inline CLI directive that takes
   effect mid-session, and the product owner endorses the
   immediate-effect semantics.
2. **Adaptive policy.** A new ADR introduces a heuristic that
   *enables* the retry only after the first observed `invalid_image`
   error (i.e. lazy enablement). Today's flag is binary, so no
   adaptive policy exists.
3. **Per-turn config swap.** A new ADR introduces per-turn
   `AgentConfig` re-resolution (e.g. via a hot-reload of
   `.quanta/quanta.json`), at which point image-retry rebuild becomes
   one row of a broader rebuild surface.

### Implementation sketch (for the future ADR)

If/when one of the above triggers fires, the recommended sketch is:

1. In `createRunAgentContext`, after the existing wrap call, retain
   the pre-wrap llm:

   ```ts
   const originalLlm = cfg.llm
   cfg.llm = maybeWrapImageSanitizationRetry(cfg, wm)
   // store the original on the runtime context, NOT on cfg.
   ```

   Use the `RunAgentContext` shape (not `AgentConfig`) to carry the
   original — avoids polluting the user-visible config type.

2. In the turn-loop preamble (`prepareTurnContext` or equivalent),
   re-evaluate against the latest `cfg.imageSanitizationRetry`:

   ```ts
   ctx.cfg.llm = maybeWrapImageSanitizationRetry(
     { ...ctx.cfg, llm: ctx.originalLlm },
     ctx.wm,
   )
   ```

   Cheap (one config lookup + at most one wrap creation per turn).

3. Hellgate cases (when implementing):
   - mid-session enable: 1st turn unwrapped, 2nd turn wrapped on
     `invalid_image`.
   - mid-session disable: 1st turn wrapped, 2nd turn surfaces
     `invalid_image` as a hard error.
   - option change (e.g. `maxAttempts` 1 → 3): retry count updates
     mid-session.
   - no-toggle: byte-identical to today's single-call path.
   - reentrancy: per-turn rebuild does not chain wraps.

## Slice fence (for this ADR)

This ADR adds **only the document below `docs/decisions/`**. No code
change, no test change, no `loop.ts` mutation. The slice fence forbids
mutating `loop.ts` in this session (per the in-flight user-edit on
ADR-0337 / commit `1f959885`), and the negative decision honors that
forbiddance.
