# SEP5-07 — permission primitive validation authority

**Priority:** P2
**Status:** PLANNED
**Depends on:** SEP5-00
**Finding coverage:** D10

## Goal

Share the primitive `ThreadPermission` shape checks inside `@/permission` while
preserving each caller's public error representation and persistence behavior.

## Design

Extract a pure decoder, not the entire stores:

```ts
export type ThreadPermissionDecodeResult =
  | { readonly ok: true; readonly value: ThreadPermission }
  | { readonly ok: false; readonly path: string; readonly reason: string }

export const decodeThreadPermission = (
  value: unknown,
  path: string = "$",
): ThreadPermissionDecodeResult => { /* exhaustive primitive validation */ }
```

`permission-store.ts` maps the failure to its existing `ValidationResult`.
`posture-persistence.ts` maps failure to its existing fail-closed load/patch
behavior. Neither caller redefines enum or string-array guards.

## Write set

| File | Change |
|---|---|
| `src/permission/thread-permission-decode.ts` | New pure decoder and stable failure path/reason |
| `src/permission/permission-store.ts` | Replace private primitive guards with decoder adapter |
| `src/permission/posture-persistence.ts` | Replace copied guards while preserving fail-closed policy |
| `src/permission/index.ts` | Export only if required inside the slice barrel contract |
| `tests/unit/permission/thread-permission-decode.test.ts` | Exhaustive valid/corrupt table |
| `tests/unit/permission/thread-permission-entrypoint-parity.test.ts` | Both consumers reject the same corrupt primitive |
| existing permission concurrent-write/web-posture tests | Regression coverage |

## Invariants

- Approval policy remains the exact current closed union.
- Approvals reviewer and sandbox policy remain closed, not arbitrary strings.
- String arrays reject or filter exactly according to the current owner contract;
  choose one behavior from current tests before extraction.
- Unknown keys follow current persistence semantics; do not start accepting
  future fields silently.
- A parse failure cannot become default-allow.

## RED rails

- For every closed enum, inject one unknown value and require both consumers to
  reject/fail closed.
- Non-array, mixed-element arrays, null, scalar, and nested malformed records.
- A missing required field cannot be filled with a permissive default.
- Removing any decoder branch fails a known-case floor.
- Store-specific error path remains precise enough to identify the field.

## Test and ratchet implementation

- Define explicit `VALID_*` arrays beside the test for every closed union and
  assert their sorted contents equal the runtime/schema owner. Generate one
  positive record per member so a removed branch cannot hide behind one default
  fixture.
- Invalid families are unknown enum, `null`, scalar, non-array collection,
  mixed-element array, missing required field, malformed nested record, and
  unknown key according to the frozen policy. Run every row through the decoder,
  permission store, and posture persistence public entrypoints.
- Require both consumers to fail closed, while separately asserting their own
  error/result representations and the decoder's exact field path.
- Mutation A removes one valid enum literal from the decoder; that member's
  generated positive row must fail. Mutation B accepts arbitrary strings; the
  unknown-enum negative row must reach an allow state and fail. Mutation C
  defaults a missing field; the missing-required row must fail.
- Anti-vacuum floors equal the full cardinality of each closed union, at least
  eight invalid families, and exactly two persistence consumers. Do not derive
  expected literals from the same switch being tested.

## Proof rails

```sh
bun test tests/unit/permission/thread-permission-decode.test.ts
bun test tests/unit/permission/thread-permission-entrypoint-parity.test.ts
bun test tests/unit/permission
bun test tests/unit/apps/web-daemon/web-posture-wire-hellgate.test.ts tests/unit/apps/web-daemon/web-posture-durable-resume-hellgate.test.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- Primitive permission schema exists once.
- Store and posture APIs remain byte/shape compatible.
- Corrupt persistence is fail-closed through both reachable paths.
- No store↔posture runtime cycle is introduced.

## Stop conditions

- The decoder imports either persistence implementation.
- Consolidation changes unknown-key or default policy without a separate
  migration decision.
- A corrupt value can reach an allow decision.
