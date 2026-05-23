/**
 * ADR-0062 rule #3 — structured cap-as-instruction enforcement (3rd channel).
 *
 * This module tracks the last `NextAction` emitted by a tool call (keyed by
 * `toolName:targetPath`) and detects when a subsequent call to the SAME tool
 * on the SAME target IGNORES the hint — i.e. the model calls again without
 * applying the suggested parameter change.
 *
 * DEFAULT-OFF: the entire enforcement path is gated on the `QUANTA_CAP_ENFORCE`
 * env flag (or `AgentConfig.capEnforce === true`). With the flag unset the
 * module is never instantiated and dispatch is byte-identical.
 *
 * PURE construction: `CapEnforcer` is session-scoped state — one instance per
 * `runAgent` session, re-used across turns.  The `check` + `record` helpers
 * are the only mutation surface; both are O(1).
 *
 * CLOSED-UNION: the `NextAction.kind` discriminant is closed. Every exhaustive
 * switch here must handle all three variants:
 *   - `increase_max_depth`   → check: `input.max_depth` didn't grow
 *   - `raise_max_files`      → check: `input.max_files` didn't grow
 *   - `narrow_path`          → check: `input.path` didn't change
 * A new variant on `NextAction` must extend this switch — `tsc` enforces it
 * via the `never` default arm.
 */

import type { NextAction } from "@/tool"

/** Stable key for a (toolName, targetPath) pair. `targetPath` is the
 *  model-supplied `path` argument (normalised to empty-string when absent).
 *  Two calls with the SAME key on consecutive turns is the "ignored" signal. */
const makeKey = (toolName: string, targetPath: string): string => `${toolName}\0${targetPath}`

/** Resolve the `path` argument from an opaque tool input, returning `""`
 *  when absent (no path ⇒ the CWD is the implicit target). */
const resolveInputPath = (input: unknown): string => {
  if (input !== null && typeof input === "object" && "path" in input) {
    const p = (input as { path: unknown }).path
    return typeof p === "string" ? p : ""
  }
  return ""
}

/** Whether the given input has APPLIED a `NextAction` suggestion.
 *  Returns `true` when the call satisfies the hint (no reminder needed);
 *  `false` when the call IGNORES the hint (reminder must fire).
 *
 *  Each `kind` checks the specific parameter named by ADR-0062:
 *   - `increase_max_depth` ⇒ `input.max_depth` must be ≥ `suggested`
 *   - `raise_max_files`    ⇒ `input.max_files` must be ≥ `suggested`
 *   - `narrow_path`        ⇒ `input.path` must be a non-empty string
 *     different from the prior target (narrowed the scope)
 *
 *  Unknown input shapes (no relevant numeric field) are treated as
 *  "not applied" — the conservative path. */
const isApplied = (action: NextAction, input: unknown, priorPath: string): boolean => {
  if (input === null || typeof input !== "object") return false
  const inp = input as Record<string, unknown>

  switch (action.kind) {
    case "increase_max_depth": {
      const v = inp.max_depth
      return typeof v === "number" && v >= action.suggested
    }
    case "raise_max_files": {
      const v = inp.max_files
      return typeof v === "number" && v >= action.suggested
    }
    case "narrow_path": {
      const v = inp.path
      // "narrowed" means a non-empty path that differs from the prior target
      return typeof v === "string" && v.length > 0 && v !== priorPath
    }
    default: {
      // exhaustive — a new `NextAction.kind` is a `tsc` error here
      const _exhaustive: never = action
      return false
    }
  }
}

/** Reminder text injected when a cap hint is ignored.
 *  ADR-0062 rule 1 verbatim phrasing. */
const buildReminder = (action: NextAction): string => {
  switch (action.kind) {
    case "increase_max_depth":
      return (
        `Last call returned nextAction.kind=increase_max_depth with suggested=${action.suggested}; ` +
        `your next call MUST apply that change before switching tools (ADR-0062 rule 1).`
      )
    case "raise_max_files":
      return (
        `Last call returned nextAction.kind=raise_max_files with suggested=${action.suggested}; ` +
        `your next call MUST apply that change before switching tools (ADR-0062 rule 1).`
      )
    case "narrow_path":
      return (
        `Last call returned nextAction.kind=narrow_path; ` +
        `your next call MUST apply that change before switching tools (ADR-0062 rule 1).`
      )
    default: {
      const _exhaustive: never = action
      return ""
    }
  }
}

/** Session-scoped tracker. One instance per `runAgent` call (shared across
 *  turns).  Maintains a map of `(toolName, targetPath) → LastHint` entries. */
export class CapEnforcer {
  /** key → last emitted NextAction + the target path at emission time */
  private readonly _last = new Map<string, { action: NextAction; path: string }>()

  /** Called BEFORE dispatch executes a tool call.
   *  Returns a reminder string when the prior hint for this (tool, path) was
   *  IGNORED, or `undefined` when no reminder is needed (no prior hint, or the
   *  hint was applied, or the target changed).
   *
   *  `priorPath` is derived from the CALL input (the path the model supplied
   *  THIS time); the prior-emission path was stored at record() time. */
  check(toolName: string, input: unknown): string | undefined {
    const currentPath = resolveInputPath(input)
    const key = makeKey(toolName, currentPath)
    const prior = this._last.get(key)
    if (prior === undefined) return undefined
    // The call is to the same (tool, path) — check if the hint was applied.
    if (isApplied(prior.action, input, prior.path)) return undefined
    return buildReminder(prior.action)
  }

  /** Called AFTER a tool returns a successful result with a non-undefined
   *  `nextAction`. Stores (or replaces) the hint for `(toolName, targetPath)`.
   *
   *  On a result WITHOUT a `nextAction` we CLEAR any prior hint for the same
   *  key — the model may have called the tool for a different purpose and a
   *  stale hint would generate spurious reminders. */
  record(toolName: string, input: unknown, nextAction: NextAction | undefined): void {
    const path = resolveInputPath(input)
    const key = makeKey(toolName, path)
    if (nextAction !== undefined) {
      this._last.set(key, { action: nextAction, path })
    } else {
      this._last.delete(key)
    }
  }
}

/** Return a CapEnforcer instance when the env flag or config boolean is set,
 *  `undefined` otherwise (DEFAULT-OFF, zero allocation). */
export const buildCapEnforcer = (capEnforce?: boolean): CapEnforcer | undefined => {
  if (capEnforce === true) return new CapEnforcer()
  if (process.env.QUANTA_CAP_ENFORCE === "1") return new CapEnforcer()
  return undefined
}
