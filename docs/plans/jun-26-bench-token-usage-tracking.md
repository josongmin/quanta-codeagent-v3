# Plan: bench token-usage / cost tracking (report/schema SSOT gap)

date: 2026-06-26
owner: bench
status: DONE (verified 2026-06-27 — all four gaps closed in code + hellgated)

## Closure verification (2026-06-27)

Audit found every gap already implemented on head; tests pin it:

- **Gap 1 (report serialization) — CLOSED.** `buildReport` (`src/runner/batch/report.ts`)
  forwards `usage` + `durationMs` into `perInstance[]` (the optional-fence spreads
  at the `results.map(...)` site). `PerInstanceReport` declares both fields.
- **Gap 2 (lossy schema) — CLOSED.** `InstanceUsage` (`src/runner/batch/types.ts`)
  carries `cacheReadTokens?` / `cacheCreationTokens?` with provider-semantics docs;
  `UsageTap` (`src/runner/batch/observe.ts`) accumulates BOTH and emits them in
  `total()`.
- **Gap 3 (duplicate pricing) — CLOSED.** `src/apps/bench/analyze/cost.ts` imports
  `costUsd` from `@/observability` (the versioned pricing SSOT) and no longer carries
  a private `DEFAULT_PRICING` table; cache-read is threaded into the cost call.
- **Gap 4 (unknown-pricing honesty) — CLOSED.** cost rows carry a `known` flag so a
  priced-as-zero model is distinguishable from a genuinely-free one (no fake `$0`).

Hellgate coverage (green): `tests/unit/bench-token-usage-report.test.ts`,
`tests/unit/eval-runner-token-cost.test.ts`, `tests/unit/bugbash-fix-cost.test.ts`
(16 tests), plus `tests/integration/bench-{observability,cost-cli-e2e}.test.ts`.

Original plan retained below for provenance.

## Problem

Current bench cost analysis is not trustworthy on current reports:

- `src/apps/bench/analyze/cost.ts` expects `report.json perInstance[].usage` plus
  `durationMs`.
- current bench reports do not reliably carry those fields, so cost analysis
  falls back to zeros or `observe/` backfill.
- result: we do not have a stable per-run token / cost SSOT for local or
  full-remote bench campaigns, including the Jun-26 red-7 run family.

## Verified current state

This is **not** currently proven to be a `chatgpt-oauth` adapter parse gap.

1. `chatgpt-oauth` delegates to the shared Responses streaming path:
   `src/llm/adapters/chatgpt-oauth.ts` → `streamResponsesSurface(...)`.
2. the shared Responses parser already reads usage from
   `response.completed` and `response.incomplete`, then emits `type:"usage"`:
   `src/llm/openai-responses-wire.ts`.
3. bench runtime already has a usage accumulator:
   `src/runner/batch/observe.ts` `UsageTap`.
4. bench driver already attaches `extra.usage = wiring.usage?.total()` and
   `extra.durationMs` onto `InstanceResult`.

So the stream-time usage path appears to exist on current head.

## Actual gaps

### Gap 1 — report serialization gap

`InstanceResult` already has `usage?: InstanceUsage` and `durationMs?: number`,
but `src/runner/batch/report.ts` `PerInstanceReport` does not serialize them
into `report.json`.

Effect:

- runtime may observe usage correctly
- `report.json` still omits it
- `cost.ts` path-1 contract is broken

### Gap 2 — bench usage schema is lossy

Bench usage rollup currently preserves only:

- `model`
- `inputTokens`
- `outputTokens`

But the stream-level usage contract already allows:

- `cacheReadTokens`
- `cacheCreationTokens`

and provider usage may also carry reasoning-token sub-buckets.

Effect:

- OpenAI cached-input discount cannot be derived exactly from bench report SSOT
- Anthropic cache-read accounting is dropped
- reasoning-heavy runs cannot be analyzed beyond coarse output totals

### Gap 3 — duplicate / weaker cost-pricing path

