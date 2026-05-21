# ADR-0057 — Session effort dimension (5-tier)

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0022 (skill trigger + per-skill `effort?: SkillEffort`), [[claude-desktop-1-7196-catalog]] §effort-levels, [[cc-v2-sota-absorption]] (Tier-0 absorption #0-5)

## Context

Claude Desktop 1.7196.3 has a 5-tier per-session effort axis (`default / max / high / medium / low`). Codex's analysis stack does not have an equivalent dimension. The five tiers act as a model-agnostic hint that downstream
adapters / loop / UI can consult to (a) set a `max_output_tokens` ceiling, (b)
suggest a reasoning-mode for thinking-capable models, (c) gate validation-rail
depth (e.g. `low` ⇒ skip exhaustive type-checking pass).

quanta's `src/skill/types.ts` already had `SkillEffort = "low" | "medium" | "high" | "max" | number` as a per-skill advisory. That is per-skill, not per-session — sessions had no axis.

## Decision

1. `src/agent/effort.ts` — pure leaf module exporting:
   - `EffortLevel = "default" | "max" | "high" | "medium" | "low"`
   - `EFFORT_LEVELS` / `DEFAULT_EFFORT`
   - `parseEffort(raw)` — case-insensitive, returns `undefined` for absent / unknown / empty so callers preserve "user did not set" vs "user set 'default'"
   - `effortToTokenBudget(level)` — pure mapping (1024 / 4096 / 16384 / 64000 / undefined-for-default). Documented as a STARTING POINT; adapters may clamp to model limits.
   - `resolveEffort(session, skill)` — precedence: named skill tier > session > DEFAULT. A NUMERIC skill effort is advisory only, NOT a vote on the named axis (falls through to session).
   - `createEffortStore(initial?)` — mutable per-session holder with `get/set/snapshot`.
2. Slice isolation: pure leaf, no imports. `SkillEffortAdvisory = EffortLevel | number` is mirrored structurally so `@/agent` does not import `@/skill`.

## Consequences

**Positive**
- Per-session effort is now a first-class axis. Adapters can read it via the EffortStore without coupling to the skill slice.
- The numeric vs named discrimination is explicit in `resolveEffort`, ruling out the failure mode "skill author wrote `effort: 4000` and accidentally voted on the axis".

**Trade-offs**
- The token budgets in `effortToTokenBudget` are arbitrary starting points chosen to match Claude Desktop's observed defaults; production callers should override for cost-sensitive workloads.

## Negative invariants

- `parseEffort("")` and `parseEffort(undefined)` MUST return `undefined`, NOT `"default"`. Tested.
- Every `EffortLevel` literal MUST have a defined behavior in `effortToTokenBudget` (exhaustiveness check via the switch). Tested by iterating `EFFORT_LEVELS`.
- `resolveEffort` MUST NOT promote a numeric `skill` value to a named tier. Tested.

## Files touched

- `src/agent/effort.ts` — NEW.
- `tests/unit/effort.test.ts` — NEW (17 cases).
