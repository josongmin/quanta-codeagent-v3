# ADR-0177: CSV parser — swap self-rolled tokenizer for `csv-parse@6.x`

- Status: Accepted (supersedes the INTERNALS of ADR-0133's `csv-parse.ts`
  for new callers — the public {`CsvParseResult`, `csv_read` tool} surface
  stays byte-identical; self-impl kept as the zero-dep default for back-compat)
- Date: 2026-05-25
- Related: ADR-0133 / ADR-0147 (document slice — original `csv_read` +
  pure `parseCsv`), ADR-0172 (the same "외부 거 써" pattern applied to
  coverage: c8 swap), the parallel turndown / lru-cache / write-file-atomic
  sibling swaps on this same date
- SOTA reference: **`csv-parse`** (https://github.com/adaltas/node-csv) —
  Adaltas's RFC-4180 parser maintained since 2010, ~5M weekly downloads, the
  de-facto Node CSV parser. Covers the same surface our self-impl covers
  (quoted fields, escaped quotes, CRLF, ragged rows, unterminated quotes)
  plus BOM, comments, casting, streaming, info / raw metadata.

## Context

ADR-0133 stood up `src/tool/document/csv-parse.ts` — a ~280 LOC hand-rolled
RFC-4180 tokenizer with a custom two-state machine (`Field` / `Quoted`),
look-ahead for `""` escape and CRLF coalescing, and a closed-union
`CsvParseDiagnostic { unterminated-quote | ragged-row | empty-input }`. It
works and the existing hellgate (8 A-block cases in
`tests/unit/tool/csv-read-hellgate.test.ts`) seals its behavior. But:

- The user principle is explicit: **"외부에 잘 만들어진 거 있으면 외부 거 써."**
- `csv-parse@6.2.1` is already installed as a direct dependency (verified via
  `package.json` + `node_modules/csv-parse/`).
- The lib covers every corner our self-impl covers AND more (BOM, info, raw,
  streaming) — and is fuzz-tested + property-tested upstream against the full
  RFC-4180 grammar.

Negative invariants we are NOT violating:
- `CsvParseResult` (+ `CsvCell` / `CsvRow` / `CsvParseDiagnostic` /
  `CsvParseOpts` / `CsvParserInputError`) stays byte-identical. No import
  re-routing required at any call site.
- `csv_read` tool surface stays UNCHANGED in this slice — the tool continues
  to call `parseCsv` (self-impl) by default. Migration to `parseCsvLib` is a
  follow-up after corpus calibration (see Follow-up below).
- The self-impl file (`csv-parse.ts`) stays on disk. It is the zero-dep
  fallback for back-compat and regression triage. Deprecation requires another
  ADR after corpus calibration.

## Decision

A thin adapter `src/tool/document/csv-parse-lib.ts` (~210 LOC) calling
`parse` from `csv-parse/sync` with the tuning that matches our self-impl
semantics:

```
parse(source, {
  delimiter,                  // "," default, "\t" for TSV, multi-char → first char
  columns: false,             // we receive string[][], then peel the header row
  relax_column_count: true,   // ragged rows pass; we synthesize per-row diag
  relax_quotes: true,         // best-effort instead of throw on quote violations
  raw: true,                  // every record carries its source text
  info: true,                 // for line-number reconstruction (we count \n in
                              // preceding `raw` segments to get START line —
                              // `info.lines` is END line, which disagrees on
                              // records with embedded \n inside quoted cells)
  bom: false, trim: false, skip_empty_lines: false,
})
```

Layout:

```
src/tool/document/
  csv-parse.ts        — UNCHANGED. Self-rolled tokenizer (~280 LOC).
  csv-parse-lib.ts    — NEW. csv-parse@6.2.1 adapter (~210 LOC). Same shape.
  csv-read.ts         — UNCHANGED in this slice; tool still routes to
                         `parseCsv` (self-impl) by default. Migration to
                         `parseCsvLib` is a follow-up after corpus calibration.
  index.ts            — adds `export { parseCsvLib }`.
```

Diagnostic mapping:

| lib surface                                  | our diagnostic kind        |
|----------------------------------------------|----------------------------|
| `CSV_QUOTE_NOT_CLOSED` (CsvError)            | `unterminated-quote`       |
| `INVALID_OPENING_QUOTE` (CsvError)           | `unterminated-quote`       |
| any other unhandled CsvError                 | `unterminated-quote` (closed-union policy — we DO NOT widen the union) |
| `relax_column_count` row-by-row length check | `ragged-row` (per-row, synthesized)   |
| `source.length === 0` OR `records.length === 0` | `empty-input`           |

Throw vs no-throw: the lib throws `CsvError` for quote violations even with
`relax_quotes: true` in some corners. The adapter catches, seeds the
diagnostic, and FALLS BACK to a second `parse` call without `raw/info` to
extract whatever rows the lib could still surface. If even that throws, the
adapter returns the empty result with the seeded diagnostic — no exception
leaks out (parity with self-impl's no-throw contract).

## Hellgate (12 cases — `tests/unit/csv-parse-lib-hellgate.test.ts`)

Each case asserts `parseCsvLib(input, opts)` matches `parseCsv(input, opts)`
shape-for-shape (headers / rows-with-line-numbers / diagnostic-kind-per-row):

| # | case                            | parity                                  |
|---|---------------------------------|-----------------------------------------|
| 1 | simple 3-row CSV                | byte-equal headers/rows/diagnostics     |
| 2 | TSV (`\t` delimiter)            | byte-equal                              |
| 3 | quoted comma inside cell        | byte-equal                              |
| 4 | escaped `""` inside quoted cell | byte-equal                              |
| 5 | CRLF terminators                | byte-equal                              |
| 6 | unterminated quote              | diagnostic kind parity (rows may differ on recovery) |
| 7 | ragged row (per-row diagnostic) | byte-equal (2 ragged rows, 3 emitted)   |
| 8 | empty input                     | byte-equal (`empty-input` diagnostic)   |
| 9 | `noHeader: true`                | byte-equal (headers=null, 3 data rows)  |
|10 | multi-char delimiter collapse   | byte-equal (`,;` → `,`)                 |
|11 | non-string input                | both throw `CsvParserInputError`        |
|12 | 50-row stress                   | byte-equal headers + rows               |

## Alternatives rejected

- **`papaparse`.** Browser-focused, larger surface (Web Workers / streaming
  via callbacks), bundles a polyfill layer we do not need. `csv-parse` is
  Node-native and matches our usage pattern (server-side sync parse of a
  bounded-size string already in memory).
- **`fast-csv`.** Heavier (multi-package monorepo: parse / format / lib),
  stream-first API. For a pure `string → result` boundary, `csv-parse/sync`
  is strictly smaller surface.
- **Keep self-impl only.** Re-litigation of the user principle. The
  self-impl works, but it is a hand-rolled state machine in a codebase that
  already has the canonical lib as a direct dep. Maintaining it is
  re-implementing what 5M weekly users already trust.
- **Delete self-impl after the swap.** Premature. The self-impl is the
  zero-dep fallback; the `engine: "self"` route lets us triage any future
  lib divergence without an emergency revert. Soft deprecation after corpus
  calibration is the safer path.

## SOTA realignment

Per the 2026-05-23 four-way audit (`agent-loop-4way-comparison`),
Cursor/Codex/Claude Code expose ZERO in-agent CSV-reading tools. quanta
uniquely surfaces `csv_read` as an agent-callable, with typed diagnostics for
ragged/quote-malformed rows. Only the BACKEND of that tool is being swapped
— the unique-vs-competitor surface (and the diagnostic vocabulary that makes
it agent-friendly) is unaffected.

## Migration

- **No call-site change required.** Existing callers of `parseCsv` continue
  to call `parseCsv`. New callers may opt into `parseCsvLib`; both return
  the same `CsvParseResult`.
- **`csv_read` default unchanged in this slice.** The tool continues to call
  `parseCsv` (self-impl). A separate follow-up ADR flips the default after
  corpus calibration.
- **No new dependency added.** `csv-parse@6.2.1` is already a direct dep.

## Follow-up

- After a representative-corpus run (smoke battery + production traffic
  shadow), flip the `csv_read` default from `parseCsv` to `parseCsvLib` in
  a one-line follow-up. The 12-case hellgate already proves shape parity,
  so the flip is mechanical.
- If `parseCsvLib` strictly dominates on accuracy + performance, flip
  `parseCsv` to a re-export of `parseCsvLib` and mark the self-impl for
  removal in a short follow-up ADR.
- Until then, keep both surfaces addressable. Removal requires another ADR
  (sealed by the negative invariant above).
- If we ever need streaming CSV (multi-GB files), the lib already supports
  it — extend the adapter with a `parseCsvLibStream` variant rather than
  re-implementing it.
