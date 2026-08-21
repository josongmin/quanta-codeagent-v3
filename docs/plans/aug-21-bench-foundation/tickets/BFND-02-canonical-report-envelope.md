# BFND-02 — canonical report envelope and persistence

**Priority:** P0

**Depends on:** BFND-01

## Goal

Generalize the existing report type boundary without creating another writer,
result root, mirror, or scoring authority.

## Contract

```ts
type CanonicalBenchReport = SweBenchReport | TerminalBenchReport

interface SweBenchReport {
  benchmarkSuite: "swe-bench"
  datasetFamily: DatasetFamily
  // existing SWE report fields; typed family/grader sections may extend this branch
}

interface TerminalBenchReport {
  benchmarkSuite: "terminal-bench"
  benchmarkVersion: "2.1"
  datasetRef: string
  // lossless Harbor trials and precomputed official-shaped metrics
}
```

`OfficialGradeReceipt`/`OfficialGradeTotals` may later extend the SWE grading
branch without changing this envelope. Terminal lossless trial receipts remain a
distinct branch.

## Persistence rules

- `src/runner/batch/report.ts` or cohesive siblings own serialization.
- Existing `writeReport`/`mirrorReportToSsot` remain the only persistence path.
- Product builders return typed report objects and call the canonical writer.
- Large raw artifacts remain digest-linked beside reports.
- A single read-normalization boundary may accept legacy SWE reports lacking
  `benchmarkSuite`; it normalizes only to legacy `swe-bench`.
- New Terminal and ProMax artifacts require explicit identity. No inference from
  filenames, fields, or dataset strings.

## RED rails

- Terminal report containing `datasetFamily` fails schema validation.
- ProMax report outside the `swe-bench` branch fails.
- Product code calling `Bun.write` for a report instead of `writeReport(` fails.
- A second results directory/mirror owner fails.
- Missing or unknown suite identity on a new report fails.
- Existing SWE report round-trip or mirror behavior regression fails.

## Proof rails

```sh
bun test tests/unit/apps/bench/batch-report-schema-parity.test.ts
bun test src/runner/batch/report*.test.ts
bun run typecheck
bun run lint
git diff --check
```

The ownership guard must match live `writeReport(` calls, assert known product
callers, and prove red-on-injection. An import-only match is vacuous.

## Definition of done

- SWE/ProMax and Terminal reports form one discriminated union.
- Both branches use the same writer and canonical result mirror.
- Suite-specific receipt semantics remain lossless and separate.
- Legacy SWE compatibility exists at one explicit read boundary only.
