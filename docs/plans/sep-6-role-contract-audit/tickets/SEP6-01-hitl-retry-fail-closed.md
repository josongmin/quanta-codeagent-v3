# SEP6-01 — typed HITL retry fail-closed

**Finding:** N7

**Priority:** P1

**Status:** COMPLETE

## Closed invariant

An `LLMErrorKind` whose canonical `codexSpecRoute` action is `hitl_handoff`
cannot be retried automatically because its message contains retry-looking text.
The typed route now outranks free-form markers.

## Repair

- `src/llm/retry/decorator-policy.ts` derives every HITL kind as decisive
  `no_retry` from the canonical route table.
- No second HITL kind set was added to production.
- `auth`, `cyber_policy`, `sandbox_error`, and `sandbox_blocked` each perform one
  provider call even with `"503 overloaded timeout, try again"`.
- Non-HITL marker handling and provider fallback behavior remain unchanged.
- The feature catalog records the corrected policy and keeps broader DOF-30
  closed.

## Verification

```text
bun test tests/unit/retry-decorator-policy-hellgate.test.ts \
  tests/unit/recovery-router-hellgate.test.ts \
  tests/unit/recovery-router-consumer-wire.test.ts
-> 122 pass, 0 fail, 257 expect
```

Final adversarial re-audit also updated the pre-existing exhaustive router
hellgate from the obsolete 7-marker/16-kind contract to the current
4-residual-marker/18-kind contract. The expanded six-file recovery batch is
`266 pass, 0 fail`.

Campaign closeout: the exact final overlay passed `bun run test:ci` in a clean
detached verification worktree; all 21 gates were green. The shared checkout's
unrelated dirty state was preserved.
