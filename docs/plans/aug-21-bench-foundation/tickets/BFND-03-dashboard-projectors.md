# BFND-03 — dashboard suite-projector registry

**Priority:** P0

**Depends on:** BFND-01, BFND-02

## Goal

Make the dashboard a deterministic renderer of canonical report metrics with one
suite dispatch seam and no browser/server-side duplicate scoring authority.

## Layout

```text
tools/leaderboard-dashboard/
  projectors/
    registry.ts
    swe-bench.ts
    swe-bench/
      registry.ts
    terminal-bench.ts
  server.ts
```

- Registry dispatches by `benchmarkSuite`.
- The SWE projector delegates `datasetFamily` rendering to one UI-only
  family-view registry; PMX-05 registers `promax` there.
- The Terminal projector handles versioned trial reports.
- Family-specific helpers may format persisted metrics but may not aggregate raw
  rows into a second headline score.

## Grouping identity

The generic campaign key starts with suite identity. Each projector adds its
required dimensions:

- SWE: dataset family/dataset ref, model, preset, budgets, relevant grader config;
- Terminal: benchmark version/dataset ref, profile, model, effort, sandbox, `k`,
  and standard-config admission.

Reports with incompatible identities never coalesce.

## Migration rules

- Move existing SWE behavior behind `swe-bench.ts` without semantic drift.
- Remove Terminal-as-dataset-family branches and any-pass headline projection.
- Establish the UI-only SWE family-view registry with existing family defaults;
  it must not duplicate T4's runtime parser/grader/bootstrap behavior.
- Add ProMax later as one family helper registration consumed only by the SWE
  projector.
- Keep official external-data importers offline, immutable-ref-pinned, and
  separate from report scoring.
- Extract touched logic from the existing god-module `server.ts`; do not add an
  allowlist entry or grow embedded parsers.

## RED rails

- `server.ts` branching directly on `promax` or `terminal-bench` fails.
- Terminal routing through `datasetFamily` fails.
- ProMax routing as a top-level suite fails.
- Scattered `datasetFamily === "promax"` branches outside the SWE family-view
  registration/helper fail.
- A projector recomputing canonical headline totals from raw rows fails.
- Cross-suite/family campaign coalescing fails.
- Hostile external fields must remain escaped.

## Proof rails

```sh
bun test tools/leaderboard-dashboard/projectors
bun test tools/leaderboard-dashboard/server.test.ts
bun test tests/unit/god-code-ratchet.test.ts
bun run typecheck
bun run lint
```

Tests must cover legacy SWE, ProMax SWE-family reports, Terminal reports, invalid
identity, and mixed report roots. Structural guards require call/registration
patterns, known floors, and red-on-injection.

## Definition of done

- One registry dispatches every canonical report.
- One nested UI registry dispatches SWE family views; ProMax and Terminal extend
  different projector levels.
- Dashboard cards/tables consume persisted metrics.
- `server.ts` is smaller at touched boundaries and contains no product scorer.
