# T5 — guard + break the selection value-cycle (real hazard)

**Priority:** P2 — adversarial audit reversed the earlier "benign/optional" call
**Depends on:** T1
**Parallelizable:** no

## Why this is NOT optional (correction)

The `selection-executor.ts ↔ selection-finalize.ts` reciprocal import is a real **bidirectional value-import cycle**, not type-only:

- executor → finalize imports 8 runtime functions (`selection-executor.ts:98-107`: `finalize`, `generatedResult`, `maybeFinalizeEarlyAccept`, …)
- finalize → executor imports back `postprocessGeneratedCandidate` + `sanitizeCandidatePublicContracts` (values, `selection-finalize.ts:44-54`, used at `:193,307,388`)

It is "safe" today only because of an **unenforced** invariant the code itself flags (`selection-executor.ts:95-97`: refs are "FUNCTION references only, never called at module init"). The project already treats this exact pattern as dangerous — `tests/unit/agent-import-cycle.test.ts` + `tools/feature-catalog/.../agent-import-cycle-guard.yaml` build a Tarjan-SCC guard against it, documenting the failure mode: a top-level use of a cycle-edge symbol becomes an "ESM circular-init TDZ deadlock → runtime silent hang." But that guard is hardcoded to `AGENT_DIR = src/agent` — **`src/runner/batch/eval/` is entirely outside its scope.** So this is an unguarded twin of a bug class the project has already paid for once.

The fix is therefore two-part and worth doing: (1) extend the import-cycle SCC guard to cover `src/runner/batch/eval/`, and (2) break the cycle by moving the two shared values (`postprocessGeneratedCandidate`, `sanitizeCandidatePublicContracts`) into a shared leaf module both import.

## Problem

- the executor/finalize value-cycle relies on an unenforced "never call at module-init" rule, with no static guard protecting `runner/batch/eval`
- selection reads as orchestration + scoring intermixed rather than by clear stage

## Goal

Make selection/repair internals cycle-free and owner-local, with shared contracts extracted into dedicated modules and orchestration separated from pure scoring/finalization logic.

## Scope

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/selection-finalize.ts`
- `src/runner/batch/eval/selection-gates.ts`
- `src/runner/batch/eval/repair-breadth.ts`
- `src/runner/batch/eval/location-set-fanout.ts`
- `src/runner/batch/eval/repair/candidate-ledger.ts`
- related tests in `tests/unit/**`

## Entry conditions

- read and understand current surrounding drift in:
  - `acceptance-adapter.ts`
  - `acceptance-evidence.test.ts`
  - `acceptance-llm-rerank.ts`
  - `acceptance-select.ts`
  - `llm-candidate-select.ts`
  - `location-set-fanout.ts`
  - `repair-breadth.ts`
  - `repair/candidate-ledger.ts`
  - `repair/types.ts`
- if the active owner cannot safely merge with that drift, isolate before starting

## Exact edit surfaces

Likely touched:

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/selection-finalize.ts`
- `src/runner/batch/eval/selection-types.ts`
- `src/runner/batch/eval/selection-gates.ts`
- `src/runner/batch/eval/location-set-fanout.ts`
- `src/runner/batch/eval/repair-breadth.ts`
- `src/runner/batch/eval/repair/candidate-ledger.ts`
- owner-local tests in `tests/unit/**` and `src/runner/batch/eval/*.test.ts`

## Required changes

1. Break the `selection-executor` / `selection-finalize` cycle by extracting shared contracts and pure helpers into dedicated owner-local modules.
2. Make the selection path read as:
   - input assembly
   - candidate generation
   - scoring/finalization
   - result projection
3. Make the repair breadth/evidence path read as:
   - typed candidate seed/focus contract
   - candidate execution
   - validation/ledger persistence
4. Replace architecture-preserving string/parity tests with behavior tests where those tests are currently the only thing proving the seam.

## Suggested implementation order

1. extract shared contracts/types first
2. break the import cycle second
3. only then reduce orchestrator size
4. keep current typed evidence/fanout work if compatible; do not regress it
5. replace debt-preserving tests last, after behavior is stable

## Explicit non-goals

- feature redesign of acceptance/LLM rerank behavior
- removing useful typed evidence that is already landing in the current surrounding drift
- touching unrelated non-bench selection helpers outside the active owner seam

## Definition of done

- no reciprocal import cycle between selection owner modules
- selection and repair seams are understandable by owner boundary rather than file-size split
- current local drift in acceptance/location-fanout/repair breadth is either incorporated deliberately or cleanly isolated

## Deliverables

- cycle-free owner modules
- explicit note in the report describing how surrounding drift was handled
- before/after import-edge explanation

## Proof rails

```sh
bun run typecheck
bun test tests/unit/location-set-fanout.test.ts
bun test tests/unit/repair-breadth-driver-fanout.test.ts
bun test src/runner/batch/eval/acceptance-evidence.test.ts
bun test src/runner/batch/eval/llm-candidate-select.test.ts
```

## Stop rule

Do not start broad edits here until the current surrounding drift in the listed files is understood. This ticket is the most conflict-prone part of the packet.

## Blocked if

- surrounding drift and the refactor target conflict semantically
- the cycle cannot be removed without first re-owning shared runtime semantics in `T1`
