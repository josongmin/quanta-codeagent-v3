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

### One-command aggregation

After any grounding-preset run lands a `report.json`, turn it into the table:

```
bun run tools/dev/lsp-grounding-summary.ts <report.json> [more-runs.json ...]
```

Pass multiple report paths (repeated runs) — they MERGE into one distribution,
which is exactly the n>1 this protocol mandates. The tool prints grounding-row
count, per-stage outcome histograms, the three failure counts, and the ready-ms
min/median/max. (A non-grounding preset emits no `result.lspGrounding`, so the
tool reports 0 rows with a hint — that is the expected guard, not a bug.)

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

## Measurement A — local real-pyright ready-proof (token-free, no EC2)

Run via `proveStrictLspReady` directly against a small-but-real Python package
(cross-file imports + stdlib that pyright must index to resolve). Real installed
pyright-langserver; no LLM, no clone, no EC2. This VALIDATES the instrumentation
end-to-end with real timings and isolates the cold-vs-warm question; it is NOT a
substitute for the SWE-bench-repo distribution (Measurement B, below).

| arm | n | ready_ok | ready_timeout | fatal_transport | ready ms (min/med/max) |
|-----|---|----------|---------------|-----------------|------------------------|
| small pkg, cold (fresh cwd) | 5 | 5 | 0 | 0 | 14236 / 16909 / 19202 |
| small pkg, cold→warm reuse | 1+1 | ok / ok | 0 | 0 | cold 9576 → **warm 5** |
| **real bench repo (sympy, 1311 .py / 40M), cold** | 1 | 1 | 0 | 0 | **28477** |
| real bench repo (sympy), warm reuse | 1 | 1 | 0 | 0 | **16** |

Findings:
- A REAL bench repo (sympy `c50643a`, target `sympy/crypto/crypto.py`) cold-indexes
  to ready in **~28.5 s** — under the 90 s `PYRIGHT_READY_TIMEOUT_MS` budget, so it
  resolves `ok` (no timeout). Warm reuse is **16 ms**. So indexing IS slow on a real
  repo, but the current budget comfortably absorbs sympy-class repos.
- Cold ready proof on a TRIVIAL 4-file package is already ~14–19 s — pyright
  cold-start + initial index + first-definition resolve dominates.
- Warm reuse (the pool keeps the entry warm: `proveReady` releases, never evicts)
  is ~5 ms — a **~1900× speedup**. This empirically confirms prewarm/warm-pool is
  the dominant latency lever, and that the strict gate adds ~no cold overhead to
  the solve WHEN prewarm has already warmed the cwd.
- 0 ready_timeout / 0 fatal_transport here — the 90 s budget is not stressed by a
  small package. A large repo (django/sympy) cold-index will be far slower and is
  exactly where `ready_timeout` becomes plausible → that is Measurement B.

## Measurement B — SWE-bench grounding-preset slice (operator-run, pending)

The distribution that gates any budget/anchor change. Run a grounding preset
(e.g. `agentless-v3-thin-strict`) over a real pick slice (local or EC2 full-remote),
then aggregate the report(s):

```
bun run tools/dev/lsp-grounding-summary.ts <report.json> [more-runs.json ...]
```

| arm | runs | n | ready_ok | ready_timeout | expected_cancel | fatal_transport | ready ms (min/med/max) |
|-----|------|---|----------|---------------|-----------------|-----------------|------------------------|
| baseline (current budgets) | — | — | — | — | — | — | — |
| candidate (if any) | — | — | — | — | — | — | — |

NOT auto-run: it spends LLM tokens / EC2 and must not collide with a live bench
(throttle/pkill hazard). Operator triggers it; the aggregator fills the table.

## Status

- Instrumentation: LANDED (typed receipts + report/box-ls surfacing + summary + aggregator).
- Measurement A: DONE (above) — pipeline validated, warm-pool lever quantified (~1900×).
- Measurement B: PENDING an operator-run grounding bench.
- Budget/anchor change: **NONE** — `PYRIGHT_READY_TIMEOUT_MS` / `PYRIGHT_READY_RETRY_MS`
  and the anchor selector are UNCHANGED. Measurement A does not justify a change
  (small package, 0 timeouts); a change waits on Measurement B's distribution.
