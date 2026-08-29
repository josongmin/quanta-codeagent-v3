/**
 * Control-request EFFECT APPLICATION (ADR-0496, live-consume wire).
 *
 * The pure {@link planControlRequest} maps a request → typed {@link ControlEffect};
 * this module APPLIES a planned effect by routing it to host-supplied callbacks
 * ({@link ControlEffectApplier}). Kept as a callback seam (not direct loop
 * mutation) so the slice stays plane-clean and the loop / IDE host owns HOW each
 * control lands (re-resolve the LLM, mutate the permission authority, emit a
 * usage event, …).
 *
 * `drainControlRequests` is the loop-side helper: it pulls every pending request
 * off the {@link ControlRequestPort}, plans it against the live allowlists, and
 * applies the resulting effect. It is BOUNDED (a hostile/looping port cannot spin
 * the turn forever) and NO-THROW (a thrown port stops the drain cleanly).
 *
 * SURFACE NOTE: a thick CLI has no control channel to feed the port — this is the
 * IDE / web-host protocol surface (Claude Code control-request parity). The CLI
 * wires no source; an IDE host wires a real port + appliers. Default-OFF via
 * {@link isControlRequestEnabled}.
 */
import type {
  ContextUsageSnapshot,
  ControlEffect,
  ControlRequestContext,
  ControlRequestPort,
} from "./types"
import { planControlRequest } from "./types"

/**
 * Outcome of ONE applied control (MR-03).
 *
 * Typed, because the previous fire-and-forget shape could not tell the client the
 * truth: `set_model` echoed `model-set` the instant the frame was planned, while
 * the durable write was still in flight and might fail. The operator saw success
 * over a switch that never happened.
 */
export type ControlApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Host callbacks that LAND each applied control. Every method is optional — a host
 * that does not support an axis simply omits it (the effect is planned + returned
 * for observability but no-ops).
 *
 * ASYNC (MR-03). `setModel` in particular must be able to make the turn WAIT: the
 * drain runs at the top of a turn, and the measured failure was that the write
 * had not landed by the time the same turn read the selection — the turn ran the
 * OLD model while the end-of-turn echo, reading a by-then-updated cell, reported
 * the NEW one. A synchronous applier cannot express "not yet", so the boundary
 * itself had to become async.
 *
 * NO-THROW expectation: a callback that throws is caught by
 * {@link drainControlRequests} and treated as a rejection.
 */
export interface ControlEffectApplier {
  readonly setModel?: (model: string) => Promise<ControlApplyResult> | ControlApplyResult
  readonly setPermissionMode?: (mode: string) => void
  readonly setThinking?: (level: string) => void
  readonly reportUsage?: (usage: ContextUsageSnapshot) => void
  readonly onRejected?: (reason: string) => void
}

/** Route ONE planned effect to the matching applier callback. Pure dispatch —
 *  exhaustive over the {@link ControlEffect} union. */
export const applyControlEffect = async (
  effect: ControlEffect,
  applier: ControlEffectApplier,
): Promise<ControlApplyResult> => {
  switch (effect.kind) {
    case "model-set":
      // AWAITED: the caller must not report a switch the durable write has not
      // accepted, and the turn about to start must not read a selection that is
      // still being written.
      return applier.setModel === undefined ? { ok: true } : await applier.setModel(effect.model)
    case "permission-mode-set":
      applier.setPermissionMode?.(effect.mode)
      return { ok: true }
    case "thinking-set":
      applier.setThinking?.(effect.level)
      return { ok: true }
    case "usage":
      applier.reportUsage?.(effect.usage)
      return { ok: true }
    case "rejected":
      applier.onRejected?.(effect.reason)
      return { ok: true }
    default: {
      const _exhaustive: never = effect
      void _exhaustive
      return { ok: true }
    }
  }
}

/** Upper bound on requests drained in one turn — a hostile port that always
 *  returns a request cannot livelock the loop. Generous vs any real burst. */
export const MAX_CONTROL_REQUESTS_PER_DRAIN = 64

/**
 * Drain every pending control request off `port`, plan each against `ctx`'s live
 * allowlists, and apply the effect via `applier`. Returns the applied effects (in
 * order) for observability/tests. BOUNDED + NO-THROW: a thrown `next()` or a
 * thrown applier callback ends the drain with what was applied so far.
 */
export const drainControlRequests = async (
  port: ControlRequestPort,
  ctx: ControlRequestContext,
  applier: ControlEffectApplier,
): Promise<ControlEffect[]> => {
  const applied: ControlEffect[] = []
  for (let i = 0; i < MAX_CONTROL_REQUESTS_PER_DRAIN; i++) {
    let req: ReturnType<ControlRequestPort["next"]>
    try {
      req = port.next()
    } catch {
      break // a thrown port ends the drain cleanly
    }
    if (req === null) break
    const effect = planControlRequest(req, ctx)
    let result: ControlApplyResult
    try {
      result = await applyControlEffect(effect, applier)
    } catch (e) {
      // a thrown applier callback must not derail the turn — record nothing for
      // this one and stop (the host's apply path is broken; bail conservatively).
      void e
      break
    }
    // An apply that FAILED is reported as a rejection, not as the effect it
    // attempted. The client's echo is the only signal it gets, so echoing
    // `model-set` for a write the store refused is the lie MR-03 exists to remove.
    applied.push(result.ok ? effect : { kind: "rejected", reason: result.reason })
    if (!result.ok) applier.onRejected?.(result.reason)
  }
  return applied
}
