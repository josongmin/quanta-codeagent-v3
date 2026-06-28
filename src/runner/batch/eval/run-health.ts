/**
 * BENCH RUN-HEALTH detector + early systemic-abort gate.
 *
 * Real pain (jun-25/26 full-remote): a run would burn 20–40min and produce 0/N
 * because of a SYSTEMIC failure the per-instance loop never detected early —
 *   - auth dead: EVERY instance fails turns=0 with `ChatGPT-OAuth: not signed in`
 *     (the account token was invalidated). Retrying the other 5–6 instances is
 *     futile — they all hit the same dead token.
 *   - box-level infra: spot reclaim / ssh-255 / exit-137 OOM / readiness timeout.
 *     Box-level, not the model; the run is broken until the box is healthy.
 * The operator had to eyeball CloudWatch/logs to answer "is it even working?".
 *
 * This module makes the BENCH self-detect health:
 *   1. `classifyInstanceHealth` — pure classifier of ONE finished instance.
 *   2. `shouldAbortRun` — given the categories seen so far (in order), decide
 *      whether the run is SYSTEMICALLY broken and the loop should stop launching
 *      more instances.
 *   3. `runBatchWithHealth` — order-preserving serial loop that consults the gate
 *      after each result, emits a loud one-shot health line, and stops early on a
 *      systemic verdict. Byte-identical behavior for a HEALTHY run (every
 *      instance attempted, no abort) — the gate only fires on systemic failure.
 *
 * Default-ON, opt-out via `QUANTA_BENCH_HEALTH_ABORT=0` (force-run all N). Env is
 * read in the bench layer (matches the existing `gateOn(process.env, …)` bench
 * pattern) rather than the runtime-config knob registry.
 */
import { gateDisabled, logger } from "@/shared"
import type { InstanceResult } from "../types"

/** Health category for one finished instance. */
export type InstanceHealth =
  | "systemic_auth" // dead/invalid token — whole account is bad, retry is futile
  | "systemic_infra" // box-loss / OOM(137) / ssh-255 / readiness — box-level
  | "transient_throttle" // 429 / rate-limit / overloaded — recoverable, NOT model-miss
  | "model_attempt" // turns>0 + a patch, ungraded — REAL generation (healthy)
  | "graded_pass" // graded resolved (healthy)
  | "graded_fail" // graded, did not resolve (HEALTHY miss — model just missed)
  | "empty_or_stall" // turns=0 (or empty patch) with no auth/infra/throttle error

/** A category is "systemic" iff it indicates the WHOLE run is broken (account or
 *  box), not just this one instance missing. */
export const isSystemic = (c: InstanceHealth): boolean =>
  c === "systemic_auth" || c === "systemic_infra"

/** A category is HEALTHY generation/grading — proof the scaffold is working. */
export const isHealthySignal = (c: InstanceHealth): boolean =>
  c === "model_attempt" || c === "graded_pass" || c === "graded_fail"

// --- error pattern matchers (lowercased substring/regex on result.error) ---

/** Auth = dead/invalid token (re-login required). Matches the adapter's
 *  not-signed-in / token-refresh-failed strings AND a bare 401/403/invalid_grant
 *  / token_invalidated. Auth is checked BEFORE infra: an auth error that happens
 *  to mention a status code is still systemic_auth (account is the root). */
const AUTH_PATTERNS: readonly RegExp[] = [
  /not signed in/,
  /token refresh failed/,
  /token[_ ]invalidated/,
  /invalid_grant/,
  /\bunauthorized\b/,
  /re-?auth/, // re-auth / reauthenticate / re-authentication — unambiguous auth-death
  /\b401\b/,
  /\b403\b/,
  /\bauth\b/,
]

/** Infra = box-level loss: spot reclaim / ssh-255 / exit-137 OOM / readiness. */
const INFRA_PATTERNS: readonly RegExp[] = [
  /box[ -]?loss/,
  /box[ -]?lost/,
  /spot reclaim/,
  /ssh[ -]?255/,
  /\b255\b/,
  /exit\s*137/,
  /\b137\b/,
  /\boom\b/,
  /out of memory/,
  /not ready/,
  /readiness/,
  /connect.*timed out/,
  /ssh_terminal_error/,
]

/** Throttle = transient rate-limit / overload (429 / "rate limit" / overloaded).
 *  Checked LAST among the error buckets (auth → infra → throttle → stall): a
 *  genuine auth/infra failure whose log incidentally carries a throttle word must
 *  win, so throttle only claims a PURE rate-limit. This is RECOVERABLE — upstream
 *  retry/backoff handles it — so it is NEITHER systemic (no abort: a rate-limited
 *  box is not a broken box — the jun-20 lesson is that conflating throttle with a
 *  real failure is the confound) NOR a model miss. Its sole job: make a throttled
 *  run VISIBLE as throttle instead of vanishing into the unattributed
 *  `empty_or_stall` bucket (the old measurement hole). */
