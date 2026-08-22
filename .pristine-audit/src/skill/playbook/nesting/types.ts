/**
 * Playbook nesting types (ADR-0258).
 *
 * Devin Playbook surface has TWO structurally distinct recursion shapes:
 *
 *   1. Macro expansion (`!name`) — textual substitution, deliberately
 *      1-pass (ADR-0203).
 *   2. Playbook-to-playbook **call** with arguments and a return value —
 *      this slice. Bounded recursion (default `maxDepth: 3`) with
 *      explicit cycle detection.
 *
 * The two coexist. The 1-pass macro rule is the right invariant for textual
 * substitution. Bounded recursion with cycle detection is the right invariant
 * for nested calls. This slice ships the second without touching the first.
 *
 * Slice discipline: leaf-only types. NO imports from anywhere — pure data
 * shape. Same posture as `src/skill/playbook/spec-to-test/types.ts`.
 *
 * Default-OFF: nothing here is invoked unless a host wires a
 * {@link import("./port").NestedPlaybookExecutor} explicitly. A SKILL.md
 * whose procedure does not reference a child playbook is byte-identical to
 * the pre-0258 slice (HELL-PN-10).
 */

/**
 * Success outcome of a nested invoke.
 *
 * - `childOutput` — the child's return value, frozen shallowly so the parent
 *                   cannot mutate the child's surface. Plain values pass
 *                   through unchanged.
 * - `depthUsed`   — the depth AT WHICH the child ran (parent depth + 1).
 *                   The hellgate (HELL-PN-08) pins this — the value is the
 *                   child's level, NOT the chain length.
 */
export interface NestedResult {
  readonly childOutput: unknown
  readonly depthUsed: number
}

/**
 * Closed 4-arm failure union. Exhaustive switch coverage means every
 * operational failure path is visible in TypeScript today (HELL-PN-11).
 *
 * - `depth-exceeded`  — `parentDepth + 1 > maxDepth`. Carries both the
 *                       attempted depth and the configured cap so the host
 *                       can render an actionable message.
 * - `cycle-detected`  — `childId` already appears in the visit chain. The
 *                       `chain` field is a verbatim ordered list including
 *                       the cycle-closing id at the tail (HELL-PN-04).
 * - `child-not-found` — the injected `childLookup` returned `undefined`.
 * - `child-error`     — the child threw. The original `cause` is preserved
 *                       verbatim (no re-throw, no stringify) so the host
 *                       can rethrow with full provenance.
 */
export type NestError =
  | { readonly kind: "depth-exceeded"; readonly attempted: number; readonly max: number }
  | { readonly kind: "cycle-detected"; readonly chain: readonly string[] }
  | { readonly kind: "child-not-found"; readonly id: string }
  | { readonly kind: "child-error"; readonly id: string; readonly cause: unknown }

/**
 * Local Result shape — mirrors the rest of the playbook slice
 * (`spec-to-test/types.ts` etc.). Defined locally to keep this leaf module
 * dependency-free.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

/**
 * Default executor options.
 *
 * - `maxDepth` — caps the call chain length. Default 3 (Devin-typical "A → B
 *                → C"). The opts knob lets a host opt into a higher cap if a
 *                concrete use-case emerges; the default is conservative so
 *                authoring smells surface early.
 */
export interface NestedExecutorOpts {
  readonly maxDepth?: number
}

/**
 * Default depth cap, used when `NestedExecutorOpts.maxDepth` is omitted.
 * Exported so the hellgate can assert the documented default without
 * importing the executor body.
 */
export const DEFAULT_MAX_DEPTH = 3
