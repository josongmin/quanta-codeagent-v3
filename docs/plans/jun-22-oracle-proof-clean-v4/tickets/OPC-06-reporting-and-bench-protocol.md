# OPC-06 - Reporting And Bench Protocol

## Goal

Make proof-clean benchmark results diagnosable: score, proof authority, infra,
and contract-only failures must be separate axes.

## Problem

The latest v4 3-case run collapsed different failures into generic unresolved
or timeout states:

- astropy was an env/proof setup failure before model correctness.
- django 11138 was contract-only multi-file drift.
- django 14315 was contract-only shell/env behavior miss.

Without explicit proof telemetry, reruns keep producing ambiguous score claims.

## Implementation

Add report fields per instance:

- `proofState`
- `proofSource`
- `proofRequiredMissing`
- `contractOnlySubmitted`
- `envPrepFailed`
- `publicMweState`
- `publicRegressionState`
- `reproConsensusState`
- `repairOnlyCandidates`
- `submittedCandidateProof`
- `llmEvidenceStages`
- `llmEvidenceRevision`
- `llmEvidenceMissingKinds`

Add aggregate counters:

- `submittedWithProof`
- `blockedProofMissing`
- `blockedEnvFailed`
- `contractOnlyBlocked`
- `contractOnlySubmitted`
- `packetizedGenerationCount`
- `packetizedRepairCount`
- `packetizedSelectionExplanationCount`

Bench protocol:

- Run local typecheck and unit gates first.
- Run 3-case proof set with v4.
- Run the 11-case contaminated clean set with v4.
- Run A/B against v3 clean with the same model and box class.
- For OPC-07 packet changes, also run a same-authority before/after readout inside
  the v4 family before comparing against v3 clean.
- Compare resolved count, patch bytes, turns, multi-file rate, proof-missing
  count, env-failed count, `submittedWithProof`, `repairOnlyCandidates`, and
  packet coverage separately.
- Interpret any resolved-count delta only together with proof telemetry. A
  packetized run that changes score while also changing authority semantics is
  not a valid readout.

## Files

- `src/runner/batch/report.ts`
- `src/runner/batch/types.ts`
- `src/apps/bench/analyze/verdicts.ts`
- `src/apps/bench/analyze/diff.ts`
- `tests/unit/report-telemetry-wiring.test.ts`
- `tests/unit/apps/bench/batch-report-schema-parity.test.ts`

## Acceptance

- A proof-missing candidate cannot appear as ordinary `completed_unresolved` only.
- A clean report shows whether every submitted candidate had executable proof.
- `contractOnlySubmitted` is zero for v4.
- `envPrepFailed` is counted separately from model/scaffold unresolved.
- A/B reports keep v3 and v4 authority differences explicit.
- Packetized runs show which LLM evidence stages were actually used and what
  evidence revision produced them.

## Hellgate

Do not claim a v4 score improvement unless proof-required telemetry is present
and `contractOnlySubmitted=0`. For OPC-07, do not claim benefit from richer
packetization unless the report also shows unchanged submit authority semantics.
