/**
 * Closeout-triggered reviewer/critic gate (P12 — jun-7 gap-other-agent).
 *
 * OPTIONAL critic pass at the moment the agent loop decides a turn is complete.
 * Before the loop seals `{kind:"completed"}` it MAY consult an injected critic
 * (a reviewer subagent, via the existing reviewer-port DI) to surface a
 * second-opinion verdict on the draft answer. This is an ENHANCEMENT, never a
 * mandatory gate:
 *
 *   - default-OFF: `cfg === undefined` OR `cfg.enabled !== true` ⇒ this helper
 *     is a pure no-op that returns immediately. The loop's completion path is
 *     BYTE-IDENTICAL to the pre-critic loop (no allocation, no emit, no await
 *     side effects observable downstream).
 *   - port absent: `cfg.enabled === true` but `cfg.critic === undefined` ⇒
 *     FAIL-OPEN. No throw, no block; the critic is simply skipped. (Mirrors the
 *     reviewer-port "absent ⇒ unavailable" posture but on the hot path we do
 *     NOT fail-closed — closeout must never be blocked by a missing critic.)
 *   - critic throws / rejects: caught here. The completion proceeds. The error
 *     surfaces as observation-only stream output, never as a loop crash.
 *   - critic returns a "denied" verdict: surfaced as STRUCTURED stream output
 *     (a `recovery` event, the same observation channel verify/closeout guards
 *     use). It does NOT block the completion — the verdict is advisory data the
 *     host/UI can act on. The loop's control flow is unchanged.
 *
 * CRUX (hot-path safety): this module imports NO loop module (leaf, no cycle),
 * performs NO throw that can reach the loop, and is invoked from exactly ONE
 * seam in `applyAction` guarded by `cfg.enabled === true`. Knob OFF ⇒ the seam
 * short-circuits before any await.
 */

/** A single critic verdict over the agent's draft final answer. Structurally
 *  minimal so the port has no dependency on the reviewer-subagent internals —
 *  any adapter (reviewer subagent, classifier, human) can produce one. */
export interface CloseoutCriticVerdict {
  /** `approved` ⇒ the critic agrees the turn may finish. `denied` ⇒ the critic
   *  would have the agent keep working; advisory only on the hot path. */
  readonly outcome: "approved" | "denied"
  /** One-line justification. Surfaced verbatim in the observation event. */
  readonly rationale: string
  /** Optional severity hint mirroring the reviewer-subagent shape. */
  readonly riskLevel?: "low" | "medium" | "high"
}

/** The request the loop hands the critic at the completion seam. Carries the
 *  draft final text + a structural tool-history view so the critic can reason
 *  about what the agent actually did before declaring done. */
export interface CloseoutCriticRequest {
  /** The concatenated visible text of the draft final assistant message. */
  readonly finalText: string
  /** Tool names invoked this run (structural, name-only — same duck-typed
   *  shape the closeout-guard consumes). Empty/undefined ⇒ no tools ran. */
  readonly history?: ReadonlyArray<{ name: string }>
  /** Cooperative cancellation — the loop's effective turn signal. */
  readonly signal?: AbortSignal
}

/** Closed port: the injected critic. Absent ⇒ fail-open (skip). The port is
 *  the ONLY way a reviewer is reached — the loop never hardcodes one. */
export type CloseoutCritic = (req: CloseoutCriticRequest) => Promise<CloseoutCriticVerdict>

/** Config block on `AgentConfig`. `enabled` is the explicit opt-in gate (the
 *  knob sets it); `critic` is the injected port. Both absent ⇒ OFF. */
export interface CloseoutCriticConfig {
  readonly enabled?: boolean
  readonly critic?: CloseoutCritic
}

/**
 * Bound (ms) the critic await is raced against. Mirrors
 * `DEFAULT_COMMAND_HOOK_TIMEOUT_MS` (30_000) from `command-hooks/types.ts`: the
 * critic is the SAME shape as a command hook — an OUT-OF-BAND advisory
 * consultation (an LLM-backed reviewer subagent) run at the closeout seam that
 * must NEVER wedge the main path. We reuse that already-chosen, already-
 * documented value rather than inventing a new one, so a wedged reviewer / an
 * LLM ignoring its abort signal cannot stall the completion seal beyond this
 * bound. The value is NOT a knob today (presence-only knob); the constant is the
 * single documented source. A timeout converts to the SAME fail-open
 * observation a throw produces — the seal proceeds regardless. */
export const CLOSEOUT_CRITIC_TIMEOUT_MS = 30_000

/** Observation the loop surfaces when the critic produces a verdict (or fails).
 *  Returned to the caller instead of emitted directly so this module stays free
 *  of any stream/loop import — the loop maps it onto the existing `recovery`
 *  event under the `closeout` reason (no new `RecoveryReason` variant — the
 *  `critic:` detail prefix distinguishes it). `undefined` ⇒ nothing to surface
 *  (OFF / no-op). */
export interface CloseoutCriticObservation {
  readonly detail: string
}

