# LSP-02 - runtime/report/CLI status SSOT

## Goal

Expose one typed LSP-grounding status across runtime results, reports, and
`bench box ls`.

## Problem

Today the user often learns about LSP state indirectly:

- a degraded verdict message;
- a warning log;
- a raw `lastLogLine` in `bench box ls`.

That is not SSOT and makes RCA slower than it should be.

## Deliverable

Add one status object that can be rendered in:

- per-instance result JSON;
- summary report JSON;
- remote box snapshot/runtime probe;
- `bench box ls` human-readable output.

Suggested fields:

- `backend`
- `language`
- `launch`
- `ready`
- `runtime`
- `durationMs`
- `reason`

The renderer may stay compact; the storage and transport shape must be typed.

## Out of scope

- no broad UI redesign;
- no prompt changes;
- no new benchmark authority.

## Acceptance

- `bench box ls` no longer depends on raw log-tail strings to distinguish
  `missing_binary` vs `ready_timeout` vs `expected_cancel`;
- report rows preserve the typed LSP state for unresolved/degraded cases;
- the runtime probe and local report agree on the same status enum.
