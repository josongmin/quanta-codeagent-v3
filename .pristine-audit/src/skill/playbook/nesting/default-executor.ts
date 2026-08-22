/**
 * Default depth-bounded nested playbook executor (ADR-0258).
 *
 * Constructor takes:
 *   - `childLookup` — caller-injected `(id) => ((args) => unknown) | undefined`.
 *     A miss surfaces as `{ kind: "child-not-found" }`.
 *   - `opts.maxDepth` — caps the call chain length. Default `DEFAULT_MAX_DEPTH`
 *     (3). The opts knob lets a host opt into a higher cap; 3 covers the
 *     typical Devin "A → B → C" three-link chain.
 *
 * Mutable state: ONE private call frame (chain + visit set) per top-level
 * invocation. JavaScript synchronous semantics + a try/finally guard make
 * this safe — the stack is empty after each top-level invoke returns
 * (success OR `child-error`), so "concurrent" serial top-level invokes are
 * always isolated (HELL-PN-13).
 *
 * Cycle detection is delegated to `./cycle-detector.ts` (HELL-PN-09).
 *
 * Slice discipline: leaf. Imports only from `./types`, `./port`, and
 * `./cycle-detector`. NO `@/agent`, NO `@/tool`, NO `@/shared`.
 */

import { checkCycle } from "./cycle-detector"
import type { ChildLookup, NestedPlaybookExecutor } from "./port"
import { DEFAULT_MAX_DEPTH, type NestError, type NestedResult, type Result } from "./types"

/**
 * Shallow-freeze the child output. Plain values (string, number, boolean,
 * null, undefined) pass through; objects/arrays freeze top-level only.
 * HELL-PN-14 pins the top-level freeze.
 */
const freezeOutput = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Object.isFrozen(value)) return value
  return Object.freeze(value)
}

/**
 * Mutable per-executor frame. One instance per `createDefaultNestedExecutor`
 * call; reset (in-place) per top-level `invoke` entry.
 */
interface Frame {
  chain: string[]
  visited: Set<string>
}

const resetFrame = (frame: Frame): void => {
  frame.chain = []
  frame.visited = new Set()
}

/** Rebuild the visit set after a `chain.pop()`. */
const restoreFromChain = (frame: Frame): void => {
  frame.visited = new Set(frame.chain)
}

/**
 * Factory for the default executor. Returns the closed
 * {@link NestedPlaybookExecutor} port — callers never see the private
 * frame state.
 *
 * parentId is informational metadata for the port contract; the hellgate
 * (HELL-PN-04) renders the cycle chain from childId pushes only, so we
 * do not need to bake parentId into the visit set. The `_` prefix on the
 * parameter declares the unused-on-purpose status to the linter.
 */
export const createDefaultNestedExecutor = (
  childLookup: ChildLookup,
  opts?: { readonly maxDepth?: number },
): NestedPlaybookExecutor => {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH

  // Private mutable frame. Reset to an empty chain after each top-level
  // invoke returns. Recursive `invoke()` calls reach this same closure and
  // see the live chain — that is how a child that calls back into the
  // executor extends the same visit set.
  const frame: Frame = { chain: [], visited: new Set() }

  /**
   * Try the chained pre-flight checks. Returns either the cycle-check
   * `visited` set to splice in (caller proceeds to invoke the child) or a
   * typed error result to short-circuit on.
   */
  const preflight = (
    childId: string,
    nextDepth: number,
  ): { kind: "go"; visited: ReadonlySet<string> } | { kind: "stop"; error: NestError } => {
    if (nextDepth > maxDepth) {
      return {
        kind: "stop",
        error: { kind: "depth-exceeded", attempted: nextDepth, max: maxDepth },
      }
    }
    const cycle = checkCycle(frame.chain, frame.visited, childId)
    if (cycle.kind === "cycle") {
      return { kind: "stop", error: { kind: "cycle-detected", chain: cycle.chain } }
    }
    return { kind: "go", visited: cycle.visited }
  }

  /**
   * Run the resolved child. Push/pop frame around the call; convert thrown
   * exceptions into typed `child-error` (HELL-PN-06).
   */
  const runChild = (
    childId: string,
    child: (args: unknown) => unknown,
    visited: ReadonlySet<string>,
    args: unknown,
  ): { ok: true; value: unknown } | { ok: false; error: NestError } => {
    frame.chain.push(childId)
    frame.visited = visited as Set<string>
    try {
      const out = child(args)
      frame.chain.pop()
      restoreFromChain(frame)
      return { ok: true, value: out }
    } catch (cause) {
      frame.chain.pop()
      restoreFromChain(frame)
      return { ok: false, error: { kind: "child-error", id: childId, cause } }
    }
  }

  /** Inner pipeline — returns `Result` already wrapped; caller handles frame reset. */
  const invokeCore = (
    childId: string,
    args: unknown,
    nextDepth: number,
  ): Result<NestedResult, NestError> => {
    const pre = preflight(childId, nextDepth)
    if (pre.kind === "stop") return { ok: false, error: pre.error }
    const child = childLookup(childId)
    if (child === undefined) {
      return { ok: false, error: { kind: "child-not-found", id: childId } }
    }
    const ran = runChild(childId, child, pre.visited, args)
    if (!ran.ok) return { ok: false, error: ran.error }
    return {
      ok: true,
      value: { childOutput: freezeOutput(ran.value), depthUsed: nextDepth },
    }
  }

  const invoke = (
    _parentId: string,
    childId: string,
    args: unknown,
    depth: number,
  ): Result<NestedResult, NestError> => {
    const isTopLevel = depth === 0
    if (isTopLevel) resetFrame(frame)
    const result = invokeCore(childId, args, depth + 1)
    if (isTopLevel) resetFrame(frame)
    return result
  }

  return Object.freeze({ invoke }) satisfies NestedPlaybookExecutor
}