/** Render a verdict into the observation detail string. Pure. */
const renderVerdict = (v: CloseoutCriticVerdict): string => {
  const risk = v.riskLevel !== undefined ? ` risk=${v.riskLevel}` : ""
  return `${v.outcome}${risk}: ${v.rationale}`
}

/** Sentinel the timeout / abort branches resolve with so a wedged critic
 *  (a promise that never settles) loses the race and the seal still proceeds.
 *  A unique symbol so it can NEVER collide with a verdict value. */
const ABORTED_OR_TIMED_OUT = Symbol("closeout-critic:aborted-or-timed-out")

/**
 * Optionally run the closeout critic. Returns the observation to surface (or
 * `undefined` for the OFF / no-op path). NEVER throws — every critic failure is
 * caught and converted to a structured observation. NEVER blocks: the return
 * value is advisory; the loop ignores it for control flow.
 *
 * Default-OFF byte-identical contract: when `cfg === undefined` or
 * `cfg.enabled !== true` or `cfg.critic === undefined`, this returns
 * `undefined` WITHOUT awaiting anything — so the completion path the loop runs
 * is observationally identical to the pre-critic loop.
 */
export const runCloseoutCritic = async (
  cfg: CloseoutCriticConfig | undefined,
  req: CloseoutCriticRequest,
): Promise<CloseoutCriticObservation | undefined> => {
  // OFF gates — short-circuit before any await (byte-identical completion).
  if (cfg === undefined) return undefined
  if (cfg.enabled !== true) return undefined
  // Port absent ⇒ FAIL-OPEN on the hot path (skip, do not block, do not throw).
  if (cfg.critic === undefined) return undefined

  // HOT-PATH HANG SAFETY: a wedged reviewer (an LLM ignoring its abort signal,
  // a reviewer subagent stuck in a loop) must NOT stall the completion seal
  // forever. The catch below only handles a critic that THROWS/REJECTS — a
  // critic that simply never resolves would hang the `await` indefinitely. So
  // we RACE `cfg.critic(req)` against (1) a bounded timeout and (2) the turn's
  // abort signal. Either losing branch resolves the same fail-open sentinel and
  // the seal proceeds. The try/catch still wraps the whole race so a SYNC throw
  // from a poison adapter is caught too (it never returns a promise).
  let verdict: CloseoutCriticVerdict
  try {
    const raced = await raceCriticAgainstBound(cfg.critic, req)
    if (raced === ABORTED_OR_TIMED_OUT) {
      // FAIL-OPEN: a hung / aborted critic surfaces as the SAME unavailable
      // observation a throw produces. The completion is NEVER blocked.
      return { detail: "critic:unavailable: timed out" }
    }
    verdict = raced
  } catch (e) {
    // FAIL-OPEN: a throwing critic must never crash the loop. Surface as data.
    const message = e instanceof Error ? e.message : String(e)
    return { detail: `critic:unavailable: ${message}` }
  }
  return { detail: `critic:${renderVerdict(verdict)}` }
}

/**
 * Race the critic await against a bounded timeout AND the request's abort
 * signal. Returns the verdict if the critic wins, else {@link
 * ABORTED_OR_TIMED_OUT}. NEVER rejects on the timeout/abort branches (those
 * resolve the sentinel); a throw from `critic` itself propagates so the caller's
 * try/catch converts it to the existing `unavailable` observation.
 *
 * The orphaned critic promise is intentionally NOT cancelled (the port has no
 * cancel contract beyond the `signal` we already forward in `req`); its later
 * settlement is dropped by `Promise.race`. The timer + abort listener are torn
 * down in `finally` so a fast critic does not leak the timer ref / pin the
 * abort listener.
 */
const raceCriticAgainstBound = (
  critic: CloseoutCritic,
  req: CloseoutCriticRequest,
): Promise<CloseoutCriticVerdict | typeof ABORTED_OR_TIMED_OUT> => {
  const signal = req.signal
  // Already-aborted ⇒ short-circuit fail-open WITHOUT invoking the critic.
  if (signal?.aborted === true) return Promise.resolve(ABORTED_OR_TIMED_OUT)

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const teardown = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort)
    }
  }
  const bound = new Promise<typeof ABORTED_OR_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(ABORTED_OR_TIMED_OUT), CLOSEOUT_CRITIC_TIMEOUT_MS)
    if (signal !== undefined) {
      onAbort = () => resolve(ABORTED_OR_TIMED_OUT)
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  // `critic(req)` is invoked HERE. A SYNCHRONOUS throw from a poison adapter
  // (it never returns a promise) propagates out of this function — we tear the
  // timer/listener down first so it does not leak, then rethrow for the caller's
  // try/catch to convert into the existing `unavailable` observation.
  let criticPromise: Promise<CloseoutCriticVerdict>
  try {
    criticPromise = critic(req)
  } catch (e) {
    teardown()
    throw e
  }
  return Promise.race([criticPromise, bound]).finally(teardown)
}
