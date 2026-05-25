# ADR-0277: Session-level reasoning effort wire — `/effort` slash + `EffortStore` precedence fold-in

## Context

`src/agent/effort.ts` has shipped a five-tier reasoning-effort axis (`default | low | medium | high | max`) with token-budget mapping (`undefined / 1024 / 4096 / 16384 / 64000`) and an `EffortStore` for a long time. The wire was **half-finished**:

- **Skill rung** — a skill's frontmatter `effort:` field already flowed into per-turn `LLMInput.thinking` via `resolveSkillTurnOverride` in `src/agent/loop.ts` (covered by `tests/integration/loop-skill-override.test.ts`).
- **Pill chrome** — the status row in `src/apps/cli/status-pills.ts` already painted `[🧠 high]` / `[🧠 low]` from a `QUANTA_EFFORT` env read in `src/apps/cli/repl/skills-surface.ts`.
- **Session rung — MISSING.** `EffortStore` was exported from `src/agent/index.ts` but had **zero call sites** in `src/`. Setting `QUANTA_EFFORT=high` painted the pill but never folded into the actual LLM call; there was no `/effort` slash to mutate it across turns; the loop's precedence resolver had no session rung to consult.

Codex's `/model` picker shows model + reasoning effort together with one-letter hints and a status-line hint (`fast/model to change`). Cursor and Claude Code both expose runtime "thinking budget" picks. v3 was the outlier: skills could declare effort, but the user had no way to bump effort for the whole session at runtime.

## Decision

Add the **session rung** in the middle of the existing precedence chain (skill > **session** > default) and ship a Codex-style `/effort` slash to mutate it.

### Loop seam (`src/agent/loop.ts:402-449`)

`resolveSkillTurnOverride` now consults `config.sessionEffort?.()` per turn when the skill side is silent on effort. Three-state intermediate (`number | undefined | null`) distinguishes:

- `null` — skill is absent or skill model-only (no `effort:`) ⇒ **fall through** to session.
- `undefined` — skill explicitly declared `"default"` OR named tier mapped to `undefined` ⇒ explicit "no thinking" (does NOT fall through; byte-identical to the pre-session skill branch).
- positive `number` — skill or session winning budget ⇒ `thinking:{enabled, budget_tokens}`.

Non-positive numeric (e.g. `effort: 0` in frontmatter) is also explicit-off — `budget > 0` check at the tail.

### AgentConfig slot (`src/agent/types.ts`)

```ts
sessionEffort?: () => EffortLevel | undefined
```

A **function**, not a value, so a surface-owned `EffortStore` can mutate across turns without re-assembling `AgentConfig`. Returning `undefined` (or `"default"`) ⇒ no `thinking` field on `LLMInput` (byte-identical to today, RFC §1.2 default-OFF).

### CLI wiring chain

1. **Bootstrap** (`src/apps/cli/repl/session-bootstrap.ts`) — `createEffortStore(parseEffort(env.QUANTA_EFFORT) ?? "default")` once per session, exposed on `SessionBootstrapResult.effortStore`.
2. **Deps composition** (`src/apps/cli/repl/session-deps-compose.ts`) — `sessionEffort: () => boot.effortStore.get()` threaded into `SessionDeps`.
3. **Assemble** (`src/runner/assemble/config.ts`) — surface-agnostic `SessionDeps.sessionEffort` slot + conditional spread into `AgentConfig.sessionEffort`.
4. **Setup** (`src/apps/cli/repl/session-setup.ts`) — `effortStore` forwarded to `SessionSetupResult`, initial value re-synced to the pill at install (`pills.update({ effort: store.get() })`).
5. **Slash surface** (`src/apps/cli/repl/surface-compose.ts`) — `effort.set` callback writes BOTH `effortStore.set(lvl)` AND `pills.update({ effort: lvl })` atomically — single seam owns the persist + render pair.

### `/effort` slash (`src/apps/cli/slash-commands.ts`)

