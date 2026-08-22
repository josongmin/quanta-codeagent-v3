/**
 * G1 — the appshot verify-loop core (RFC jun-6-appgen-appshot §4.1, Phase 1).
 *
 * The CLOSED feedback cycle that binds generation → observation:
 *
 *   spec ─► scaffold ─► render ─► screenshot ─► verify
 *             ▲                                    │
 *             └────────── feedback ◄───────────────┘  (until pass | maxIter)
 *
 * This file is PURE-ish: it imports ONLY its own `./port` (no `@/browser`,
 * `@/agent`, `@/llm`). Every effect is injected through {@link AppshotPort}; the
 * clock is injected ({@link AppshotLoopDeps.now}) — there is NO `Date.now()` /
 * `Math.random()` / `process.env` here (RFC §Hygiene, [[no-heuristics-only-validated]]).
 *
 * Bounded: the loop runs AT MOST `maxIter` iterations and ALWAYS terminates —
 * either early on a `pass` verdict, or fail-closed at the cap carrying the last
 * verdict (RFC §6, §8 verify-loop non-termination). No infinite loop is possible.
 *
 * NO-THROW: every injected effect (scaffold/render/screenshot/verify) is called
 * inside a try/catch; a throw (Chrome launch fragility, transport drop, LLM
 * error) maps to a typed `error` step and ENDS the loop fail-closed — the loop
 * itself never rejects (RFC §8 browser dependency / flakiness: "a render that
 * can't bring up Chrome degrades to verify-skipped, not a crash").
 */

import { errMessage } from "@/shared/errors"
import {
  type AppSpec,
  type AppshotArtifactSink,
  type AppshotPort,
  isRealJudgePass,
  type VerifyVerdict,
} from "./port"

/** Hard floor/ceiling on the iteration cap so a caller can never request an
 *  unbounded (or zero) loop. The model picks within `[MIN, MAX]`; out-of-range
 *  is clamped, not rejected (and a non-finite request clamps to the SAFE
 *  extreme — `APPSHOT_MIN_ITER`, never the ceiling: see {@link clampIter}).
 *
 *  Basis for MAX = 8 (a COST bound, not a correctness constant): each iteration
 *  is one FULL scaffold→render(Chrome)→screenshot→LLM-judge cycle — the most
 *  expensive thing this tool does (a real browser launch + a judge model call).
 *  The cap exists ONLY to stop a stuck judge (one that never returns `pass`)
 *  from burning unbounded browser launches + judge tokens; correctness does not
 *  depend on the exact number because the loop ALSO terminates early on the
 *  first `pass` and fail-closed on any effect error. 8 = a generous "refine a
 *  handful of times" budget: the edit arrow folds each failing verdict's notes
 *  forward, and in practice a converging app passes in 2-3; 8 leaves headroom
 *  for a slow-converging spec without letting a non-converging one loop forever.
 *  It is deliberately a small constant rather than a knob — it is a defensive
 *  ceiling the model never needs to tune (it requests its own `max_iterations`
 *  WITHIN this band), and the per-call request is the tunable axis. */
export const APPSHOT_MIN_ITER = 1
export const APPSHOT_MAX_ITER = 8
/** PNG byte cap — refuse an oversize screenshot rather than judge it. Mirrors
 *  the `browser_screenshot` `MAX_SCREENSHOT_BYTES` invariant (RFC §6, §3.2). */
export const APPSHOT_MAX_SCREENSHOT_BYTES = 4_000_000

/** Why an iteration ended without a verdict (the non-`verdict` arms). Closed
 *  union — a new failure mode is a compile error at every exhaustive consumer. */
export type AppshotStepError =
  | { readonly kind: "scaffold_failed"; readonly message: string }
  | { readonly kind: "render_failed"; readonly message: string }
  | { readonly kind: "screenshot_failed"; readonly message: string }
  | { readonly kind: "screenshot_over_cap"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "verify_failed"; readonly message: string }
  | { readonly kind: "aborted" }
  /** The CDP browser (render/screenshot arrows) is structurally unavailable —
   *  reported by {@link AppshotPort.availability} BEFORE any effect. A typed
   *  refusal, NOT a runtime failure: no browser launch was even attempted. */
  | { readonly kind: "browser_unavailable" }
  /** The LLM-judge (verify arrow) is structurally unavailable — reported by
   *  {@link AppshotPort.availability} BEFORE any effect. A typed refusal: the loop
   *  will NOT scaffold/render/screenshot only to have no way to judge the result
   *  (which could fabricate a pass). No judge ⇒ no pass, ever. */
  | { readonly kind: "judge_unavailable" }
  /** The judge returned `pass: true` but the verdict is NOT branded by
   *  `judgeVerdict` — i.e. NOT a real judge result (a stub, a fabricated pass, an
   *  unavailable-judge placeholder). Fail-closed: the loop refuses to claim a pass
   *  no real judge produced. This is the "a pass requires a real judge" gate. */
  | { readonly kind: "unverified_pass" }

