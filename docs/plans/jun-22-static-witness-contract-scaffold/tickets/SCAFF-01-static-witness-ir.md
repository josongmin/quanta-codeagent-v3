# SCAFF-01 — Static witness IR

## Goal

Introduce a generic, typed static witness representation that can carry structural
evidence from AST/LSP/static engines into generation, family construction, and
public contracts without becoming a heuristic score.

## Files

- `src/runner/batch/eval/static-witness.ts` (new)
- `src/runner/batch/eval/public-contract-types.ts`
- `src/runner/batch/eval/candidate-families.ts`
- `src/agent/fault-evidence/types.ts`
- `tests/unit/static-witness.test.ts` (new)

## Shape

Initial witness fields:

- `witnessId`
- `kind`
- `authority`
- `provenance`
- `subjectFiles`
- `subjectSymbols`
- `fromFile`
- `reason`

Initial `kind` values:

- `unique-symbol-definer`
- `override-family`
- `producer-consumer`
- `registration-callback`
- `lifecycle-owner`

Initial `authority` values:

- `authoritative`
- `advisory`

Allowed provenance:

- `ast`
- `lsp`
- `static-engine`
- `repo-map`
- `validated-repro`
- `public-issue-text`

Forbidden provenance:

- `gold-patch`
- `fail-to-pass`
- `pass-to-pass`
- `instance-id`
- `known-file-regex`
- `issue-family-regex`

## Implementation

- Add pure constructors that normalize file/symbol lists and produce stable ids.
- Add validation that rejects empty file subjects for authoritative owner/family
  witnesses.
- Add no-source-body invariant: witness records may carry path/symbol names, not
  raw source text.
- Add stable sorting/dedup helpers so downstream selection telemetry is deterministic.

## Hellgate

- A witness builder test cannot contain `django__`, `astropy__`, or known gold
  file-path literals.
- A witness with forbidden provenance cannot be converted to clean authority.
- A witness with one file cannot become a `multi-site-family` obligation.
- Duplicate witnesses collapse to one stable id.

## Done

- Static witness data is typed and provenance-carrying.
- Clean authority can be decided from `authority + provenance + kind`, not numeric
  score or benchmark-shaped string matching.
