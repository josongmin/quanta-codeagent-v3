# ADR-0473 — Background (speculative) compaction: cancellable summarize with 2-phase install

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF feature slice (`@/agent/compaction` — the `compaction/`
directory; the existing `src/agent/compaction.ts` synchronous file is NOT
touched).
**Scope:** new files under `src/agent/compaction/` (`types.ts`, `background.ts`,
`index.ts`) + the hellgate `tests/unit/background-compaction-hellgate.test.ts` +
this ADR + the feature-catalog yaml. NO shared files edited (integration is a
human-applied TODO list below — `compaction.ts` and `loop.ts` stay untouched
until the human wires the seam).
**Default-OFF:** `QUANTA_BG_COMPACTION` unset (or any value other than `"1"`) ⇒
`bgCompactionEnabled` is `false` ⇒ the host never constructs the controller; the
existing synchronous `compactIfNeeded` / `reactiveCompact` path runs unchanged,
byte-identical to today.

## Context

Today compaction is **reactive/synchronous**: the loop summarizes only once the
transcript is at/over the token budget, blocking the turn while `summarize()`
runs. Claude Code and Codex both overlap summarization with the live turn:
when the transcript is **approaching** (not yet at) the window ceiling, they
start a summarize in the background, let the turn keep going, and at the turn
boundary install the produced summary only if it actually finished and freed
enough headroom — otherwise they discard it without disturbing live history.

Two correctness requirements make this non-trivial:

1. **No wasted spend.** If the turn ends before the summary is needed, the
   speculative summarize must be **cancelled** (the model call aborted), not left
   to bill for a result nobody installs.
2. **2-phase install.** A failed / aborted / too-small summarize must NEVER
   corrupt live history — old context stays intact until a *successful* summary
   actually installs. In particular an input-limit failure mid-turn (the
   summarize prompt itself exceeded the model limit) must discard cleanly.

## Decision

A pure, port-inverted slice under `@/agent/compaction` (the directory; imports
`@/shared` ONLY — `Result`, `logger`, `errMessage`):

- **`bgCompactionEnabled(env)`** — strict `=== "1"` gate over INJECTED env
  (never `process.env`; mirrors every other quanta gate).

- **`isApproachingLimit(usage, cfg)`** — pure "should we start speculating?"
  predicate. Fires when free headroom drops to/below EITHER the absolute floor
  `startAtUnusedTokens` OR the relative floor `startAtUnusedPercent` (OR — start
  early/eagerly; the persist gate is the conservative side). A degenerate
  `limitTokens <= 0` never fires (no division by zero, no gap to reason about).

- **`meetsPersistThreshold(used, resulting, limit, cfg)`** — pure "is the
  produced summary worth installing?" predicate. Requires BOTH `persistUnusedTokens`
  (absolute freed floor) AND `persistUnusedPercent` (relative freed floor) — AND,
  the conservative side. `freed = max(used - resulting, 0)` (a summary larger than
  the prefix it replaced frees 0, never negative).

- **`BackgroundSummarizationController<S>`** over the EXISTING summarize primitive
  (INJECTED as `SpeculativeSummarizeFn<S>` — port inversion, mirrors
  `src/permission/classifier.ts` ClassifierPort and the `away-summary` SummarizeFn)
  + an INJECTED `Clock`. The slice imports NEITHER `@/llm` nor `Date.now()`. State
  per in-flight pass: `{ promise, cancel, startedUsage, startedAt, settled }`.
  Methods:
  - `maybeStart(usage)` — idempotent; begins a background pass iff approaching
    the limit AND none in flight (a second call returns the active state without
    starting a second pass). The injected summarizer is invoked via
    `invokeSafely`, which try/catches so even an adapter that breaks its no-throw
    promise collapses to a typed `other` error — the in-flight promise NEVER
    rejects.
  - `cancelIfPending()` — turn ended early ⇒ abort the moot pass so it stops
    spending. Idempotent, NO-THROW.
  - `reconcileAtTurnBoundary(currentUsage)` → `install | discard(reason)` over a
    closed `DiscardReason` union. Non-blocking: a still-in-flight pass is
    discarded `not-completed` (and aborted) rather than stalling the boundary. A
    pass is consumed (cleared) on every reconcile so a second reconcile can never
    double-install.

`DiscardReason` is a closed union: `not-completed | below-persist-threshold |
input-limit-failure | cancelled | summarizer-error | no-pass-started`. The only
outcome that hands back a summary is `kind:"install"` — that IS the 2-phase
guarantee (a failed summarize yields a `discard`, leaving live history intact).

The persist gate is measured against the usage snapshot captured WHEN THE PASS
STARTED (`startedUsage`), using the live window ceiling at the boundary — judging
a summary against a transcript that grew after the speculative snapshot would
mis-rate it.

`startAtUnusedTokens` / `startAtUnusedPercent` / `persistUnusedTokens` /
`persistUnusedPercent` are ALL REQUIRED config fields — no magic numbers.

## Negative invariants

- The slice never imports `@/llm`, `@/memory`, or any other slice — the
  summarize primitive + clock are inverted as port TYPES.
- No `process.env` read and no `Date.now()` / `AbortController` inside the slice
  (clock + cancel token are injected/owned). `startedAt`/`elapsedMs` feed the
  side-channel log ONLY — never control flow (no timing heuristic).
- The in-flight promise NEVER rejects (every invocation is wrapped) — no
  unhandled rejection escapes, even from a misbehaving adapter.
- Default-OFF path is byte-identical: the host gates on `bgCompactionEnabled`
  BEFORE constructing the controller; OFF ⇒ the existing synchronous
  `compactIfNeeded` / `reactiveCompact` flow is unchanged.

## Integration TODOs (human applies; this slice is fenced from shared files)

1. **`src/agent/compaction.ts` (or the loop seam) — start at the approaching-limit
   check.** When `bgCompactionEnabled(env)` is ON, construct ONE
   `BackgroundSummarizationController` per session, wiring `SpeculativeSummarizeFn`
   as an adapter over the existing `summarize`/`compactIfNeeded` primitive that
   (a) honours `cancel.aborted` (bridge to a real `AbortController` passed to
   `llm.stream`), (b) returns `{ summary, resultingTokens }` (use `estimateTokens`
   on the produced `[synthetic, ...suffix]`), and (c) maps a prompt-too-long to
   `{ ok:false, error:{ kind:"input-limit", detail } }` and any other failure to
   `kind:"other"`. Inject `Clock = () => Date.now()`. Source the four config
   fields from named runtime config (NO literals). Call `controller.maybeStart(usage)`
   at the existing approaching-limit point (before `currentTokens > threshold`).
   When the gate is OFF, do nothing — the synchronous path is unchanged.
2. **`src/agent/loop.ts` — turn boundary call.** After the model turn fully
   resolves and the gate is ON: call
   `const outcome = await controller.reconcileAtTurnBoundary(currentUsage)` and on
   `kind:"install"` apply `wm.replace(...)` (or the host's equivalent) with
   `outcome.summary`; on `kind:"discard"` leave history untouched (optionally
   surface `outcome.reason`). If the turn ends EARLY (user cancel / loop break
   before the boundary), call `controller.cancelIfPending()` so the speculative
   summarize stops spending.
