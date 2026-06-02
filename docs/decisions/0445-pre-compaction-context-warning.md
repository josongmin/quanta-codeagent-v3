# ADR-0445 — pre-compaction / context-window warning (read-only preamble)

**Status:** Accepted (2026-06-02)
**Type:** UX/DX slice — RFC-09 (`docs/plans/jun-2-misc/09-completion-notify-and-context-warning.md`), feature B.
**Scope:** new leaf `src/apps/cli/context-warning.ts` + wiring through
`surface-compose.ts` (exposes the retained usage view), `session-loop.ts` /
`prompt-pipeline.ts` (preamble slot), and the composition root `repl.ts`.
Default-OFF (no preamble unless the warning binding is wired + the ratio trips).

## Context

Today auto-compaction (`compaction.ts` `compactIfNeeded`, threshold
`DEFAULT_THRESHOLD=120_000` / `runtimeConfig().compactTokens`) fires SILENTLY at
top-of-turn; the user only learns the context was summarized AFTER the fact (the
turn-summary box). Claude's "Conversation too long. Press esc twice…" message is
a POST-hoc rejection — already too late. We want a PRE-warning so the user can
choose to `/compact` now, `/rewind`, or continue.

## Decision

A pure, read-only predicate `renderContextWarning(view, opts)` returns a one-line
warning (or `""`). It introduces NO new token heuristic: it consumes the SAME
per-turn count the status-line / `/context` already compute — the
`ContextUsageHolder.view()` snapshot whose `.total`/`.max` come from the agent
loop's OWN `estimateTokens` (via `buildUsageBreakdownDefault`). The
`compactThreshold` is supplied by the composition root from the SAME source
compaction uses (`runtimeConfig().compactTokens ?? 120_000`). The module only
does arithmetic + formatting on those given numbers.

`toWarningView(holder.view(), threshold)` maps the retained snapshot into the
warning's numeric view. Two ratios over the SAME `usedTokens`: window
(`used/max`, default 0.8) and compaction (`used/compactThreshold`, default 0.9).
Compaction-imminent wins (more urgent). Both branches advise `/compact` AND
`esc esc(/rewind)` — Claude's "Press esc twice" affordance mapped to quanta's
`/rewind`.

## Why NOT reuse the existing pre-compact hooks

`preCompactHook` (ADR-0133, `compaction.ts:218`) and `onPreCompact`
(ADR-0075, `loop.ts` preflight) BOTH fire AFTER the threshold is crossed and
compaction has already been decided — too late for a PRE-warning. B computes a
forward-looking ratio at prompt time from the retained count instead, and leaves
both hooks UNTOUCHED (orthogonal). `compactIfNeeded` and its threshold /
keepTurns policy are unmodified — B is pure read-only observation.

## Wire points (end-to-end, live)

- `surface-compose.ts` — `ReplSurfaceWires.contextUsageView` now exposes
  `contextUsageHolder.view()` (the SAME holder `/context` reads).
- `repl.ts` — `resolveCompactThreshold()` mirrors `compaction.ts resolveThreshold`;
  the `contextWarning` closure = `renderContextWarning(toWarningView(view(),
  threshold))`, gated on `process.stderr.isTTY`; passed to `runSessionLoop`.
- `session-loop.ts` — threads `contextWarning` into `composePromptPipeline`.
- `prompt-pipeline.ts` — writes the non-empty warning as a one-line stderr
  preamble before the prompt (inbox-preamble idiom).

## Consequences

Default-OFF byte-identical: binding absent OR ratio below threshold OR no
snapshot yet (first turn) ⇒ `""` ⇒ no preamble write. Graceful on degenerate
input (`max<=0`, `threshold==0` ⇒ no NaN/Infinity). The preamble is a stable
one-liner per prompt (not a transient) and self-clears once the ratio drops
(after `/compact` or `/rewind`). Non-interactive (non-TTY) runs get no binding
⇒ byte-identical for eval/bench.

## Non-goals

- Changing auto-compaction policy (threshold / keepTurns / trigger).
- Reproducing Claude's post-hoc "Conversation too long" path — quanta already
  has reactive compaction; B is pre-only.
- Resume-time immediate warning before the first snapshot — deferred (needs an
  initial snapshot injection on resume).
