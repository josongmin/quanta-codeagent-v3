# ADR-0190: Test harness consolidation — shared slice-boundary scanner + parity tables

- Status: Accepted
- Date: 2026-05-25
- References: slice-boundary tests (S4), ADR-0124 / ADR-0184 conversation-checkpoint parity

## Context

The unit/integration test suite grew faster than `src/` because agent OS contracts,
feature-catalog evidence paths, and ADR hellgates each pin behaviour in dedicated files.
Audit found structural duplication (not missing coverage):

- 16× nearly identical slice-boundary scanners (~3.5k LOC)
- Twin hellgates (e.g. Map vs LRU checkpoint) with copy-pasted 23-case batteries
- `admissibility-wave-a.test.ts` at 1.4k LOC (review/merge cost)
- Inline CLI heuristic mirrors in integration tests
- Smoke skips allowed but invisible in all-green CI

## Decision

1. **`tests/unit/_arch/slice-boundary-scanner.ts`** — one engine; per-slice policy in
   **`slice-boundary-configs.ts`**. Existing `*-slice-boundary.test.ts` paths unchanged
   (catalog evidence, CI filters).

2. **`tests/unit/_parity/checkpoint-parity.ts`** — shared 23-case table; Map and LRU
   hellgates only wire factories (`HELL-*` / `LRU-*` prefixes preserved).

3. **`tests/integration/admissibility-wave-a/`** — shared `_fixtures.ts` + split suites:
   `bypass-and-rules`, `reviewer-dispatch`, `sticky-and-harddeny`, `clock-and-edges`.

4. **`tests/integration/_harness/cli-path-tokens.ts`** — SSOT for `isPathLikeToken`
   (resume e2e imports via `_harness`).

5. **Smoke battery** — `afterAll` warns on skips; fails when skip count exceeds threshold
   (`MAX_ALLOWED_SKIPS = 8`) so pending trajectories cannot hide indefinitely.

## Consequences

- **Coverage unchanged** — same invariants, less copy-paste.
- **Next parity targets** (follow-up PRs): csv-read/lib, lsp-atomic-write, bedrock/foundry,
  SKILL bundle contract table.
- **Rule changes** — edit `_arch/slice-boundary-configs.ts` once, not 16 files.

## Verification

```sh
bun test tests/unit/*slice-boundary*
bun test tests/unit/conversation-checkpoint-hellgate.test.ts
bun test tests/unit/conversation-checkpoint-lru-hellgate.test.ts
bun test tests/integration/admissibility-wave-a/
bun test tests/unit/smoke-battery.test.ts
bun test tests/integration/resume-e2e.test.ts
```
