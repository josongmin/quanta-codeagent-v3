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

import type { AppSpec, AppshotArtifactSink, AppshotPort, VerifyVerdict } from "./port"

/** Hard floor/ceiling on the iteration cap so a caller can never request an
 *  unbounded (or zero) loop. The model picks within `[MIN, MAX]`; out-of-range
 *  is clamped, not rejected. */
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

/** Why the loop terminated. `pass` = a verdict said pass; `exhausted` = hit the
 *  cap with the last verdict still failing; `failed` = an effect error ended it
 *  fail-closed (Chrome down, LLM throw, jail escape, abort). */
export type AppshotOutcomeKind = "pass" | "exhausted" | "failed"

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

/** Safe error-message extraction (no `@/shared` import to keep the leaf pure). */
const message = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error"

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

  for (let i = 0; i < cap; i++) {
    const spec: AppSpec = { prompt: req.prompt, feedback: [...state.feedback] }
    const iteration = await runIteration(deps, spec, req, i)
    state.iterations.push(iteration)
    if (iteration.entryUrl !== undefined) state.entryUrl = iteration.entryUrl
    if (iteration.artifactId !== undefined) state.artifactId = iteration.artifactId

    // An effect error ends the loop fail-closed (RFC §8).
    if (iteration.error !== undefined) {
      return finalize(state, "failed", { error: iteration.error })
    }

    // Full chain completed — record the verdict.
    const verdict = iteration.verdict
    if (verdict !== undefined) {
      state.lastVerdict = verdict
      if (verdict.pass) return finalize(state, "pass", { lastVerdict: verdict })
      // Fold the critique into the next iteration's feedback (the edit arrow).
      if (verdict.notes.length > 0) state.feedback.push(verdict.notes)
    }
  }

  // Hit the cap without a pass — fail-closed carrying the last verdict.
  return finalize(state, "exhausted", {})
}
