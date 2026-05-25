# ADR-0258: Playbook nesting — bounded recursive call chain with cycle detection

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0203 (user-authored playbook frontmatter — the 1-pass macro
  expansion this slice deliberately escapes),
  ADR-0241 (playbook auto-dispatch — the host that *could* wire nested
  invocation but does not yet),
  Devin Playbooks "nested playbook" workflow (a procedure-level step that
  invokes another playbook by id and consumes its result).
- **References**:
  `src/skill/playbook/nesting/types.ts` (typed `NestedResult` / `NestError` 4-arm),
  `src/skill/playbook/nesting/port.ts` (closed `NestedPlaybookExecutor` port),
  `src/skill/playbook/nesting/cycle-detector.ts` (pure DFS visit-set helper),
  `src/skill/playbook/nesting/default-executor.ts` (depth-bounded executor with
  injected child lookup + cycle short-circuit),
  `src/skill/playbook/nesting/index.ts` (barrel),
  `tests/unit/skill/playbook/nesting-hellgate.test.ts` (15 cases).

## Context

ADR-0203 ships a strict, intentional invariant: macro expansion is **single
pass**. An expansion that itself contains `!other` is treated as literal text.
That choice matches Devin's macro grammar exactly and avoids the unbounded
graph traversal a naive `!a → !b → !c` chain would invite.

But the Devin Playbook surface has a SECOND, structurally distinct, recursion
shape: a **procedure-level** step that invokes another playbook by id, gets
back the child's output, and pipes that output forward. That is NOT a macro
expansion (it is a *call*, with arguments and a return value), and the 1-pass
macro rule does not apply because the call site is explicit (the step is
literally "run playbook B"), not implicit (`!B` substitution).

The 1-pass rule is the correct invariant for macros (textual substitution
recursion would surprise authors). The opposite invariant — **bounded
recursive call chains with cycle detection** — is the correct shape for a
playbook-to-playbook invocation. They coexist; this ADR adds the second
without touching the first.

quanta has no equivalent surface today. A user who wants "playbook A first
calls playbook B" must either inline B's procedure into A (duplication) or
wait for the host to manually dispatch A then B in a fixed order (no result
piping). This ADR ships the slice primitive (closed port + depth-bounded
executor + cycle detector + 15-case hellgate). Wiring into `auto-dispatch.ts`
or the planning surface is deferred — the catalog entry records the deliberate
hold.

## Decision

### Slice layout

```
src/skill/playbook/nesting/
  types.ts             — NestedResult, NestError 4-arm, depth opts
  port.ts              — NestedPlaybookExecutor (closed 1-method port)
  cycle-detector.ts    — pure DFS visit-set helper (no I/O, no fs)
  default-executor.ts  — depth-bounded + cycle-detected executor with
                         injected child lookup
  index.ts             — barrel
```

### Types (`types.ts`)

```ts
export interface NestedResult {
  readonly childOutput: unknown
  readonly depthUsed: number
}

export type NestError =
  | { readonly kind: "depth-exceeded"; readonly attempted: number; readonly max: number }
  | { readonly kind: "cycle-detected"; readonly chain: readonly string[] }
  | { readonly kind: "child-not-found"; readonly id: string }
  | { readonly kind: "child-error"; readonly id: string; readonly cause: unknown }

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }
```

The error union is closed (4 arms, exhaustive) so an exhaustive `switch`
covers every operational failure path. `child-error` carries the original
`cause` unchanged — the executor never re-throws or stringifies.

### Port (`port.ts`)

```ts
export interface NestedPlaybookExecutor {
  readonly invoke: (
    parentId: string,
    childId: string,
    args: unknown,
    depth: number,
  ) => Result<NestedResult, NestError>
}
```

A single method. `depth` is the **caller's current depth** — the executor
adds 1 and compares against the configured cap before dispatching. The
synchronous Result-typed return matches the rest of the playbook slice's
posture (parser, validator, dispatcher are all synchronous + Result-typed).

### Cycle detector (`cycle-detector.ts`)

Pure helper. Given a `visit: ReadonlySet<string>` and a `nextId: string`,
returns one of:
- `{ kind: "ok", visited: ReadonlySet<string> }` — `nextId` not in `visit`;
  caller may proceed with the augmented set.
- `{ kind: "cycle", chain: readonly string[] }` — `nextId` already present;
  caller emits the parent → child → … → parent chain verbatim.

No I/O. No fs. No `@/agent` import. This helper IS the "DFS visit set" the
hellgate pins (HELL-PN-09).

### Default executor (`default-executor.ts`)