`src/apps/bench/analyze/cost.ts` carries its own placeholder `DEFAULT_PRICING`
table and simple `input * price + output * price` math.

Repo already has a stronger pricing SSOT in `src/observability/pricing.ts`:

- provider-aware cache math
- explicit `PRICING_VERSION`
- shared `costUsd(...)`

Effect:

- bench cost analysis can drift from observability cost math
- adding models in one place does not fix the other place
- cached-input costs are easy to misprice

### Gap 4 — source-of-truth split is still unproven on a live artifact

Code audit says the adapter path is probably fine, but we still need one live
`observe/*.jsonl` or current-head run receipt to answer the narrower question:

- are `llm_usage` events actually present for `chatgpt-oauth` bench runs?

Until that artifact check is done, "adapter broken" remains unverified.

## Implementation plan

1. **Prove the failing layer first.**
   Inspect one current-head bench artifact:
   - if `observe/*.jsonl` contains `llm_usage`, the adapter/stream path is fine
     and the fix starts at report serialization.
   - if `observe/*.jsonl` is missing `llm_usage`, narrow the failure to adapter /
     stream / recorder before touching report code.

2. **Make bench usage schema non-lossy.**
   Extend `InstanceUsage` and `UsageTap` to preserve the stream-level buckets we
   already know how to observe:
   - `inputTokens`
   - `outputTokens`
   - `cacheReadTokens?`
   - `cacheCreationTokens?`
   - optional reasoning sub-bucket only if we thread it end-to-end cleanly

3. **Serialize usage into `report.json`.**
   Update `src/runner/batch/report.ts` so `PerInstanceReport` writes:
   - `usage`
   - `durationMs`
   - optional `patchPath` only if we want report consumers to rely on it

   This is the critical repair for `cost.ts` path-1.

4. **Unify cost math with observability SSOT.**
   Reuse `src/observability/pricing.ts` instead of growing a second price table
   inside `src/apps/bench/analyze/cost.ts`.

   Requirements:
   - unknown model stays honest (`null` / visible caveat, never fake `$0`)
   - OpenAI cached input is repriced, not double-counted
   - Anthropic cache read remains additive at discounted rate
   - pricing output remains versionable / auditable

5. **Keep `observe/` as fallback, not primary truth.**
   `cost.ts` may still backfill from trajectories when report usage is missing,
   but the main SSOT should become `report.json`.

6. **Add operator-visible surfacing only after SSOT is fixed.**
   Surface tokens / cost in:
   - `quanta-bench cost`
   - any report-derived summary block that already reads `report.json`

   Do not claim a summary surface exists today unless it actually does.

## Tests (hellgate)

- **Report serialization test:** build a report from `InstanceResult` carrying
  `usage` + `durationMs` and assert those fields land in `perInstance[]`.
- **UsageTap accumulation test:** multiple `usage` events in one instance sum
  correctly, including cache buckets when present.
- **Cost math test:** bench cost analysis reuses provider-aware pricing logic and
  prices cached OpenAI input correctly.
- **Unknown pricing honesty test:** tokens present + no model price must render
  a visible caveat, never a fake `$0.00`.
- **Live-artifact proof test or fixture:** a `chatgpt-oauth` Responses-stream
  fixture or captured observe file proves whether `llm_usage` exists on the
  current path.

## Non-goals

- this plan does **not** change agent behavior, selection behavior, or benchmark
  scoring logic.
- this plan does **not** add a default-OFF knob; usage tracking is telemetry.
- this plan does **not** assume upstream mini/live-swe cost tracking and our
  scaffold report tracking are the same system.

## Notes

- Treat this as a **bench report SSOT alignment** task first, not a speculative
  adapter rewrite.
- If we choose to preserve reasoning-token sub-buckets, do it as an explicit
  schema extension end-to-end; do not half-thread it in one layer only.
- Related: `src/runner/batch/report.ts`, `src/runner/batch/observe.ts`,
  `src/apps/bench/analyze/cost.ts`, `src/observability/pricing.ts`.
