# T-OWN-12 — authoritative/advisory owner-evidence lattice

## Goal

Replace the current scored owner packet with a typed owner-evidence lattice so clean mode can distinguish
authoritative owner evidence from advisory static proposals.

## Files

- `src/agent/fault-evidence/build.ts`
- `src/agent/fault-evidence/types.ts`
- `src/agent/owner-admission/index.ts`
- `src/agent/closure/bundle.ts`
- `src/runner/batch/eval/closure-session.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `tests/unit/fault-evidence.test.ts`
- `tests/unit/owner-admission.test.ts`
- `tests/unit/selection-executor.test.ts`

## Implementation

- Replace score-desc `FaultEvidencePacket` candidates with a provenance-carrying owner-evidence surface:
  - `evidenceId`
  - `file`
  - `kind`
  - `strength`
  - `provenance`
  - `subjectSymbols`
  - `subjectFiles`
- Initial evidence kinds:
  - `issue-file`
  - `traceback-file`
  - `validated-repro-owner`
  - `unique-symbol-definer`
  - `stage1-proposal`
  - `sibling-proposal`
- Initial strengths:
  - `authoritative`
  - `advisory`
- Remove numeric authority from clean owner admission:
  - `ISSUE_FILE_BOOST`
  - `OWNER_RESOLVE_BOOST`
  - `DEFAULT_MIN_LEAD_GAP`
- Rewrite `OwnerAdmission` as rule-based:
  - exactly one authoritative owner file => admit single owner
  - multiple authoritative owner files => no forced single owner
  - no authoritative owner file => no forced single owner
  - advisory evidence may shape family ordering and seed generation, but cannot by itself admit or veto
- Scope what "admit single owner" means, to avoid colliding with T-SEL-13:
  - `OwnerAdmission` admit only narrows generation/family ordering to that owner.
  - it does NOT grant loop-stop / early-accept authority. Stopping the search
    still requires an executed proof receipt per T-SEL-13.
  - the `commit-now` single-owner fast path therefore needs BOTH an authoritative
    owner AND an executed proof receipt; authoritative static evidence alone never
    stops the loop.
- Feed the lattice into closure/generation telemetry so every owner claim names its evidence provenance.

## Hellgate

- Stage-1-only or sibling-only evidence cannot admit a single owner in clean mode.
- Two conflicting authoritative owner files yield `admit=false`, not an arbitrary score winner.
- Advisory owner evidence can create candidate families and seeds, but cannot make a candidate inadmissible.
- An authoritative single owner with NO executed proof receipt cannot `commit-now`
  / early-stop (enforced jointly with T-SEL-13); the fast path requires both.

## Done

- Clean owner admission no longer depends on additive owner score constants or lead-gap heuristics.
- Owner evidence is typed and provenance-carrying.
- Static owner confidence remains useful for generation but is structurally separated from final authority.