/** One iteration's record. `verdict` is present iff the full arrow chain
 *  (scaffold→render→screenshot→verify) completed; otherwise `error` says where
 *  it broke. `entryUrl` / `artifactId` are present iff the scaffold succeeded. */
export interface AppshotIteration {
  readonly index: number
  readonly entryUrl?: string
  readonly artifactId?: string
  readonly verdict?: VerifyVerdict
  readonly error?: AppshotStepError
  /** Caller clock at iteration start (injected) — for deterministic ordering /
   *  observability, never read from a wall clock inside the core. */
  readonly startedAt: number
}

/** Why the loop terminated. `pass` = a REAL-judge verdict said pass; `exhausted`
 *  = hit the cap with the last verdict still failing; `failed` = an effect error
 *  ended it fail-closed at CALL TIME (Chrome throw, LLM throw, jail escape,
 *  abort); `refused` = a fail-closed pre-flight/contract refusal that ran NO
 *  effect chain to a verdict (browser/judge structurally unavailable, or a
 *  `pass` that no real judge produced). `refused` is DISTINCT from `failed` so a
 *  consumer never mistakes "unavailable/unverifiable" for "attempted and broke". */
export type AppshotOutcomeKind = "pass" | "exhausted" | "failed" | "refused"

/** Final loop result — fully typed, NEVER thrown. */
export interface AppshotResult {
  readonly outcome: AppshotOutcomeKind
  readonly iterations: readonly AppshotIteration[]
  /** The last verdict observed (present whenever ANY iteration reached verify),
   *  surfaced as the user-facing critique on pass OR exhaustion. */
  readonly lastVerdict?: VerifyVerdict
  /** The terminating error (present iff `outcome === "failed"`). */
  readonly error?: AppshotStepError
  /** Artifact id of the FINAL scaffolded entry file (the produced app), present
   *  iff at least one scaffold succeeded AND a sink was wired. */
  readonly artifactId?: string
  /** Entry URL of the final scaffold (present iff a scaffold succeeded). */
  readonly entryUrl?: string
}

/** Injected dependencies for {@link runAppshotLoop}. */
export interface AppshotLoopDeps {
  readonly port: AppshotPort
  /** Injected clock — the ONLY time source (no `Date.now()` in the core). */
  readonly now: () => number
  /** Optional artifact sink — when wired, the FINAL scaffolded entry file is
   *  registered (kind `other`) and its id surfaced. Absent ⇒ no registration
   *  (byte-identical), `artifactId` undefined. Registration is best-effort: a
   *  throwing sink NEVER breaks the loop. */
  readonly artifactSink?: AppshotArtifactSink
}

/** Caller request for one loop run. */
export interface AppshotRequest {
  readonly prompt: string
  /** Jailed output dir the scaffold writes into (resolved by the adapter). */
  readonly outDir: string
  /** Desired iteration cap; clamped to `[APPSHOT_MIN_ITER, APPSHOT_MAX_ITER]`. */
  readonly maxIter: number
  /** Optional human label for the produced artifact. */
  readonly label?: string
  readonly signal?: AbortSignal
}

/** Clamp a requested iteration count into the hard `[MIN, MAX]` band. A
 *  non-finite / fractional request is floored then clamped (never rejected). */
export const clampIter = (requested: number): number => {
  if (!Number.isFinite(requested)) return APPSHOT_MIN_ITER
  const n = Math.floor(requested)
  if (n < APPSHOT_MIN_ITER) return APPSHOT_MIN_ITER
  if (n > APPSHOT_MAX_ITER) return APPSHOT_MAX_ITER
  return n
}

