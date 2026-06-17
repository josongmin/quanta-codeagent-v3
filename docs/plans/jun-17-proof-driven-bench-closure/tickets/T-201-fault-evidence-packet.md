# T-201: `FaultEvidencePacket` builder

**Priority:** P1 · **Size:** L · **Deps:** [T-101](T-101-closure-diagnostic-rail.md) · **Posture:** OFF (`fault-evidence` knob / `QUANTA_BENCH_FAULT_EVIDENCE`)

## Deliverable

Create a bench-only `FaultEvidencePacket` pipeline that converts:

- Stage-1 ranked files
- issue symbols (`extractSymbols`)
- bounded owner/sibling/caller evidence

into a typed artifact consumed by later owner/planning tickets.

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

## Proof rail

- `bun test tests/unit/fault-evidence-packet.test.ts`
- `bun test tests/unit/bench-fault-evidence-wiring.test.ts`
