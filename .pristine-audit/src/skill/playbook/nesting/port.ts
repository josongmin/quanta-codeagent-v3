/**
 * Nested playbook executor port (ADR-0258).
 *
 * Single 1-method closed port — `invoke(parentId, childId, args, depth)` —
 * for piping a playbook's output into a child playbook's input under a
 * bounded recursion + cycle-detection regime.
 *
 * Implementation lives in `./default-executor.ts`. Callers always reach for
 * this interface (never the concrete factory) so test rigs can substitute
 * a deterministic fake without dragging the cycle detector or the lookup
 * adapter into the test process.
 *
 * Slice discipline: leaf port. types only (`./types`). NO adapter, NO
 * runtime, NO `@/shared`.
 *
 * Synchronous + Result-typed by design — composes cleanly with the rest of
 * the playbook slice (parser, validator, dispatcher are all sync). Async is
 * a sibling-adapter follow-up, NOT a refactor of this port.
 */

import type { NestError, NestedResult, Result } from "./types"

/**
 * The executor port.
 *
 * Contract:
 *   - `parentId` is the id of the CALLING playbook (its frame is added to
 *     the visit chain so a child that calls back into the parent is
 *     reported as `cycle-detected`).
 *   - `childId` is the id of the playbook to invoke.
 *   - `args` is opaque; the executor passes it verbatim to the child.
 *   - `depth` is the caller's CURRENT depth. The executor compares
 *     `depth + 1` against the configured `maxDepth` cap.
 *
 * The return is `Result<NestedResult, NestError>`. Throws are forbidden;
 * a child-thrown exception is converted to `{ kind: "child-error", cause }`
 * (HELL-PN-06).
 */
export interface NestedPlaybookExecutor {
  readonly invoke: (
    parentId: string,
    childId: string,
    args: unknown,
    depth: number,
  ) => Result<NestedResult, NestError>
}

/**
 * Caller-injected child lookup. Returns the child's invoke function, or
 * `undefined` if no playbook is registered for `id` (which the executor
 * surfaces as `{ kind: "child-not-found", id }`).
 *
 * The child function is a synchronous unary `(args) => unknown`. Async
 * children are out of scope for this primitive (see the ADR's rejected
 * alternatives).
 */
export type ChildLookup = (id: string) => ((args: unknown) => unknown) | undefined
