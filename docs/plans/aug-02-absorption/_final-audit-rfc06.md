# RFC-06 — FINAL code-grounded audit of 2 leftovers (aug-10)

**Basis:** `main` HEAD `c46c60f4e`. Read-only; no source modified. Anti-dup check
of `_backlog-audit-rfc06.md`'s two open items against CURRENT code, AFTER
`b12f5a9bd` ("close 4 dead-seam gaps") landed. Method: R1 existence/wiring
(grep + file:line), R2 adversarial anti-dup + necessity.

`b12f5a9bd` touched: `@thread` mention lineage-scope (item #2 sibling), worktree
reconcile, rewind recover, a flake fix. It did **NOT** touch the objective
producer or `markUsageLimited` — verified by `git show --stat b12f5a9bd` (no
`src/agent/objective/*`, no `src/llm/*`).

---

## ITEM 1 — A4.3 `usage_limited` live producer

**VERDICT: NEEDED (minimal delta) — real gap, and the measured signals to wire it EXIST.**

R1 current reality:
- 6-state machine is real + fires (unchanged since backlog audit): `deriveStatus`
  `src/agent/objective/store.ts:97-104` — `enforce ∧ usageWindowActive ⇒ usage_limited`
  (priority 2), `enforce ∧ budgetExhausted(>=) ⇒ budget_limited` (priority 3).
  `usageWindowActive` `store.ts:77` = `usageLimitedUntil !== undefined && now < until`
  (clock-derived auto-reset, no sticky flag). `markUsageLimited` impl `store.ts:311`
  sets/deletes `usageLimitedUntil`.
- **`markUsageLimited` has ZERO prod caller — STILL TRUE.** grep across `src/`:
  only the type decl (`types.ts:134`), the impl (`store.ts:311`), composition
  snapshots, and tests (`tests/unit/thread-goals-enforce-hellgate.test.ts:71,103,115`,
  `objective-budget-enforce-e2e-hellgate.test.ts`). No `src/llm/retry/**` adapter
  forwards a 429 into it. ⇒ `usage_limited` remains dead-in-prod.
- **`recordUsage` into the objective is the MODEL's self-report, not measured**
  provider usage — STILL TRUE. Only caller into `ObjectivePort.recordUsage` is the
  model tool `src/tool/objective/index.ts:265-269`. The real per-turn token counter
  is a DIFFERENT method on the metrics collector, not wired to the objective port.

R2 adversarial (necessity — is the wire net-positive or over-engineering?):
- **The measured signals DO exist to wire — this is NOT speculative.**
  (a) Measured provider token usage: `withLiveUsage` / `AccumulatedUsage`
  (`src/llm/live-usage/index.ts`, `openai-responses-wire.ts:613`,
  `adapters/anthropic.ts:196`, `adapters/openai.ts:292`) — authoritative
  `usage.outputTokens` per turn, composed once at `composeLLM`.
  (b) The exact `untilEpochMs` `markUsageLimited` wants: `parseRetryAfterMs`
  (`src/shared/errors.ts:310`, reads `retry-after` / `retry-after-ms`) plus the
  proactive `ratelimit-snapshot` reset (`src/llm/ratelimit-snapshot/parse.ts`,
  `policy.ts`) and the retry policy's `retry_after_backoff` action
  (`src/llm/retry/port.ts:27-28`, `codex-spec-router.ts:67`). A real 429 already
  yields a typed reset epoch — nothing consumes it into the objective.
  Confirmed: `grep objective|recordUsage|markUsageLimited src/llm/` = 0 hits.
- **Net-positive, bounded, minimal.** `usage_limited` is the transient-reset lane
  (auto-clears at the clock instant); `budget_limited` is the hard cap. Wiring
  the real 429 epoch → `markUsageLimited` makes the transient lane fire on a
  MEASURED event instead of never, and (optionally) forwarding measured
  `outputTokens` → `port.recordUsage` removes prod budget's dependence on the
  model self-reporting honestly. Both ride the EXISTING `enforce` gate
  (`QUANTA_OBJECTIVE_BUDGET_ENFORCE`, default false ⇒ byte-identical). This is a
  thin composition adapter, not new machinery — the state machine, the reset
  clock, and the typed signals all already exist. Refute attempt FAILS: it is not
  over-engineering because it deletes a self-report trust dependency and revives
  a whole documented state on an already-available measured input.
- **Necessity caveat (honest):** efficacy of budget ENFORCEMENT on task outcomes
  is measure-first (no A/B). But that gates *enabling enforce by default*, not
  *building the producer*. The producer closes a genuine dead-state; keep it
  default-OFF like today.

**Minimal delta:** one adapter at `composeLLM` / the retry seam that (a) on a
classified rate-limit maps `parseRetryAfterMs`/snapshot-reset → absolute epoch →
`objectivePort.markUsageLimited(threadId, epoch)`, and (b) optionally forwards
terminal measured `usage.outputTokens` → `objectivePort.recordUsage`. Gate =
existing `QUANTA_OBJECTIVE_BUDGET_ENFORCE`. RED test: inject a 429 with
`retry-after`, assert derived `usage_limited` with enforce ON, `active` with OFF.

---

## ITEM 2 — Browser-tab mention source

**VERDICT: NOT-NECESSARY-DROP.**

R1 current reality:
- Mention kinds = 10, `browser-tab` ABSENT: `src/agent/mention-injection/types.ts:78-84`
  = `skill|plugin|app|file|symbol|folder|git|mcp|subagent|thread`. The three
  B4-shaped kinds (`mcp/subagent/thread`) landed under RFC-12-2. No `tab`/`browser`
  kind. The only "browser" hits in the mention slice are test tokens treating
  `@@browser` as a generic bareword (`parser.hellgate.test.ts:70-73`), not a source.
- Autocomplete `list()` = file/symbol(+kebab skill/plugin/app), plus OPTIONAL
  mcp/subagent/thread listers (`src/apps/cli/at-autocomplete/provider.ts`,
  `mention-provider-listers` from `b12f5a9bd`). No tab enumerator.

R2 adversarial (is browser-tab applicable/wanted for quanta's surfaces?):
- **quanta HAS a browser surface — but it is the WRONG kind for a tab mention.**
  `src/browser/cdp-adapter.ts:1-19`: the `BrowserPort` "spawns a headless system
  Chrome with an isolated temp profile ... tears everything down on `close()`."
  `listTabs` (`src/browser/port.ts:187-188`, `cdp-adapter.ts:94-96`) enumerates
  tabs **the AGENT itself opened** via the gated `browser_*` tools
  (`src/tool/surface/gated-tools.ts:171-180`: `browser_navigate/click/type/...`).
  It is agent-driven headless automation, NOT an interactive user browser with a
  standing tab set the user would reference.
- **The Codex/competitor "@browser-tab" concept assumes an interactive browsing
  surface** (a user's live tabs) — quanta's surfaces are CLI / Web-Tauri / IDE /
  headless; none expose user-owned browser tabs to mention. The agent's own
  ephemeral headless tabs are already in-context via `browser_snapshot` and the
  tool results; @-mentioning them is redundant with the tool loop and would point
  at a per-turn ephemeral profile that is torn down on `close()`.
- Refute attempt (could we mention agent tabs?): even if wired, it duplicates
  existing `browser_*` tool observability, targets an ephemeral isolated profile,
  and needs a new ADR + a source owner for zero user-facing surface. Per the
  surface-model rule ("don't gate absorption ROI on surface availability" cuts
  BOTH ways — here the *feature itself* has no applicable surface, not merely a
  missing one). No user asked for it. DROP.

**Delta:** none. Do not build. If a future interactive Web-Tauri browsing surface
with user-owned tabs ever ships, revisit under a new ADR then.

---

## Anti-dup summary

- Item #1 is NOT already-built and NOT in-progress: `b12f5a9bd` skipped the
  objective/LLM layers entirely; `markUsageLimited` still has zero prod callers.
  The RFC-12/13 mention+canvas landings do not touch budget. No duplicate risk.
- Item #2's *sibling* work (`@thread` lineage-scope, mention listers) landed in
  `b12f5a9bd` / RFC-12-2, but that is a DIFFERENT kind; browser-tab was never
  started and should not be. No duplicate risk — recommend DROP, not build.
