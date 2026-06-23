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

## Measurement A — local real-pyright, PHASE-SEPARATED (token-free, no EC2)

Method: drive `PyrightAdapter` directly against a real bench repo (sympy
`c50643a`, fresh shallow clone), timing each phase separately —
`start()` (spawn+init) vs `prime()` (didOpen) vs the `definition` poll on the
file's first import probe (the exact readiness signal `ensurePyrightFileReady`
uses). This is the CORRECTED measurement; an earlier opaque
`proveStrictLspReady` total-wall-time run was mislabeled — see the retraction.

| file (size) | spawn | cold-server 1st resolve | polls |
|-------------|-------|-------------------------|-------|
| crypto/crypto.py (2528L) | ~0.4 s | **4.3 s** | 1 |
| core/add.py (1068L) | ~0.3 s | **9.0 s** | 1 |
| solvers/solvers.py (3594L) | ~0.2 s | **10.4 s** | 1 |
| matrices/dense.py (1446L) | ~0.2 s | **5.0 s** | 1 |

Same pyright server reused across files (warm-server path), sequential:

| call | resolve |
|------|---------|
| 1st (cold server) crypto.py | 3.4 s |
| 2nd add.py / 3rd solvers / 4th dense | **4 ms / 37 ms / 29 ms** |

Findings (machine-warm binary, fresh per-instance workspace = the realistic
per-bench-instance cold):
- **spawn ≈ 0.2–0.4 s** (pyright binary already paged in).
- **cold-server first definition resolves in ~3–10 s, in ONE poll** — pyright is
  LAZY: `definition` blocks while it binds that import's transitive subgraph,
  then returns. It does NOT return null and re-poll. Time scales with the
  symbol's dependency depth (add/solvers deeper → ~9–10 s; crypto/dense ~4–5 s).
- **warm-server subsequent files = 4–40 ms** — once the first call has bound the
  core graph, everything else is near-instant. This is the prewarm/pool lever:
  pay one ~3–10 s cold-server resolve (ideally in background prewarm), then the
  gate + solve hit ms.
- The 90 s `PYRIGHT_READY_TIMEOUT_MS` budget is ~9× the worst cold-server resolve
  observed (~10 s) — comfortable; the budget is NOT the binding constraint.

RETRACTION (jun-23): earlier rows claiming sympy "cold-index ~28.5 s" and a small
package "14–19 s" with a "~1900× speedup" were CONFOUNDED — they measured opaque
total wall-time (cold pyright/node spawn + cold-disk I/O of the 40 MB repo +
module-load), mislabeled as "indexing", and decayed across the session (28→11→9→2 s)
as the OS page cache warmed. A single `add.py` run reported ~90/101 s; that was a
cold-first-spawn fluke (clean phase-separated value: 9.0 s, never a timeout). The
phase-separated numbers above are the truth.

MACHINE-COLD first spawn (box just booted, pyright/node/repo not yet paged from
disk) could NOT be isolated here — dropping the OS page cache needs `sudo purge`.
It is a ONE-TIME-per-box cost; the early opaque ~28–30 s is the rough ceiling for
it. So budget for up to ~30 s on the very first LSP call per box; every call after
is cold-server (~3–10 s) or warm (ms).

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

- Instrumentation: LANDED (typed receipts + report/box-ls surfacing + summary + aggregator
  + `QUANTA_LSP_READY_TIMEOUT_MS` knob).
- Measurement A: DONE + CORRECTED (phase-separated) — spawn ~0.3 s, cold-server first
  resolve ~3–10 s (1 poll), warm-server ~ms. pyright is lazy/fast; the earlier
  "~28 s indexing / 1900×" was a confounded opaque-wall-time mislabel (retracted above).
- Measurement B: PENDING an operator-run grounding bench.
- Budget/anchor change: **NONE** — `PYRIGHT_READY_TIMEOUT_MS` (90 s) is ~9× the worst
  cold-server resolve (~10 s) and comfortably covers the one-time machine-cold first
  spawn (~30 s ceiling), so it is NOT the binding constraint. The knob lets an operator
  raise it per-run; the default waits on Measurement B's distribution before any change.
