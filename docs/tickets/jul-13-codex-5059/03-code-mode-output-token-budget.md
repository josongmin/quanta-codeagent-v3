# C5059-03 — Exact code-mode output-token budget

- **Priority:** P1
- **Class:** TRUE-GAP; exactness prerequisite missing
- **Effort:** S/M after prerequisite
- **Status:** BLOCKED
- **Dependencies:** C5059-01 continue verdict; active-model exact `TokenCounterPort`

## Goal

Support first-line `// @exec: {"max_output_tokens": N}` without mislabelling the repo's `chars/4` estimate or byte cap as an exact token limit.

## Blocking fact

`BudgetMeter` and pricing consume provider-reported usage after model calls. They do not tokenize arbitrary code-cell output. The general agent estimator is `chars/4`; it is not exact for code, JSON, Unicode, or provider-specific tokenizers.

## Prerequisite

Establish one active-model `TokenCounterPort`:

```ts
interface TokenCounterPort {
  readonly modelId: string
  count(text: string): number
}
```

- The adapter must match the model that will receive the cell result.
- Absence or model mismatch must reject `max_output_tokens`; no heuristic fallback.
- The existing byte output cap remains the absolute memory/transport ceiling.

## Work

1. Parse only an optional first-line pragma with a closed schema.
2. Reject malformed JSON, unknown keys, duplicate pragma lines, non-positive/non-integer values, and values above the host ceiling.
3. Apply both limits: exact token budget and existing byte cap; the first exceeded limit determines the typed truncation reason.
4. Make truncation Unicode-safe and deterministic.
5. Do not accept `yield_time_ms` until resumable cell execution exists. Unknown `yield_time_ms` is an error, not an inert accepted field.

## Acceptance

- Exact boundary cases at N-1, N, and N+1 tokens are pinned using the production tokenizer adapter.
- Code/JSON/CJK/emoji fixtures prove the behavior is not `chars/4` or JS string length.
- Model mismatch or missing tokenizer rejects the pragma before cell execution.
- The hard byte cap still terminates pathological output even when token count is below N.
- Default behavior without the pragma is byte-identical.

## Kill rule

If no exact tokenizer can be supplied for all supported active models, retain `outputCap` in bytes and close this ticket as NO-GO. Do not ship an approximate `max_output_tokens` contract.

