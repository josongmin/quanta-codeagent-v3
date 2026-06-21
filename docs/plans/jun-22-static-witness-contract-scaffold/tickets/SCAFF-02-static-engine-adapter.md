# SCAFF-02 — Static engine adapter

## Goal

Provide a bounded scaffold adapter that turns AST/LSP/static-engine facts into
`StaticWitness` records. The adapter finds structural relations; it does not
decide final correctness.

## Files

- `src/runner/batch/eval/static-witness.ts`
- `src/runner/batch/eval/static-witness-adapter.ts` (new)
- `src/agent/closure/owner-sibling-resolve.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `tests/unit/static-witness-adapter.test.ts` (new)
- `tests/unit/runner/static-witness-driver-parity.test.ts` (new)

## Implementation

- Start with Python AST extraction for:
  - definitions by file;
  - class inheritance and method override families;
  - direct call edges within owner candidates;
  - simple assignment/return flow for producer-consumer pairs;
  - registration callsites such as function passed into registry APIs.
- Wrap the implementation behind a `StaticWitnessProvider` port.
- Allow future static-engine backend without changing selector or contract types.
- Keep `resolveOwnerSiblings()` as a compatibility feeder until the new provider
  covers its current same-symbol sibling behavior.
- Wire the provider into both bench drivers with identical inputs.

## Relation targets

- `override-family`: same method/function symbol across related class/backend
  implementations.
- `producer-consumer`: value produced by one function/method is consumed by a
  caller or subprocess/API boundary.
- `registration-callback`: function registered into a runtime callback table or
  database/user-defined-function registry.
- `unique-symbol-definer`: issue-mentioned symbol has exactly one static definer.

## Hellgate

- Adapter produces no witness when only stage1 rank is available.
- Adapter output is stable across repeated runs on the same sandbox.
- Driver and app-driver pass the same witness bundle into selection.
- Missing static engine degrades to empty/advisory witness, not fabricated authority.

## Done

- The scaffold has a typed relation source richer than same-symbol ripgrep.
- Static witness generation remains blind to hidden benchmark labels and known
  patches.
