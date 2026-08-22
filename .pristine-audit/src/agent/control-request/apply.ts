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

/** Host callbacks that LAND each applied control. Every method is optional — a
 *  host that does not support an axis simply omits it (the effect is planned +
 *  returned for observability but no-ops). NO-THROW expectation: a callback that
 *  throws is caught by {@link drainControlRequests}. */
export interface ControlEffectApplier {
  readonly setModel?: (model: string) => void
  readonly setPermissionMode?: (mode: string) => void
  readonly setThinking?: (level: string) => void
  readonly reportUsage?: (usage: ContextUsageSnapshot) => void
  readonly onRejected?: (reason: string) => void
}

/** Route ONE planned effect to the matching applier callback. Pure dispatch —
 *  exhaustive over the {@link ControlEffect} union. */
export const applyControlEffect = (effect: ControlEffect, applier: ControlEffectApplier): void => {
  switch (effect.kind) {
    case "model-set":
      applier.setModel?.(effect.model)
      return
    case "permission-mode-set":
      applier.setPermissionMode?.(effect.mode)
      return
    case "thinking-set":
      applier.setThinking?.(effect.level)
      return
    case "usage":
      applier.reportUsage?.(effect.usage)
      return
    case "rejected":
      applier.onRejected?.(effect.reason)
      return
    default: {
      const _exhaustive: never = effect
      void _exhaustive
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
export const drainControlRequests = (
  port: ControlRequestPort,
  ctx: ControlRequestContext,
  applier: ControlEffectApplier,
): ControlEffect[] => {
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
    try {
      applyControlEffect(effect, applier)
    } catch {
      // a thrown applier callback must not derail the turn — record nothing for
      // this one and stop (the host's apply path is broken; bail conservatively).
      break
    }
    applied.push(effect)
  }
  return applied
}