Constructor takes:
- `childLookup: (id: string) => ((args: unknown) => unknown) | undefined` —
  caller-injected child-playbook lookup. A miss → `child-not-found`.
- `opts?: { maxDepth?: number }` — defaults to 3. Configurable per the
  ADR constraints; 3 covers the typical "A → B → C" three-link chain
  Devin users in practice.

Per `invoke(parentId, childId, args, currentDepth)`:

1. Add `parentId` to the call chain (per-invocation, NOT shared state).
2. Compute `nextDepth = currentDepth + 1`. If `nextDepth > maxDepth` →
   `{ kind: "depth-exceeded", attempted: nextDepth, max: maxDepth }`.
3. Run the cycle detector against the call chain with `childId`. On cycle
   → `{ kind: "cycle-detected", chain: [...prefix, parentId, childId] }`.
4. Look up child via `childLookup(childId)`. Miss → `{ kind: "child-not-found" }`.
5. Invoke child synchronously: `try { childOutput = child(args) } catch
   (cause) { return { kind: "child-error", id: childId, cause } }`.
6. Return `{ ok: true, value: { childOutput: Object.freeze(...), depthUsed:
   nextDepth } }`.

The executor is stateless across `invoke` calls — concurrent invocations
share NO mutable visit set. HELL-PN-13 pins this.

`childOutput` is frozen before return (HELL-PN-14). Plain values pass
through unchanged; objects/arrays freeze shallowly.

### Barrel (`index.ts`)

Re-exports the closed port, the types, the default executor factory, and
the cycle-detector helper. The barrel does NOT export internal helpers
(e.g. private chain-builders).

## Consequences

**Positive**

- The slice ships as a closed port with one default executor — same shape
  as `src/skill/playbook/spec-to-test/`, which keeps the audit reflex
  transferable.
- Bounded recursion (depth ≤ 3 by default, configurable) gives authors a
  predictable failure mode without invoking unbounded DFS.
- Cycle detection short-circuits on the FIRST repeat; the returned `chain`
  is a verbatim parent→child→…→parent list the host can render verbatim.
- The 4-arm `NestError` union is closed; exhaustive switch coverage means
  every operational failure path is visible in TypeScript today.
- Default-OFF: nothing in `src/agent`, `src/tool`, or `src/runtime`
  constructs a `NestedPlaybookExecutor`. A SKILL.md whose procedure does
  not reference a child playbook is byte-identical to the pre-0258 slice
  (HELL-PN-10 pins this).

**Negative / accepted trade-offs**

- The default executor is **synchronous**. Async child playbooks (e.g.
  ones that spawn subagents) require an async sibling adapter; this
  round ships only the sync surface to keep the slice closed and the
  hellgate deterministic.
- `childLookup` returns a plain `(args) => unknown` — no async, no
  generators, no streaming. This is the smallest closed shape for the
  primitive; the sibling-adapter swap is a follow-up.
- `Object.freeze` is shallow. A nested mutable object inside `childOutput`
  is NOT recursively frozen. The hellgate (HELL-PN-14) pins the top-level
  freeze only; consumers who need deep immutability call a structural
  cloner upstream.
- The slice is shipped **default-OFF**. No tool, no agent surface, no
  composition root constructs this yet. This is intentional per RFC §1.2 —
  byte-identical landing first, feature wiring later.

## Rejected alternatives

- **Make recursion unbounded with a global cycle map.** Matches a single
  global "import" model but turns every nested-call surface into a
  shared-state debugger headache and crosses slice boundaries
  (the global map would have to live in `src/agent` or `@/shared`). The
  bounded + per-invocation visit-set model keeps the slice leaf-level.
- **Extend ADR-0203's macro expander to recurse.** Conflates two distinct
  surfaces (textual substitution vs structural call) and breaks Devin's
  documented 1-pass macro contract. We deliberately keep them separate.
- **Default `maxDepth: 10`.** A 10-deep playbook chain is functionally
  indistinguishable from broken authoring; capping at 3 surfaces the
  authoring smell early. The opts knob is intentionally there so a host
  can opt into 5 or 7 if a real use-case emerges — but the default is
  conservative.
- **Async-first port.** The sync port composes cleanly with the rest of
  the playbook slice (parser, validator, dispatcher are all sync) and
  keeps the hellgate deterministic. Async is a sibling-adapter follow-up.
- **Default-ON wire into `auto-dispatch.ts`.** Violates RFC §1.2
  byte-identical landing. A user who never nests playbooks would pay a
  per-step visit-set construction cost. Opt-in is the safer landing; the
  wiring round will add the host adapter.
