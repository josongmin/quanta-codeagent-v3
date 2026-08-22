/**
 * Pure DFS visit-set helper for playbook nesting cycle detection (ADR-0258).
 *
 * Given a visit set + a next id, returns either an `ok` outcome with the
 * augmented visit set, or a `cycle` outcome with the verbatim chain (in
 * caller-provided order, with the cycle-closing id appended at the tail).
 *
 * No I/O. No fs. No imports from `@/agent`, `@/tool`, `@/permission`,
 * `@/shared`. This IS the DFS visit set the hellgate pins (HELL-PN-09).
 *
 * Slice discipline: leaf. types only.
 */

/**
 * Result of a cycle check.
 *
 * - `ok`    — `nextId` is novel. `visited` is the new visit set the caller
 *             should thread through subsequent calls. The set is frozen so
 *             the caller cannot mutate it in place; future calls must build
 *             a NEW augmented set (no shared mutable state across
 *             invocations, HELL-PN-13).
 * - `cycle` — `nextId` already appears in the current chain. `chain` is a
 *             verbatim ordered list of ids: `[...currentChain, nextId]` —
 *             the cycle-closing id is at the tail (HELL-PN-04).
 */
export type CycleCheck =
  | { readonly kind: "ok"; readonly visited: ReadonlySet<string> }
  | { readonly kind: "cycle"; readonly chain: readonly string[] }

/**
 * Test whether appending `nextId` to the visit set would close a cycle.
 *
 * `currentChain` is the ORDERED list of visited ids (used only for the
 * cycle-report `chain` output; ordering is irrelevant for the membership
 * test itself). `visited` is the corresponding `Set` for O(1) membership.
 *
 * Pure: no side effects, no I/O.
 */
export const checkCycle = (
  currentChain: readonly string[],
  visited: ReadonlySet<string>,
  nextId: string,
): CycleCheck => {
  if (visited.has(nextId)) {
    const chain = Object.freeze([...currentChain, nextId])
    return { kind: "cycle", chain }
  }
  const next = new Set(visited)
  next.add(nextId)
  return { kind: "ok", visited: next }
}
