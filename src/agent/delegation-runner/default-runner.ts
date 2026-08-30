/**
 * Default delegation-runner (ADR-0283).
 *
 * Validates the {@link DelegateSpec}, enforces depth ({@link MAX_DEPTH}),
 * chains the parent signal, and dispatches through the mode-typed delegation
 * router from `@/agent/subagent-typed`. The runner builds a {@link BoomerangResult}
 * for every terminal path — NEVER throws.
 *
 * The "child agent instance" is whatever {@link TypedDelegationRunner} the
 * host wired into the router. In the default-OFF posture the host passes
 * {@link headlessDelegationRunner} so tests + CLIs without a live LLM still
 * get a typed result.
 *
 * Plane-clean: imports only `@/agent/subagent-typed` (the router primitive)
 * + sibling slice files. NO `@/agent/loop`, no `@/agent/dispatch`, no
 * `@/llm`, no `@/tool`.
 */

import {
  AGENT_MODES,
  type AgentMode,
  type BoomerangResult,
  type DelegationPort,
  defaultDelegationRouter,
  failureBoomerang,
  type TypedDelegationRunner,
} from "@/agent/subagent-typed"
import { errMessage } from "@/shared"
import { headlessDelegationRunner } from "./headless-stub"
import type { DelegationRunnerPort } from "./port"
import { type DelegateSpec, MAX_DEPTH } from "./types"
export interface DefaultDelegationRunnerOpts {
  /** Injected {@link TypedDelegationRunner} — the actual child agent driver.
   *  Tests + default-OFF surfaces inject {@link headlessDelegationRunner};
   *  production hosts pass a real loop-backed runner. When absent, the
   *  headless stub is used. */
  readonly runner?: TypedDelegationRunner
  /** Injected clock for `durationMs`. Default `Date.now`. */
  readonly now?: () => number
  /** Override `MAX_DEPTH` for tests. Production callers MUST NOT pass this. */
  readonly maxDepth?: number
}

/** Pure validator. Returns null when ok, or the failure-boomerang `message`
 *  prose otherwise. Public surface NEVER throws — every validation miss
 *  collapses to a `runner-error` boomerang. */
const validateSpec = (spec: DelegateSpec): string | null => {
  if (typeof spec.prompt !== "string" || spec.prompt.length === 0) {
    return "spec-invalid: prompt must be a non-empty string"
  }
  if (!(AGENT_MODES as readonly string[]).includes(spec.mode)) {
    return `spec-invalid: unknown mode '${spec.mode}'`
  }
  const b = spec.budget
  if (b !== undefined) {
    if (b.maxTurns !== undefined && (!Number.isFinite(b.maxTurns) || b.maxTurns <= 0)) {
      return "spec-invalid: budget.maxTurns must be a positive finite number"
    }
    if (b.maxTokens !== undefined && (!Number.isFinite(b.maxTokens) || b.maxTokens <= 0)) {
      return "spec-invalid: budget.maxTokens must be a positive finite number"
    }
  }
  if (spec.depth !== undefined && (!Number.isFinite(spec.depth) || spec.depth < 0)) {
    return "spec-invalid: depth must be a non-negative finite number"
  }
  return null
}

const failedDelegate = (args: {
  readonly mode: AgentMode
  readonly errorKind: "runner-error" | "cancelled"
  readonly errorMessage: string
  readonly startedAt: number
  readonly now: () => number
}): BoomerangResult =>
  failureBoomerang({
    mode: args.mode,
    errorKind: args.errorKind,
    errorMessage: args.errorMessage,
    turns: 0,
    durationMs: args.now() - args.startedAt,
  })

/** Pre-dispatch terminal cases. The typed router owns all post-dispatch
 * behavior; this boundary only rejects work that must never reach a child. */
const preflightFailure = (
  spec: DelegateSpec,
  maxDepth: number,
  startedAt: number,
  now: () => number,
): BoomerangResult | undefined => {
  const validationError = validateSpec(spec)
  if (validationError !== null) {
    const mode = (
      (AGENT_MODES as readonly string[]).includes(spec.mode) ? spec.mode : "explore"
    ) as AgentMode
    return failedDelegate({
      mode,
      errorKind: "runner-error",
      errorMessage: validationError,
      startedAt,
      now,
    })
  }
  const depth = spec.depth ?? 0
  if (depth >= maxDepth) {
    return failedDelegate({
      mode: spec.mode,
      errorKind: "runner-error",
      errorMessage: `depth-exceeded: delegation depth ${depth} >= cap ${maxDepth}`,
      startedAt,
      now,
    })
  }
  return spec.signal?.aborted === true
    ? failedDelegate({
        mode: spec.mode,
        errorKind: "cancelled",
        errorMessage: "parent signal already aborted at delegate() call",
        startedAt,
        now,
      })
    : undefined
}

/** Build the default delegation runner. The returned port encapsulates the
 *  mode-router + spec validation + depth gate. The host may swap in any
 *  {@link TypedDelegationRunner} (headless stub for tests, real loop driver
 *  for production). */
export const defaultDelegationRunner = (
  opts?: DefaultDelegationRunnerOpts,
): DelegationRunnerPort => {
  const inner: TypedDelegationRunner = opts?.runner ?? headlessDelegationRunner()
  const now = opts?.now ?? Date.now
  const maxDepth = opts?.maxDepth ?? MAX_DEPTH

  // The typed router shares an injected `now` so `durationMs` is consistent
  // across the failure-shortcuts and the runner-driven success path.
  const router: DelegationPort = defaultDelegationRouter({
    runner: inner,
    now,
  })

  return {
    async delegate(spec: DelegateSpec): Promise<BoomerangResult> {
      const startedAt = now()
      const preflight = preflightFailure(spec, maxDepth, startedAt, now)
      if (preflight !== undefined) return preflight

      // 4) Dispatch through the typed router. The router handles mode
      // lookup + budget cap + signal chaining + child-throw wrapping +
      // outcome projection. We just project the spec to the router shape.
      try {
        const req = {
          mode: spec.mode,
          prompt: spec.prompt,
          ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
          ...(spec.signal !== undefined ? { parentSignal: spec.signal } : {}),
          ...(spec.correlation !== undefined ? { correlation: spec.correlation } : {}),
        }
        return await router.delegate(req)
      } catch (err) {
        // Defense-in-depth: the router shouldn't throw, but if a custom
        // runner panics in a path the router didn't catch, we still surface
        // a typed boomerang here (NEVER throw past the public port).
        const msg = errMessage(err)
        return failureBoomerang({
          mode: spec.mode,
          errorKind: "runner-error",
          errorMessage: `child-threw: ${msg}`,
          turns: 0,
          durationMs: now() - startedAt,
        })
      }
    },
  }
}
