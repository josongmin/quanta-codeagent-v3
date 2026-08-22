/**
 * Deterministic headless stub (ADR-0283).
 *
 * A `TypedDelegationRunner` impl that returns a deterministic outcome WITHOUT
 * spawning any child agent. Tests + hellgate batteries use this to assert the
 * router-shape independent of any LLM. The headless stub honours the same
 * 5-arm contract as the default runner so swap-in / swap-out is byte-clean.
 *
 * Plane-clean: imports only sibling type aliases. NO `@/agent/loop` / no
 * `@/llm` / no `@/tool`.
 */

import type {
  TypedDelegationRunner,
  TypedRunnerInput,
  TypedRunnerOutcome,
} from "@/agent/subagent-typed"

export interface HeadlessStubOpts {
  /** Optional deterministic finalText prefix. The stub appends the prompt
   *  (truncated to 200 chars) so the surface assert is meaningful. */
  readonly prefix?: string
  /** Optional fixed turn count to return. Default 1. */
  readonly turns?: number
  /** Optional fixed token cost. Absent ⇒ no `tokens` field on outcome. */
  readonly tokens?: number
  /** Force-ok flag. When false the stub returns ok=false with a deterministic
   *  errorMessage. Default true. */
  readonly ok?: boolean
}

const trunc = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`

/** Build a deterministic headless runner. Same prompt + same opts ⇒ same
 *  outcome on every call. The runner respects the supplied AbortSignal:
 *  already-aborted ⇒ surfaces `aborted` via the typed router which projects
 *  it as `cancelled`. */
export const headlessDelegationRunner = (opts?: HeadlessStubOpts): TypedDelegationRunner => {
  const prefix = opts?.prefix ?? "[headless]"
  const turns = opts?.turns ?? 1
  const ok = opts?.ok ?? true

  return async (input: TypedRunnerInput): Promise<TypedRunnerOutcome> => {
    if (input.signal.aborted === true) {
      // Surface as a runner-error so the router collapses it to `cancelled`
      // via its post-aborted check. The router checks `signal.aborted` after
      // the runner returns and projects the result accordingly.
      return {
        ok: false,
        finalText: "headless stub: signal already aborted",
        turns: 0,
        errorMessage: "aborted",
      }
    }
    const base: TypedRunnerOutcome = ok
      ? {
          ok: true,
          finalText: `${prefix} mode=${input.profile.mode} prompt=${trunc(input.prompt, 200)}`,
          turns,
        }
      : {
          ok: false,
          finalText: "",
          turns,
          errorMessage: "headless stub: forced ok=false",
        }
    return opts?.tokens !== undefined ? { ...base, tokens: opts.tokens } : base
  }
}
