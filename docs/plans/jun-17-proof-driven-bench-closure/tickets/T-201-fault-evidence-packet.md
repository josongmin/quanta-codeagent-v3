# T-201: `FaultEvidencePacket` builder

**Priority:** P1 · **Size:** L · **Deps:** [T-101](T-101-closure-diagnostic-rail.md) · **Posture:** OFF (`fault-evidence` knob / `QUANTA_BENCH_FAULT_EVIDENCE`)

## Deliverable

Create a bench-only `FaultEvidencePacket` pipeline that converts:

- Stage-1 ranked files
- issue symbols (`extractSymbols`)
- bounded owner/sibling/caller evidence

into a typed artifact consumed by later owner/planning tickets.

Version 1 packet fields must include:

- `ownerCandidates[]`
- `primaryOwner`
- `siblingSites[]`
- `crossFileEvidence[]`
- `specLiteralSignals[]`
  - expected output / exact fallback / exact wrapper or shape contract present in public issue text or bounded local evidence

This work must NOT reuse the existing `EvidencePacket` name from `src/tool/evidence/types.ts`.

## Touch files

- new `src/agent/fault-evidence/types.ts`
- new `src/agent/fault-evidence/build.ts`
- new `src/runner/batch/eval/fault-evidence.ts`
- `src/runner/batch/eval/driver.ts`
- `src/agent/issue-hint/extract-symbols.ts`
- new `tests/unit/fault-evidence-packet.test.ts`
- new `tests/unit/bench-fault-evidence-wiring.test.ts`

## Acceptance criteria

- [ ] Same issue text + same file tree => same packet.
- [ ] Packet never reads hidden bench labels or official grader outputs.
- [ ] Packet windows are bounded; no raw-source blob injection.
- [ ] Missing LSP / empty Stage-1 result degrades to partial packet, not throw.
- [ ] Packet naming does not collide with the existing multilang `EvidencePacket`.
- [ ] Packet can represent `single-site` vs owner-family evidence without reading hidden oracle labels.
- [ ] Packet can surface exact spec-literal signals from issue text or bounded public evidence without turning them into runtime oracle reads.

## Proof rail

- `bun test tests/unit/fault-evidence-packet.test.ts`
- `bun test tests/unit/bench-fault-evidence-wiring.test.ts`
