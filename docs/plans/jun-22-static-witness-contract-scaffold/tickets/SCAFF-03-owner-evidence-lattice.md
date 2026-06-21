# SCAFF-03 — Owner evidence lattice

## Goal

Replace bare `owner-resolve` authority with a provenance-carrying owner evidence
lattice. Clean mode must know which owner evidence is authoritative and which is
only useful for exploration.

## Files

- `src/agent/fault-evidence/types.ts`
- `src/agent/fault-evidence/build.ts`
- `src/agent/owner-admission/index.ts`
- `src/agent/closure/bundle.ts`
- `src/runner/batch/eval/closure-session.ts`
- `src/runner/batch/eval/static-witness.ts`
- `tests/unit/fault-evidence-packet.test.ts`
- `tests/unit/owner-admission.test.ts`
- `tests/unit/closure-session-owner-clean-activation.test.ts`

## Implementation

- Extend fault evidence input with static witness records.
- Preserve legacy `ownerResolved` as an adapter input while converting it into
  advisory `sibling-proposal` evidence.
- Promote only these to clean authoritative owner evidence:
  - `unique-symbol-definer` with unique static definer proof;
  - complete `override-family` witness when all family files are known;
  - validated `producer-consumer` witness with both producer and consumer files.
- Keep stage1, localizer rank, same-symbol sibling, and owner coverage as advisory.
- Remove any clean owner decision that depends on additive score or lead gap.

## Hellgate

- Stage1-only evidence cannot admit a clean owner.
- Same-symbol sibling evidence cannot become authoritative without typed relation
  provenance.
- Two authoritative owner files produce family/cross-owner state, not arbitrary
  single-owner admission.
- Authoritative owner evidence alone cannot trigger early accept or commit-now.

## Done

- Fault evidence can explain why an owner is authoritative.
- Clean owner admission is rule-based over typed provenance, not score-desc merge.
