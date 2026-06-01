/**
 * Browser slice — pure snapshot rendering + ref map (ADR-0427).
 *
 * `buildSnapshot` is a PURE function (DomModel → YAML-ish string): no Date, no
 * random, no IO. Same input ⇒ byte-identical output. The adapter does the
 * non-deterministic collection (`Runtime.evaluate` in-page) and hands the
 * serialized {@link DomModel} here — this split is what makes perception
 * hellgate-testable with fixtures.
 *
 * `RefMap` allocates opaque element refs (`e1`, `e2`, …) that the MODEL uses to
 * click/type. Refs are:
 *   - monotonic (a fresh node always gets the next counter) ⇒ a given page
 *     sequence renders byte-stable refs ⇒ replay/hellgate works;
 *   - held OUT-OF-BAND (path↔ref maps), so the live DOM is never mutated
 *     (Cursor writes `data-cursor-ref` into the page; we do not — zero page
 *     pollution + cleaner tests);
 *   - reverse-resolvable (`resolve(ref)` → backendPath) so `click(ref)` maps
 *     back to a concrete element.
 */

import type { DomModel, DomNode } from "./types"

export interface RefMap {
  /** Walk the model in pre-order: assign a ref to each new backendPath, keep
   *  existing assignments, and prune refs whose path vanished. */
  reconcile(model: DomModel): void
  /** backendPath → ref (post-reconcile), or null. */
  refOf(backendPath: string): string | null
  /** ref → backendPath, or null (after pruning). */
  resolve(ref: string): string | null
  /** Drop EVERY current ref↔path binding — used when the whole document is
   *  gone (a navigation), so every prior `backendPath` is meaningless.
   *
   *  The monotonic counter is deliberately NOT reset: a ref minted before an
   *  `invalidate()` can never be reissued, so a stale cross-navigation ref
   *  resolves to `null` (→ `element-not-found`, fail-closed) instead of
   *  silently rebinding to whatever element happens to occupy the same
   *  child-index path on the new page. The next `reconcile` mints fresh refs
   *  against the new DOM. This makes "a ref belongs to the snapshot that
   *  minted it" a CODE invariant, not a prose expectation the model must honor
   *  — matching the slice's hard-gate-over-prose posture (strengthen #1). */
  invalidate(): void
}

export const createRefMap = (): RefMap => {
  let counter = 0
  const pathToRef = new Map<string, string>()
  const refToPath = new Map<string, string>()

  const assign = (node: DomNode): void => {
    if (!pathToRef.has(node.backendPath)) {
      counter += 1
      const ref = `e${counter}`
      pathToRef.set(node.backendPath, ref)
      refToPath.set(ref, node.backendPath)
    }
    for (const child of node.children ?? []) assign(child)
  }

  const collect = (node: DomNode, acc: Set<string>): void => {
    acc.add(node.backendPath)
    for (const child of node.children ?? []) collect(child, acc)
  }

  return {
    reconcile(model: DomModel): void {
      assign(model.root)
      const present = new Set<string>()
      collect(model.root, present)
      for (const [path, ref] of [...pathToRef]) {
        if (!present.has(path)) {
          pathToRef.delete(path)
          refToPath.delete(ref)
        }
      }
    },
    refOf: (backendPath: string): string | null => pathToRef.get(backendPath) ?? null,
    resolve: (ref: string): string | null => refToPath.get(ref) ?? null,
    invalidate(): void {
      pathToRef.clear()
      refToPath.clear()
      // `counter` is intentionally left untouched — monotonic across the whole
      // session so a post-invalidate page never re-mints a ref a prior page used.
    },
  }
}

const renderNode = (node: DomNode, depth: number, refMap: RefMap, lines: string[]): void => {
  const ref = refMap.refOf(node.backendPath) ?? "?"
  const indent = "  ".repeat(depth)
  let line = `${indent}- ${ref} ${node.role} ${JSON.stringify(node.name)}`
  if (node.level !== undefined) line += ` h${node.level}`
  if (node.states !== undefined && node.states.length > 0) line += ` [${node.states.join(",")}]`
  if (node.value !== undefined) line += ` =${JSON.stringify(node.value)}`
  if (node.placeholder !== undefined) line += ` ph=${JSON.stringify(node.placeholder)}`
  if (node.url !== undefined) line += ` (${node.url})`
  lines.push(line)
  for (const child of node.children ?? []) renderNode(child, depth + 1, refMap, lines)
}

/** Reconcile refs against `model`, then render the accessibility tree to a
 *  stable indented string. Pure given a deterministic `refMap` state. */
export const buildSnapshot = (model: DomModel, refMap: RefMap): string => {
  refMap.reconcile(model)
  const lines: string[] = [`# ${model.title}`]
  renderNode(model.root, 0, refMap, lines)
  return lines.join("\n")
}