const THROTTLE_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[ _-]?limit/,
  /throttl/,
  /too many requests/,
  /overloaded/,
]

const matchesAny = (text: string, pats: readonly RegExp[]): boolean =>
  pats.some((p) => p.test(text))

/**
 * Classify ONE finished instance result into a health category. Pure — no I/O,
 * no env. Precedence: auth error → infra error → real attempt → graded → stall.
 * Auth is checked first because it is the all-or-nothing systemic root.
 */
export const classifyInstanceHealth = (result: InstanceResult): InstanceHealth => {
  const err = (result.error ?? "").toLowerCase()
  if (err !== "") {
    // Order matters (hell-audit R1): AUTH first (all-or-nothing account root) →
    // INFRA next → THROTTLE last (before the stall fallback). Throttle is checked
    // AFTER infra so a genuine box-level wedge whose log INCIDENTALLY contains a
    // throttle word ("spot reclaim; rate limit", "overloaded; OOM exit 137") still
    // classifies as systemic_infra and trips the abort gate — not masked as a
    // benign throttle. A PURE rate-limit (429 with no infra token) still falls
    // through to transient_throttle: NAMED (not a mystery stall) but non-aborting
    // (throttle is recoverable — the jun-20 confound lesson).
    if (matchesAny(err, AUTH_PATTERNS)) return "systemic_auth"
    if (matchesAny(err, INFRA_PATTERNS)) return "systemic_infra"
    if (matchesAny(err, THROTTLE_PATTERNS)) return "transient_throttle"
    // An unrecognized harness error with turns=0 / no patch is a stall, not a
    // systemic signal — don't trip the abort gate on noise we can't attribute.
  }
  // Graded: a graded-pass is the strongest healthy signal. A graded fail (turns>0
  // + a patch that ran through grading) is a HEALTHY miss.
  const hasPatch = result.patch !== ""
  const ranTurns = result.turns > 0
  if (result.passed) return "graded_pass"
  if (ranTurns && hasPatch) {
    // The instance was graded iff a grade breakdown / verdict exists; otherwise it
    // produced a patch but was never graded (still a REAL attempt).
    return result.gradeBreakdown !== undefined ? "graded_fail" : "model_attempt"
  }
  // turns=0, or turns>0 with an empty patch, and no auth/infra error ⇒ stall.
  return "empty_or_stall"
}

/** Verdict from the early-abort gate. */
export interface AbortDecision {
  abort: boolean
  /** The systemic category driving the abort (undefined when not aborting). */
  category?: "systemic_auth" | "systemic_infra"
  /** Human-readable reason (always set; "" when not aborting). */
  reason: string
}

/** Min instances that must ALL be systemic before a non-auth systemic abort. ONE
 *  systemic_auth is enough (auth is all-or-nothing per account). */
const INFRA_ABORT_K = 2

/**
 * Decide whether to ABORT the run given the categories observed SO FAR (in
 * launch order). Rules:
 *   - ANY `systemic_auth` ⇒ abort immediately (one dead token = whole account).
 *   - the first `INFRA_ABORT_K` (default 2) instances are ALL `systemic_infra`
 *     ⇒ abort (the box environment is broken, not a single flaky box).
 *   - a `graded_*` / `model_attempt` anywhere ⇒ NEVER abort (the run is HEALTHY;
 *     the model just didn't solve some instances).
 *   - a single `systemic_infra` or any number of `empty_or_stall` alone ⇒ do not
 *     abort yet (could be one flaky box / a slow instance).
 */
export const shouldAbortRun = (history: readonly InstanceHealth[]): AbortDecision => {
  if (history.some((c) => c === "systemic_auth")) {
    return {
      abort: true,
      category: "systemic_auth",
      reason:
        "every attempt failed auth (dead/invalid account token) — retrying more instances is futile; re-login (`quanta /login --chatgpt`) and re-run",
    }
  }
  // A healthy signal anywhere means generation IS working — never systemic-abort.
  if (history.some(isHealthySignal)) return { abort: false, reason: "" }
  // First K instances ALL systemic_infra ⇒ box environment broken.
  if (
    history.length >= INFRA_ABORT_K &&
    history.slice(0, INFRA_ABORT_K).every((c) => c === "systemic_infra")
  ) {
    return {
      abort: true,
      category: "systemic_infra",
      reason: `first ${INFRA_ABORT_K} instances all failed at the box level (loss / OOM / ssh-255 / readiness) — the box environment is broken, not the model`,
    }
  }
  return { abort: false, reason: "" }
}