/** Safe error-message extraction via the canonical shared leaf (`@/shared/errors`
 *  is a zero-import pure module, so this preserves the leaf's purity). Also
 *  survives a hostile throw whose stringifier itself throws — this loop must
 *  never reject. Identical output for the Error / string cases. */
const message = errMessage

/** Best-effort register the final scaffold into the artifact sink. Returns the
 *  minted id, or undefined when no sink is wired OR the register threw (the loop
 *  is never broken by a side-channel registration). */
const registerEntry = (
  sink: AppshotArtifactSink | undefined,
  entryPath: string,
  mediaType: string,
  label: string | undefined,
): string | undefined => {
  if (sink === undefined) return undefined
  try {
    return sink.register({
      kind: "other",
      path: entryPath,
      mediaType,
      ...(label !== undefined ? { label } : {}),
    }).id
  } catch {
    return undefined
  }
}

/**
 * Run ONE iteration's arrow chain. Returns the iteration record — `verdict` on
 * full success, else `error` at the first broken arrow. Every effect is caught;
 * this NEVER throws. Mutates nothing outside the returned record.
 */
const runIteration = async (
  deps: AppshotLoopDeps,
  spec: AppSpec,
  req: AppshotRequest,
  index: number,
): Promise<AppshotIteration> => {
  const startedAt = deps.now()
  const base = { index, startedAt } as const
  if (req.signal?.aborted === true) {
    return { ...base, error: { kind: "aborted" } }
  }

  // scaffold ───────────────────────────────────────────────────────────────
  let scaffolded: Awaited<ReturnType<AppshotPort["scaffold"]>>
  try {
    scaffolded = await deps.port.scaffold(spec, req.outDir, req.signal)
  } catch (e) {
    return { ...base, error: { kind: "scaffold_failed", message: message(e) } }
  }
  const artifactId = registerEntry(
    deps.artifactSink,
    scaffolded.entryPath,
    scaffolded.mediaType,
    req.label,
  )
  const withScaffold = {
    ...base,
    entryUrl: scaffolded.entryUrl,
    ...(artifactId !== undefined ? { artifactId } : {}),
  } as const

  // render ──────────────────────────────────────────────────────────────────
  try {
    await deps.port.render(scaffolded.entryUrl, req.signal)
  } catch (e) {
    return { ...withScaffold, error: { kind: "render_failed", message: message(e) } }
  }

  // screenshot ────────────────────────────────────────────────────────────────
  let shot: Uint8Array
  try {
    shot = await deps.port.screenshot(req.signal)
  } catch (e) {
    return { ...withScaffold, error: { kind: "screenshot_failed", message: message(e) } }
  }
  if (shot.byteLength > APPSHOT_MAX_SCREENSHOT_BYTES) {
    return {
      ...withScaffold,
      error: {
        kind: "screenshot_over_cap",
        bytes: shot.byteLength,
        cap: APPSHOT_MAX_SCREENSHOT_BYTES,
      },
    }
  }

  // verify ────────────────────────────────────────────────────────────────────
  let verdict: VerifyVerdict
  try {
    verdict = await deps.port.verify(shot, spec, req.signal)
  } catch (e) {
    return { ...withScaffold, error: { kind: "verify_failed", message: message(e) } }
  }
  return { ...withScaffold, verdict }
}

/** Mutable accumulator threaded across iterations — the cross-iteration state
 *  every terminal {@link AppshotResult} folds in. */
interface LoopState {
  readonly iterations: AppshotIteration[]
  readonly feedback: string[]
  lastVerdict?: VerifyVerdict
  entryUrl?: string
  artifactId?: string
}

/** Fold the accumulated optional fields onto a terminal result, keeping the
 *  conditional-spread noise out of the hot loop (one place, low complexity). */
const finalize = (
  state: LoopState,
  outcome: AppshotOutcomeKind,
  extra: { readonly error?: AppshotStepError; readonly lastVerdict?: VerifyVerdict },
): AppshotResult => {
  const verdict = extra.lastVerdict ?? state.lastVerdict
  return {
    outcome,
    iterations: state.iterations,
    ...(extra.error !== undefined ? { error: extra.error } : {}),
    ...(verdict !== undefined ? { lastVerdict: verdict } : {}),
    ...(state.entryUrl !== undefined ? { entryUrl: state.entryUrl } : {}),
    ...(state.artifactId !== undefined ? { artifactId: state.artifactId } : {}),
  }
}

