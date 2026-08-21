# Shared benchmark foundation — ticket backlog (SSOT)

Status: **PLANNED**

This packet is the only owner of framework changes shared by SWE-bench families
and Terminal-Bench. Product packets register suite/family-specific behavior but
must not redefine these contracts.

## Outcome

The common foundation provides:

1. one typed suite/config composition boundary;
2. one canonical report envelope, writer, and result mirror;
3. one dashboard suite-projector registry; and
4. structural rails proving that product packets did not create duplicate owners.

## Canonical hierarchy

```text
BenchmarkSuite
├── swe-bench
│   └── DatasetFamily
│       ├── verified
│       ├── live
│       ├── pro
│       └── promax
└── terminal-bench
    └── benchmarkVersion = 2.1
```

`DatasetFamily` is nested under `swe-bench`. Terminal-Bench is never represented
as a dataset family. ProMax is never represented as a top-level suite.

## Owner map

| Concern | Canonical owner | Product extension | Forbidden duplicate |
|---|---|---|---|
| CLI and suite dispatch | `src/apps/bench/cli.ts` | SWE uses existing run/grade commands; Terminal registers `terminal` | another executable composition root |
| typed run config | jun-30 T2 plus `src/apps/bench/benchmark-suite.ts` | discriminated suite config branches | argv-to-env as an in-process authority or product resolver |
| SWE family behavior | jun-30 T4 `DatasetFamilyProfile` registry | one `promax` profile | Terminal as a family or scattered family branches |
| canonical report persistence | `src/runner/batch/report.ts` or cohesive siblings | SWE and Terminal payload builders call one writer | product writer, schema root, or results directory |
| dashboard dispatch | `tools/leaderboard-dashboard/projectors/registry.ts` plus SWE family-view registry | SWE and Terminal suite projectors; one ProMax family registration inside SWE | product branch in `server.ts` or browser-side score authority |

Suite-specific evaluator/trial receipts remain distinct payloads. Sharing a
writer does not mean forcing Harbor trials and SWE official-grade dispositions
into one semantic type.

## Tickets

| ID | Title | Depends on |
|---|---|---|
| [BFND-01](./BFND-01-suite-and-config.md) | Suite discriminator and typed config union | jun-30 T2 |
| [BFND-02](./BFND-02-canonical-report-envelope.md) | Canonical report envelope and persistence | BFND-01 |
| [BFND-03](./BFND-03-dashboard-projectors.md) | Dashboard suite-projector registry | BFND-01, BFND-02 |

Jun-30 T4 is an additional ProMax prerequisite because ProMax extends the SWE
family registry. Terminal registration does not wait for T4 once BFND-01 has
established the outer suite boundary.

## Cross-packet execution order

```text
freeze combined dirty-state snapshot
  -> jun-30 T2
  -> BFND-01
     -> jun-30 T4 -> PMX-01..04
     -> TB21-00A..03
  -> BFND-02
     -> PMX-03/05 report integration
     -> TB21-04 report integration
  -> BFND-03
     -> PMX-05 SWE/ProMax projection
     -> TB21-05 Terminal projection
  -> independent PMX and Terminal canary/full gates
```

Generic foundation edits land once. The second product packet consumes the
landed contract and adds only its branch/registration.

## Global RED rails

- `datasetFamily: "terminal-bench"` is invalid everywhere.
- `benchmarkSuite: "promax"` is invalid everywhere.
- A new product report writer, results root, config resolver, or dashboard scorer
  fails the owner audit.
- A static guard matching only an import/comment/bare identifier is invalid.
- A legacy report may be normalized only at one read boundary and can never be
  guessed into Terminal-Bench or ProMax.

## Global proof rails

```sh
bun test src/apps/bench/benchmark-suite.test.ts
bun test tests/unit/apps/bench/batch-report-schema-parity.test.ts
bun test tools/leaderboard-dashboard/projectors
bun test tests/unit/god-code-ratchet.test.ts
bun run typecheck
bun run lint
git diff --check
```

Every structural rail must assert a known-item floor and prove red-on-injection.
Directory-based test commands must prove they selected at least one test.

## Foundation definition of done

- One `BenchRunConfig` discriminated union reaches all suite composition paths.
- One report writer/mirror persists both suite report branches.
- One dashboard registry dispatches both suites; ProMax is a SWE family view.
- Existing SWE default behavior remains compatible.
- Source-owner inventory has no unclassified duplicate definition, resolver,
  writer, aggregator, or projector.