/** Run-health verdict embedded in the run summary / report. */
export interface RunHealthVerdict {
  /** Did the early-abort gate stop the loop? */
  aborted: boolean
  /** "healthy" once a healthy signal is seen, else the dominant systemic
   *  category, else "unknown" (only stalls observed). */
  verdict: InstanceHealth | "healthy" | "unknown"
  /** Abort reason (or systemic diagnosis when the gate was disabled). "" when healthy. */
  reason: string
  /** Instances actually attempted (≤ total when aborted). */
  attempted: number
  /** Total selected instances. */
  total: number
  /** Per-instance categories in launch order (diagnostic). */
  categories: InstanceHealth[]
}

const deriveVerdict = (
  categories: readonly InstanceHealth[],
): RunHealthVerdict["verdict"] => {
  if (categories.some(isHealthySignal)) return "healthy"
  if (categories.some((c) => c === "systemic_auth")) return "systemic_auth"
  if (categories.some((c) => c === "systemic_infra")) return "systemic_infra"
  if (categories.some((c) => c === "transient_throttle")) return "transient_throttle"
  if (categories.some((c) => c === "empty_or_stall")) return "empty_or_stall"
  return "unknown"
}

export interface RunBatchWithHealthOptions<T> {
  instances: readonly T[]
  runInstance: (instance: T) => Promise<InstanceResult>
  /** Env source (defaults to process.env). Gate `QUANTA_BENCH_HEALTH_ABORT`. */
  env?: Record<string, string | undefined>
  /** Test seam for the loud log line; defaults to the shared logger. */
  log?: (msg: string) => void
  /** Extract a stable id for the loud log line. Defaults to reading `.id`
   *  (matches {@link import("../types").Instance}); the bench dataset path
   *  passes `(t) => t.instanceId` for its `SwebenchTask` shape. */
  idOf?: (instance: T) => string
}

export interface RunBatchWithHealthResult {
  results: InstanceResult[]
  runHealth: RunHealthVerdict
}

/**
 * Serial, order-preserving instance loop with run-health detection + early
 * systemic-abort. This intentionally mirrors the serial (`concurrency<=1`) path
 * of `mapWithConcurrency`: results stay in input order, one `runInstance` in
 * flight at a time. For a HEALTHY run it attempts EVERY instance and never
 * aborts — byte-identical outcomes to the plain serial loop, with the addition
 * of a one-shot "RUN HEALTHY" log line.
 *
 * The early-abort only stops LAUNCHING further instances; it never cancels an
 * in-flight one. Concurrency>1 still uses `mapWithConcurrency` upstream — health
 * abort is a serial-path optimisation (full-remote runs grade serially anyway).
 */
export const runBatchWithHealth = async <T = { id: string }>(
  opts: RunBatchWithHealthOptions<T>,
): Promise<RunBatchWithHealthResult> => {
  // @/runner is slice-pure: the env record is INJECTED by the composition root
  // (apps/bench passes `process.env`); never read process.env here directly.
  const env = opts.env ?? {}
  const log = opts.log ?? ((m: string) => logger.warn(m))
  const idOf =
    opts.idOf ?? ((instance: T) => String((instance as { id?: unknown }).id ?? "<unknown>"))
  const gateEnabled = !gateDisabled(env, "QUANTA_BENCH_HEALTH_ABORT")
  const total = opts.instances.length

  const results: InstanceResult[] = []
  const categories: InstanceHealth[] = []
  let healthyAnnounced = false
  let unhealthyAnnounced = false
  let aborted = false
  let abortReason = ""

  for (let i = 0; i < opts.instances.length; i += 1) {
    const instance = opts.instances[i] as T
    const result = await opts.runInstance(instance)
    results.push(result)
    const category = classifyInstanceHealth(result)
    categories.push(category)

    // Positive health signal — emit ONCE the moment generation is confirmed.
    if (!healthyAnnounced && isHealthySignal(category)) {
      healthyAnnounced = true
      log(`RUN HEALTHY: generating (instance ${idOf(instance)}, turns=${result.turns})`)
    }

    const decision = shouldAbortRun(categories)
    if (decision.abort && !unhealthyAnnounced) {
      unhealthyAnnounced = true
      abortReason = decision.reason
      log(
        `RUN UNHEALTHY: ${decision.category} — ${decision.reason}; aborting after ${results.length}/${total}`,
      )
      if (gateEnabled) {
        aborted = true
        break
      }
      // Gate disabled (operator forced a full run): keep going, but the verdict
      // still records the systemic diagnosis below.
    }
  }

  return {
    results,
    runHealth: {
      aborted,
      verdict: deriveVerdict(categories),
      reason: aborted ? abortReason : "",
      attempted: results.length,
      total,
      categories,
    },
  }
}