/**
 * Drive the bounded verify loop. Terminates ALWAYS — early on `pass`, at the
 * iteration cap on persistent failure (`exhausted`), or fail-closed on the first
 * effect error (`failed`). NEVER throws.
 *
 * The "edit" arrow is implemented by threading each failing verdict's `notes`
 * into the next iteration's {@link AppSpec.feedback}, oldest→newest, so the
 * scaffold adapter refines on the accumulated critique.
 */
export const runAppshotLoop = async (
  deps: AppshotLoopDeps,
  req: AppshotRequest,
): Promise<AppshotResult> => {
  const cap = clampIter(req.maxIter)
  const state: LoopState = { iterations: [], feedback: [] }

  // FAIL-CLOSED PRE-FLIGHT: if the port declares an arrow structurally
  // unavailable, refuse UP FRONT — never scaffold/render only to be unable to
  // judge (which risks fabricating a pass), never crash into a runtime `*_failed`.
  // The judge gate is checked first: no judge ⇒ no pass is ever possible.
  const availabilityRefusal = preflightRefusal(deps.port)
  if (availabilityRefusal !== undefined) {
    return finalize(state, "refused", { error: availabilityRefusal })
  }

  for (let i = 0; i < cap; i++) {
    const spec: AppSpec = { prompt: req.prompt, feedback: [...state.feedback] }
    const iteration = await runIteration(deps, spec, req, i)
    state.iterations.push(iteration)
    if (iteration.entryUrl !== undefined) state.entryUrl = iteration.entryUrl
    if (iteration.artifactId !== undefined) state.artifactId = iteration.artifactId

    const terminal = classifyIteration(state, iteration)
    if (terminal !== undefined) return terminal
  }

  // Hit the cap without a pass — fail-closed carrying the last verdict.
  return finalize(state, "exhausted", {})
}

/**
 * Fold ONE completed iteration into the loop state and decide whether it
 * TERMINATES the loop. Returns a terminal {@link AppshotResult} (effect error,
 * real-judge pass, or fail-closed `unverified_pass` refusal) or `undefined` to
 * continue. Mutates `state` (records the verdict + threads feedback). Kept out of
 * `runAppshotLoop` so the driver stays low-complexity.
 */
const classifyIteration = (
  state: LoopState,
  iteration: AppshotIteration,
): AppshotResult | undefined => {
  // An effect error ends the loop fail-closed (RFC §8).
  if (iteration.error !== undefined) {
    return finalize(state, "failed", { error: iteration.error })
  }
  const verdict = iteration.verdict
  if (verdict === undefined) return undefined
  state.lastVerdict = verdict
  // FAIL-CLOSED PASS GATE: honor `pass` ONLY when the verdict is BRANDED by a
  // real judge (`isRealJudgePass`). An unbranded `pass: true` (a stub, a
  // fabricated pass, an unavailable-judge placeholder) is REFUSED as
  // `unverified_pass` — the loop never claims success no real judge produced.
  if (isRealJudgePass(verdict)) return finalize(state, "pass", { lastVerdict: verdict })
  if (verdict.pass) {
    return finalize(state, "refused", {
      error: { kind: "unverified_pass" },
      lastVerdict: verdict,
    })
  }
  // Fold the critique into the next iteration's feedback (the edit arrow).
  if (verdict.notes.length > 0) state.feedback.push(verdict.notes)
  return undefined
}

/** Fail-closed pre-flight: read the port's optional availability report. Returns
 *  a typed refusal error when an arrow is structurally unavailable (judge first —
 *  no judge ⇒ no pass is ever possible), else undefined (proceed). A port that
 *  does not implement `availability()` is assumed fully wired (the production
 *  wire always has both arrows). A THROWING availability probe is itself treated
 *  as unavailable (fail-closed) — never a crash. */
const preflightRefusal = (port: AppshotPort): AppshotStepError | undefined => {
  if (port.availability === undefined) return undefined
  let avail: ReturnType<NonNullable<AppshotPort["availability"]>>
  try {
    avail = port.availability()
  } catch {
    // A probe that throws cannot vouch for availability ⇒ refuse (judge-first).
    return { kind: "judge_unavailable" }
  }
  if (avail.judge !== true) return { kind: "judge_unavailable" }
  if (avail.browser !== true) return { kind: "browser_unavailable" }
  return undefined
}
