# LSP-03 - measurement-driven anchor and budget hardening

## Goal

Tune anchor selection and readiness budgets from repeated measurements, not
single-run anecdotes.

## Problem

The current stack can report symptoms such as `pyright warm-up budget exhausted`,
but without typed receipts and repeated measurement it is too easy to react with
magic timeout changes.

## Deliverable

Instrument at least these quantities:

- selected anchor file;
- selected backend/language;
- launch duration;
- ready duration;
- first real tool-call latency;
- count of `ready_timeout`;
- count of `expected_cancel`;
- count of fatal transport failures.

Use those receipts to evaluate:

- whether the current anchor selection is good enough;
- whether ready budgets are too low or too high;
- whether prewarm materially improves first-call latency in bench.

## Protocol

- repeated runs, not n=1;
- same preset/config across arms;
- separate infra/ops failure from real ready-path failure;
- no budget change without before/after receipt comparison.

## Acceptance

- a short measurement report exists for the chosen target set;
- any budget or anchor-policy change is justified by that report;
- no timeout increase lands without typed receipt evidence.
