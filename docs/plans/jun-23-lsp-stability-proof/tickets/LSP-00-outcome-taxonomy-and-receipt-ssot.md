# LSP-00 - outcome taxonomy and receipt SSOT

## Goal

Replace stringly LSP failure interpretation with typed receipts that separate
launch failure, ready failure, expected cancellation, and runtime utility loss.

## Problem

Current behavior is split across:

- warnings from `src/agent/lsp-workspace-pool.ts`;
- launchability checks in `src/runner/batch/eval/driver.ts`;
- remote box probes in `src/apps/bench/remote/box-session.ts`;
- raw log tails shown by `bench box ls`.

The same user-visible symptom can currently mean different technical realities.
That prevents clean fail-closed behavior and blocks honest reporting.

## Deliverable

Add a small typed receipt/result layer shared by:

- pool/open paths;
- strict gating;
- remote launch/readiness probes;
- report/CLI rendering.

Suggested shapes:

- `LspGroundingOutcome`
- `LspGroundingReceipt`
- `LspGroundingStatus`

Keep this layer deterministic and benchmark-blind.

## Required outcomes

At minimum:

- `ok`
- `missing_binary`
- `start_failed`
- `ready_timeout`
- `expected_cancel`
- `fatal_transport`
- `tool_unavailable`

## Acceptance

- unit tests prove expected-cancel does not share the same classification as
  real start/warm failure;
- strict gate, remote probe, and pool wiring all produce the typed outcomes;
- no consumer has to parse a log line to know which outcome occurred.
