# T-LOC-05 — static engine witness layer

## Goal

Use the existing static engine for localization, co-change discovery, and witness generation without giving it
final verdict authority.

## Files

- `src/tool/lsp_nav/index.ts`
- `src/tool/find-refs/index.ts`
- `src/runner/knobs/knobs/repo-map.ts`
- `src/agent/localize-phase-guard.ts`
- `src/runner/batch/eval/closure-session.ts`
- `src/runner/batch/eval/driver.ts`
- `tests/unit/localize-phase-guard-hellgate.test.ts`
- `tests/unit/lsp-nav-per-tool.test.ts`
- `tests/unit/find-refs.test.ts`

## Implementation

- Produce a typed `StaticWitnessBundle`:
  - `ownerFiles`.
  - `ownerFamilies`.
  - `definitionSites`.
  - `referenceSites`.
  - `coChangeCandidates`.
  - `candidateTests`.
  - `candidateFamilies`.
  - `confidenceReason`.
  - `truncated`.
- Generate the bundle from:
  - `lsp_definition` for true owner.
  - `find_references` for co-change candidates.
  - repo-map for orientation.
  - closure/fault evidence for already-known owner context.
- Feed this bundle into:
  - candidate seed generation.
  - candidate family generation.
  - public contract witness generation.
  - witness test candidate generation.
  - telemetry.
- Do not feed static confidence directly into hard verdict.

## Hellgate

- LSP unavailable degrades to missing static evidence, not reject.
- `find_references` cap hit records truncation, not reject.
- Static owner confidence can change candidate ordering but cannot make a patch inadmissible.
- Static family evidence can change which families are explored first, but cannot by itself veto a patch.
- Executed proof can override static uncertainty.

## Done

- Static engine usage is visible in telemetry.
- Static evidence is separated from executable verdict in types and tests.
- Static engine output is rich enough to drive family-separated generation and public contract witnesses without
  becoming final authority.
