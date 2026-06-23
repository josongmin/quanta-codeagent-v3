# LSP-03 — measurement protocol & report skeleton

This is the protocol the plan's promotion criteria require before ANY budget or
anchor-policy change lands. No timeout/anchor knob moves on an n=1 anecdote.

## What is now instrumented (typed, no log scraping)

Every grounding-preset instance emits a typed `LspGroundingReceipt`
(`src/shared/lsp-grounding-receipt.ts`) carrying:

- `backend`, `language`, `stage` (`launch` | `ready` | `runtime`), `outcome`;
- `durationMs` — wall time of the ready proof;
- `reason` — the specific failure detail.

It is folded into a `LspGroundingStatus` and stored on:

- `report.json` per-instance row → `result.lspGrounding` (LSP-02);
- `bench-box-status.json` → `box ls` `lsp=…` line (LSP-02).

`summarizeGroundingStatuses(statuses)` folds a set of those into an
`LspGroundingSummary`: per-stage outcome histogram, `readyTimeouts`,
`expectedCancels`, `fatalTransports`, and the sorted `readyDurationsMs`
(min/median/max in one pass). That is the measurement primitive.

## Quantities to read (LSP-03 deliverable list)

For a chosen target set (e.g. the SWE-bench grounding-preset slice):

1. selected anchor file + backend/language — `lspGrounding.backend` / probe log;
2. ready duration distribution — `summary.readyDurationsMs`;
3. `ready_timeout` count — `summary.readyTimeouts`;
4. `expected_cancel` count — `summary.expectedCancels` (must NOT count as failure);
5. `fatal_transport` count — `summary.fatalTransports`;
6. first real tool-call latency — from the runtime nav stream (separate tap).

## Protocol (binding)

- repeated runs, NOT n=1; same preset/config across arms;
- separate infra/ops failure (`fatal_transport`, `expected_cancel`) from real
  ready-path failure (`ready_timeout`) — only the latter argues for a budget
  change;
- no budget/anchor change without a before/after `LspGroundingSummary` comparison
  recorded below.

## Status

- Instrumentation: LANDED (typed receipts + report/box-ls surfacing + summary).
- Budget/anchor change: **NONE this turn** — `PYRIGHT_READY_TIMEOUT_MS` /
  `PYRIGHT_READY_RETRY_MS` and the anchor selector are UNCHANGED. Per the plan's
  non-goals, no timeout was increased without receipt evidence. Tuning is gated
  on a live measurement run on the user's box (offline harness here cannot
  produce a fair latency distribution), filled into the table below.

## Measurement report (fill on a live run)

| arm | runs | n | ready_ok | ready_timeout | expected_cancel | fatal_transport | ready ms (min/med/max) |
|-----|------|---|----------|---------------|-----------------|-----------------|------------------------|
| baseline (current budgets) | — | — | — | — | — | — | — |
| candidate (if any) | — | — | — | — | — | — | — |

Decision: _record here only after the table is populated from repeated runs._
