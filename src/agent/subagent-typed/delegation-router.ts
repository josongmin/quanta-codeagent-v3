/**
 * Mode-typed delegation router (ADR-0218).
 *
 * Core orchestration: looks up the mode profile, validates the requested
 * budget against the mode's cap, fans the parent signal through an
 * isolated child controller, invokes the injected runner, and packages the
 * outcome as a {@link BoomerangResult}. Cancellation / budget overflow /
 * unknown mode all flow through the same boomerang shape — no thrown
 * exceptions cross the parent boundary except programmer-bug arms (which
 * are caught at the public surface and reported as `runner-error`).
 *
 * Plane-clean: imports ONLY this slice + `@/subagent` types. NO `@/agent/loop`,
 * NO `@/agent/dispatch`, NO `@/llm`, NO `@/tool`.
 *
 * Runner contract: the injected {@link TypedDelegationRunner} is the host's
 * bridge to the actual agent loop. It receives a fully-resolved profile +
 * the seeded prompt and returns the typed outcome shape; the router does
 * NOT know how the runner spawns the child. Same closed-port pattern as
 * `SubagentRunner` for ADR-0130.
 */

import { errMessage } from "@/shared"
import type { SubagentResult, SubagentRunner } from "@/subagent"
import { failureBoomerang, successBoomerang } from "./boomerang"
import { chainParentSignal, makeChildCorrelation } from "./isolated-context"
import { ALL_MODE_KEYS, lookupModeProfile } from "./mode-registry"
import type {
  AgentMode,
  BoomerangResult,
  DelegationPort,
  DelegationRequest,
  ModeProfile,
} from "./port"
/** Runner port — the host injects ONE function that runs a child agent under
 *  the supplied profile and returns a typed outcome. The runner's contract:
 *
 *   - MUST honour the profile's `allowedToolKinds` when constructing the
 *     child registry.
 *   - MUST honour `budget` (maxTurns / maxTokens) — the router has already
 *     validated against the profile cap, so the runner can trust the values.
 *   - MUST chain the supplied AbortSignal into the child's loop so cancellation
 *     propagates.
 *   - MAY return either {@link TypedRunnerOutcome} (preferred) or a generic
 *     {@link SubagentResult} (legacy bridge — see `wrapSubagentRunner`).
 */
export type TypedDelegationRunner = (input: TypedRunnerInput) => Promise<TypedRunnerOutcome>

export interface TypedRunnerInput {
  readonly profile: ModeProfile
  readonly prompt: string
  readonly signal: AbortSignal
  readonly budget: { readonly maxTurns: number; readonly maxTokens: number }
  readonly correlation: Readonly<Record<string, string>>
}

export interface TypedRunnerOutcome {
  readonly ok: boolean
  /** Final assistant text — surfaces as `summary` (truncated). */
  readonly finalText: string
  readonly turns: number
  /** Provider-counted tokens, when available. */
  readonly tokens?: number
  /** Named artifact pairs the child produced. Pure passthrough. */
  readonly artifacts?: Readonly<Record<string, string>>
  /** Free-form error prose when ok=false. */
  readonly errorMessage?: string
}

export interface DelegationRouterOpts {
  /** Caller-injected: how to actually run a child under a mode profile. */
  readonly runner: TypedDelegationRunner
  /** Injected clock; default `Date.now`. */
  readonly now?: () => number
  /** Optional explicit profile table override — defaults to the built-in
   *  registry. Useful for tests that want narrower tool kinds. */
  readonly profiles?: Readonly<Record<AgentMode, ModeProfile>>
}

/** Bridge: wrap an existing {@link SubagentRunner} (ADR-0130) so it can be
 *  used as a {@link TypedDelegationRunner}. The bridge translates the typed
 *  profile + budget into a `SubagentRequest`, and projects the resulting
 *  `SubagentResult` into a `TypedRunnerOutcome`. Artifact extraction is
 *  intentionally left to the host — the bridge passes through `finalText`
 *  and lets a caller-supplied parser populate `artifacts` later. */
export const wrapSubagentRunner = (subagentRunner: SubagentRunner): TypedDelegationRunner => {
  return async (input: TypedRunnerInput): Promise<TypedRunnerOutcome> => {
    const req = {
      prompt: input.prompt,
      depth: 0,
      signal: input.signal,
      budget: { maxTurns: input.budget.maxTurns, maxTokens: input.budget.maxTokens },
    }
    const out: SubagentResult = await subagentRunner(req)
    const base: TypedRunnerOutcome = {
      ok: out.ok,
      finalText: out.finalText,
      turns: out.turns,
    }
    if (out.ok) return base
    return { ...base, errorMessage: out.finalText || "subagent reported ok=false" }
  }
}

/** Validate the caller-supplied budget against the profile cap. Returns
 *  the effective budget, or `null` when the request overflows the cap. */
const resolveBudget = (
  profile: ModeProfile,
  reqBudget: DelegationRequest["budget"],
): { maxTurns: number; maxTokens: number } | null => {
  const reqTurns = reqBudget?.maxTurns
  const reqTokens = reqBudget?.maxTokens
  if (reqTurns !== undefined && (!Number.isFinite(reqTurns) || reqTurns <= 0)) return null
  if (reqTokens !== undefined && (!Number.isFinite(reqTokens) || reqTokens <= 0)) return null
  if (reqTurns !== undefined && reqTurns > profile.maxTurns) return null
  if (reqTokens !== undefined && reqTokens > profile.maxTokens) return null
  return {
    maxTurns: reqTurns ?? profile.maxTurns,
    maxTokens: reqTokens ?? profile.maxTokens,
  }
}

