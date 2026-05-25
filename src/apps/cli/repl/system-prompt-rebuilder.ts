/**
 * Mid-session system-prompt rebuilder (ADR-0302).
 *
 * Closes the last-mile gap from ADR-0291: `/identity <mode>` mutates the
 * surface's active identity-mode cell, but the LLM keeps seeing the OLD
 * system prompt that was captured once at session bootstrap. This module
 * provides two tiny seams the surface can wire together to refresh the
 * prompt on the next turn WITHOUT restarting the session.
 *
 *   - {@link SystemPromptRebuilderPort} — pure recompute closure over the
 *     identity-mode cell + a base builder. No IO, no side effects.
 *   - {@link SystemSource} — surface-owned mutable cell holding the current
 *     system prompt string. The per-turn assembler reads `get()`; the
 *     rebuilder writes `set(rebuilder.rebuild())` on every mode swap.
 *
 * Default-OFF: when the surface does NOT construct a rebuilder OR does
 * NOT pass an `onChange` callback to the identity-mode adapter, behavior
 * is byte-identical to today (state-only swap, stale prompt — exactly the
 * ADR-0291 ship state).
 */

import type { ModeVariantKey } from "@/agent/system-prompt"

/** Recompute the current system prompt against whatever upstream state has
 *  changed (identity mode swap today, future plugin reload tomorrow). Pure
 *  of side effects; the caller decides what to do with the result. No-throw
 *  contract: a failing `baseBuilder` returns a typed fallback string. */
export interface SystemPromptRebuilderPort {
  rebuild(): string
}

/** Args for {@link createSystemPromptRebuilder}. `mode` is a closure so
 *  the rebuilder picks up the LIVE identity-mode cell on every call
 *  rather than capturing a snapshot at construction. `baseBuilder`
 *  produces the prompt string from the resolved mode + cwd. */
export interface CreateSystemPromptRebuilderArgs {
  readonly mode: () => ModeVariantKey | undefined
  readonly cwd: string
  readonly baseBuilder: (mode: ModeVariantKey | undefined, cwd: string) => string
}

/** Typed-fallback string returned when `baseBuilder` throws. Stable shape
 *  so test assertions can target it; the leading prefix is constant and
 *  the suffix is the error reason (single-line, no newlines spliced in). */
export const SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX = "(prompt rebuild failed: "

const sanitizeReason = (raw: string): string => raw.replace(/[\r\n]+/g, " ")

const formatFallback = (reason: string): string =>
  `${SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX}${sanitizeReason(reason)})`

/** Build the rebuilder closure. Pure. The returned port's `rebuild()`
 *  reads the LIVE mode via `args.mode()`, calls `args.baseBuilder` with
 *  it + the captured cwd, and never throws — a builder throw is wrapped
 *  in {@link SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX}. */
export const createSystemPromptRebuilder = (
  args: CreateSystemPromptRebuilderArgs,
): SystemPromptRebuilderPort => ({
  rebuild: (): string => {
    try {
      return args.baseBuilder(args.mode(), args.cwd)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return formatFallback(reason)
    }
  },
})

/** Surface-owned mutable "current system prompt" cell. The per-turn
 *  `AgentConfig` assembler reads `get()`; the rebuilder writes `set(next)`
 *  on every mode swap. `set` is idempotent on equal values — repeated
 *  writes of the same string never trigger downstream re-builds in tests
 *  that observe set-count. */
export interface SystemSource {
  get(): string
  set(next: string): void
}

/** Build a {@link SystemSource} seeded with `initial`. Pure. */
export const createSystemSource = (initial: string): SystemSource => {
  let current = initial
  return {
    get: (): string => current,
    set: (next: string): void => {
      if (next === current) return
      current = next
    },
  }
}