Codex `/model`-style UX, effort-only (model swap is `/retry-with`'s domain):

```
$ /effort
🧠 reasoning effort: medium (~4,096 tokens)
   default   provider default (no thinking budget)
   max       ~64,000 tokens
   high      ~16,384 tokens
 * medium    ~4,096 tokens
   low       ~1,024 tokens
use: /effort <level>

$ /effort high
🧠 effort: high (~16,384 tokens)
```

- No args ⇒ 🧠 header + 5-tier list (current marked `*`) + use-hint.
- Named arg ⇒ `ctx.effort.set(level)` (mutates store + pill in one tick), confirmation line with budget tag (or "provider default — no thinking budget" for `default`).
- Case-insensitive (`/effort HIGH` resolves to `"high"`).
- Multi-arg ⇒ exit 1 + "takes at most one argument".
- Unknown level ⇒ exit 1 + "unknown level '<x>'; known = …".
- Tab-completion offered for empty / prefix arg.

Absent `ctx.effort` (one-shot / shell surfaces) ⇒ "not wired in this surface" + exit 0, parity with the rest of the surface-only commands.

## Invariants

- **Per-turn read.** The loop calls `config.sessionEffort()` ONCE per turn — a `/effort high` mid-turn applies on the NEXT turn (no live mutation of the in-flight `LLMInput`).
- **Skill always wins.** Any skill-declared effort (named tier or numeric) beats session; `"default"` skill is an EXPLICIT off (doesn't fall through). Silent skill = fall through. This preserves byte-identical behavior for every existing skill override test in `tests/integration/loop-skill-override.test.ts`.
- **Default-OFF.** Absent `sessionEffort` slot OR `sessionEffort()` returning `undefined`/`"default"` ⇒ no `thinking` field on `LLMInput` (byte-identical to pre-feature).
- **Single seam mutates store + pill.** The `/effort` slash's `set` callback (`src/apps/cli/repl/surface-compose.ts`) writes to BOTH. No other path in the codebase calls `effortStore.set` — preventing "pill shows X, store says Y" drift.
- **Slice-clean.** No new cross-slice imports. `slash-commands.ts` imports `EffortLevel` type only via `import("@/agent").EffortLevel` (existing import boundary). `surface-compose.ts` imports `EFFORT_LEVELS` + `effortToTokenBudget` from `@/agent` (already a permitted import target).

## Posture

- **Default-OFF, opt-in via `QUANTA_EFFORT` env** at boot OR `/effort <level>` mid-session. Without either, every existing caller is byte-identical (no `thinking` field emitted).
- **Codex pattern, NOT Codex implementation.** v3 retains its own 5-tier vocab (`default | low | medium | high | max`) — does NOT adopt Codex's `minimal | low | medium | high | xhigh`. Decision: existing memory `no-heuristics-only-validated` forbids unmotivated vocab churn; both vocabularies map to a budget number the adapter forwards anyway.
- **Skill vocab vs session vocab.** `SkillEffort` (`src/skill/types.ts`) allows `low | medium | high | max | number`. Session vocab adds `default` (the "use provider default reasoning" tier — never a skill override). Skill frontmatter parser silently drops `effort: default` — documented in test (f).

## ENV knobs

- `QUANTA_EFFORT` — initial session tier (`default | low | medium | high | max`). Parsed via `parseEffort`; unrecognised value ⇒ falls back to `"default"`. Surface-by-env init only; runtime change is via `/effort`.

## Test pin

- `tests/integration/session-effort-precedence.test.ts` — 7-case hellgate covering skill > session > default precedence via real `runAgent` + scripted LLM doubles (cases a..g: session alone / skill beats session / model-only fallthrough / default & undefined no-thinking / explicit-off numeric 0 / skill silence fallthrough).
- `tests/unit/cli/effort-slash-hellgate.test.ts` — 8-case slash UX hellgate (absent ctx, no-arg render, set + confirmation, multi-arg error, unknown level error, case-insensitive, `default` confirmation drops budget tag, repeated set).
- `tests/unit/slash-commands.test.ts` — `/effort` slot-pinned right after `/focus-chain` and before `/debug` in the BUILTINS table.

## What is NOT in this slice

- **Skill vocab expansion** — `SkillEffort` stays `low | medium | high | max | number`; a skill cannot declare `effort: default` (silently dropped). Documented in test (f) — exercised via numeric `0` instead.
- **Per-skill model swap UX** — `/effort` is effort-only. `/retry-with` already owns the model-swap path; a `/model` slash would be additive and is left to a future ADR.
- **Cache invalidation hint** — changing effort tier mid-session may invalidate prompt-cache prefixes; no warning is surfaced. Future ADR-0273 `ModelTag` style invalidation hook may extend to effort.
- **Pill chrome change** — the existing `formatEffort` rendering in `src/apps/cli/status-pills.ts` is unchanged. Only the wiring (initial + runtime set) was extended.

## References

- `src/agent/effort.ts` — pre-existing 5-tier vocab + `EffortStore` + `effortToTokenBudget`.
- ADR-0011 §6.2 — skill model/effort override semantics (the rung this ADR extends).
- ADR-0076 Gap-2 — extended-thinking field forwarding in the Anthropic adapter.
- ADR-0065 — `/retry-with` (the model-swap sibling to this effort-swap).