/** Build the seed prompt the runner receives. The mode rationale is
 *  prepended so the child has explicit posture context even when the
 *  host's prompt variant lookup misses. Pure: no IO. */
const composeSeedPrompt = (profile: ModeProfile, userPrompt: string): string => {
  const header = `[mode: ${profile.mode}] ${profile.rationale}`
  return `${header}\n\n${userPrompt}`
}

/** Pure projection: turn a successful runner outcome into a boomerang. */
const projectSuccess = (
  mode: AgentMode,
  outcome: TypedRunnerOutcome,
  durationMs: number,
): BoomerangResult =>
  successBoomerang({
    mode,
    summary: outcome.finalText || "(no text)",
    turns: outcome.turns,
    durationMs,
    ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
    ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
  })

/** Pure projection: turn a runner-reported failure into a boomerang. */
const projectRunnerFailure = (
  mode: AgentMode,
  outcome: TypedRunnerOutcome,
  durationMs: number,
): BoomerangResult =>
  failureBoomerang({
    mode,
    errorKind: "runner-error",
    errorMessage: (outcome.errorMessage ?? outcome.finalText) || "runner returned ok=false",
    turns: outcome.turns,
    durationMs,
    ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
    ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
  })

/** Pure projection: turn a cancellation event into a boomerang. */
const projectCancellation = (
  mode: AgentMode,
  msg: string,
  turns: number,
  durationMs: number,
  tokens?: number,
): BoomerangResult =>
  failureBoomerang({
    mode,
    errorKind: "cancelled",
    errorMessage: msg,
    turns,
    durationMs,
    ...(tokens !== undefined ? { tokens } : {}),
  })

/** Reduce a settled runner outcome (post-signal-check) to its boomerang. */
const reduceOutcome = (
  mode: AgentMode,
  outcome: TypedRunnerOutcome,
  durationMs: number,
  childAborted: boolean,
): BoomerangResult => {
  if (childAborted) {
    return projectCancellation(
      mode,
      "child cancelled during run",
      outcome.turns,
      durationMs,
      outcome.tokens,
    )
  }
  return outcome.ok
    ? projectSuccess(mode, outcome, durationMs)
    : projectRunnerFailure(mode, outcome, durationMs)
}

/** Reduce a runner-thrown error to its boomerang. */
const reduceThrow = (
  mode: AgentMode,
  err: unknown,
  durationMs: number,
  childAborted: boolean,
): BoomerangResult => {
  const msg = errMessage(err)
  if (childAborted) return projectCancellation(mode, msg, 0, durationMs)
  return failureBoomerang({
    mode,
    errorKind: "runner-error",
    errorMessage: msg,
    turns: 0,
    durationMs,
  })
}

/** Default factory — wires the supplied runner + registry into a closed
 *  {@link DelegationPort} ready for the host to inject through AgentConfig. */
export const defaultDelegationRouter = (opts: DelegationRouterOpts): DelegationPort => {
  const runner = opts.runner
  const now = opts.now ?? Date.now
  const profileTable = opts.profiles

  const lookup = (mode: AgentMode): ModeProfile | null => {
    if (profileTable !== undefined) {
      if (!(mode in profileTable)) return null
      return profileTable[mode]
    }
    return lookupModeProfile(mode)
  }

  return {
    listModes(): readonly AgentMode[] {
      if (profileTable !== undefined) return Object.freeze(Object.keys(profileTable) as AgentMode[])
      return ALL_MODE_KEYS
    },

    describeMode(mode: AgentMode): ModeProfile | null {
      return lookup(mode)
    },

    async delegate(req: DelegationRequest): Promise<BoomerangResult> {
      const startedAt = now()

      // 1) mode lookup — null ⇒ mode-missing
      const profile = lookup(req.mode)
      if (profile === null) {
        return failureBoomerang({
          mode: req.mode,
          errorKind: "mode-missing",
          errorMessage: `mode '${req.mode}' is not registered in the delegation router`,
          turns: 0,
          durationMs: now() - startedAt,
        })
      }

      // 2) budget validation — null ⇒ budget-overflow
      const budget = resolveBudget(profile, req.budget)
      if (budget === null) {
        const reqB = req.budget ?? {}
        return failureBoomerang({
          mode: req.mode,
          errorKind: "budget-overflow",
          errorMessage:
            `requested budget (maxTurns=${reqB.maxTurns ?? "default"}, ` +
            `maxTokens=${reqB.maxTokens ?? "default"}) exceeds mode cap ` +
            `(maxTurns=${profile.maxTurns}, maxTokens=${profile.maxTokens})`,
          turns: 0,
          durationMs: now() - startedAt,
        })
      }

      // 3) cancellation channel — chain parent signal into child controller
      const childCtrl = chainParentSignal(req.parentSignal)
      // Already aborted ⇒ short-circuit
      if (childCtrl.signal.aborted) {
        return failureBoomerang({
          mode: req.mode,
          errorKind: "cancelled",
          errorMessage: "parent signal already aborted at delegate() call",
          turns: 0,
          durationMs: now() - startedAt,
        })
      }

      // 4) isolated correlation map (deep-frozen)
      const correlation = makeChildCorrelation(req.correlation)

      // 5) seed prompt
      const seedPrompt = composeSeedPrompt(profile, req.prompt)

      // 6) invoke runner — every terminal path projects through one of the
      // pure reducer helpers; no inline shape construction here.
      try {
        const outcome = await runner({
          profile,
          prompt: seedPrompt,
          signal: childCtrl.signal,
          budget,
          correlation,
        })
        return reduceOutcome(req.mode, outcome, now() - startedAt, childCtrl.signal.aborted)
      } catch (err) {
        return reduceThrow(req.mode, err, now() - startedAt, childCtrl.signal.aborted)
      }
    },
  }
}
