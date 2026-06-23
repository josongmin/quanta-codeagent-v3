# Jun 23 - LSP Stability Proof Final Plan

## Verdict

The current LSP stack is useful but not closed.

What is already true:

- warm workspace pooling exists;
- background prewarm exists;
- bench teardown evicts pooled sessions;
- strict presets fail closed when the required language-server binary is not
  launchable;
- the false-positive `shared session closed` warning has been reduced.

What is not yet true:

- strict mode does not prove that the task-relevant LSP workspace became
  `ready`; it proves only that a binary is launchable on `PATH`;
- runtime/report/CLI surfaces do not consume one typed LSP-grounding SSOT;
- budget exhaustion, expected cancellation, fatal transport death, and missing
  binary are not fully separated as first-class receipts;
- feature-catalog maturity/promotion language is ahead of the current proof bar.

The SOTA++ direction is not more heuristics. It is:

1. typed outcomes instead of stringly log interpretation;
2. ready-proof instead of launchability-only proof;
3. shared receipts across runtime, report, and CLI;
4. measurement-driven budget/anchor tuning, never n=1 knob twiddling.

## Current evidence

Checked against current head:

- `SharedWorkspacePool.open()` previously emitted
  `failed to ready shared nav session` for an expected bench teardown race. That
  path is now classified as an expected cancel, not a generic warning.
- `verifyStrictPresetLspGrounding(...)` in
  `src/runner/batch/eval/driver.ts` still gates strict presets on task-relevant
  language selection plus `lspBinaryAvailable(...)`; it does not run a real
  ready probe.
- remote/full-remote box wiring has a pyright launch proof and reports loud
  warnings/fail-closed behavior for missing `pyright-langserver`, but that proof
  is still launchability-only.
- `bench box ls` status can surface raw LSP symptoms such as
  `pyright warm-up budget exhausted`, but only via log-tail text, not a typed
  runtime status object.
- `tools/feature-catalog/features/09-integration/lsp-warm-backend-prewarm.yaml`
  claims `maturity: L3` with `monitoring: none`; that is acceptable for a wired
  seam, but it is not enough to claim stability closure.

## Root cause split

Do not treat all LSP problems as one bucket. There are four different failure
planes:

1. `launchability`
   The required server binary is absent or not executable.
2. `readiness`
   The binary starts, but the task-relevant workspace never reaches verified
   ready state inside budget.
3. `lifecycle`
   An otherwise healthy shared workspace is cancelled or evicted as part of
   normal session teardown.
4. `runtime utility`
   The server is ready, but a specific tool call still degrades or returns no
   useful answer.

Current code partially distinguishes 1 and 3, weakly distinguishes 2, and does
not report all four through one SSOT.

## Target architecture

Introduce one typed receipt family for LSP grounding.

```text
task-relevant files
  -> deterministic backend selection
  -> launch proof
  -> ready proof
  -> runtime session/tool receipts
  -> one typed report/CLI surface
```

Required invariants:

- strict preset authority depends on `ready proof`, not only `binary on PATH`;
- background prewarm is an optimization, never proof authority;
- expected lifecycle cancellation is observable but non-alarming;
- logs are renderers, not the only source of truth;
- box/runtime/report/CLI all consume the same typed receipt shape.

## Receipt schema

Minimum shared schema:

```ts
interface LspGroundingReceipt {
  backend: string
  language: string
  stage: "launch" | "ready" | "runtime"
  outcome:
    | "ok"
    | "missing_binary"
    | "start_failed"
    | "ready_timeout"
    | "expected_cancel"
    | "fatal_transport"
    | "tool_unavailable"
  reason?: string
  file?: string
  durationMs?: number
  fromPrewarm?: boolean
}
```

Notes:

- `expected_cancel` covers hard-evict / session abort races.
- `ready_timeout` is not the same thing as `missing_binary`.
- `tool_unavailable` is a runtime utility receipt, not admission proof.

## Ticket order

1. [LSP-00 outcome taxonomy and receipt SSOT](./tickets/LSP-00-outcome-taxonomy-and-receipt-ssot.md)
2. [LSP-01 strict ready proof](./tickets/LSP-01-strict-ready-proof.md)
3. [LSP-02 runtime/report/CLI status SSOT](./tickets/LSP-02-runtime-report-cli-status-ssot.md)
4. [LSP-03 measurement-driven anchor and budget hardening](./tickets/LSP-03-measurement-driven-anchor-and-budget-hardening.md)
5. [LSP-04 feature-catalog and promotion honesty](./tickets/LSP-04-feature-catalog-and-promotion-honesty.md)

## Non-goals

- no instance-specific path regexes or benchmark-case tables;
- no hidden oracle data;
- no "just increase timeout" tuning without receipts;
- no raw log scraping as the only runtime truth;
- no coupling this plan to LLM prompt tweaks or fallback hint strings
  (`T-104-lsp-degrade-hints` is separate).

## Promotion criteria

This plan is complete only when all of these hold:

- strict presets fail closed on missing `ready proof`, not only missing binary;
- one typed LSP receipt shape is emitted and reused by runtime, report, and
  `bench box ls`;
- expected cancellation, ready timeout, and fatal transport are distinct
  observable outcomes;
- budget tuning is backed by repeated measurements, not single-run anecdotes;
- feature-catalog language matches the achieved proof level.
