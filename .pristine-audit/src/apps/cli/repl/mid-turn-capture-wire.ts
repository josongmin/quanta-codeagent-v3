/**
 * #8 last-mile (jun-6) — mid-turn keystroke capture → plan-queue → next-turn
 * drain SEAM.
 *
 * The mid-turn-capture FACADE (`defaultMidTurnCapture`, ADR-0177) and the
 * next-turn DRAIN mechanism (the `externalPromptQueue` that `promptSource.next()`
 * already races against the raw-line reader) both exist and are tested. The one
 * missing link is the SOURCE: while a turn is in flight the CLI runs NO stdin
 * reader (the loop awaits `runOneTurn` with `readLine` detached), so a user
 * "typing while running" (the Codex pattern) has nowhere to land — keystrokes
 * are simply not read mid-turn today.
 *
 * Standing up a concurrent raw-mode keypress listener that runs ALONGSIDE the
 * streaming turn is a hot-path change (raw-mode lifecycle, ctrl-c arbitration,
 * redraw vs streaming-output contention) — deliberately OUT of scope here. This
 * module wires the SAFE half: a `MidTurnCaptureHandle` that, given a COMPLETED
 * input line (from a future concurrent reader, or a test), routes it through the
 * capture facade so it is enqueued onto the live plan-queue AND mirrored onto the
 * `externalPromptQueue` so the existing turn-boundary race drains it as the next
 * prompt. The concurrent SOURCE is the residual a follow-up wires into this seam.
 *
 * DEFAULT-OFF byte-identity: `maybeCreateMidTurnCaptureWire` returns `undefined`
 * unless `QUANTA_MIDTURN_CAPTURE=1`. With the handle absent NOTHING calls
 * `captureLine`, so the input/turn loop is byte-identical to today. With the
 * handle PRESENT but no source feeding it, behavior is STILL byte-identical (the
 * seam allocates a facade but is never invoked). Only when a source actually
 * delivers a mid-turn line does anything reach the queues.
 *
 * Plane-clean: imports the capture facade (`@/agent/mid-turn-interruption`) +
 * the plan-queue type only. The `pushExternal` sink is INJECTED (the session
 * loop binds it to `externalPromptQueue.push`) so this module never reaches into
 * the surface state. No `Date.now` / `Math.random` / `process.env` here — the
 * gate is read by the caller off `runtimeConfig`; the optional `now` is injected.
 */

import { defaultMidTurnCapture, type MidTurnCapture } from "@/agent/mid-turn-interruption"
import type { PlanQueueStore } from "@/agent/plan-queue"

/** A live mid-turn capture handle. A future concurrent keystroke reader (or a
 *  test) calls `captureLine(text)` for every completed input line that arrives
 *  WHILE a turn is in flight. The handle enqueues it onto the plan-queue (so
 *  `/queue` can inspect/mutate it) AND mirrors it onto the external prompt queue
 *  so the existing turn-boundary race surfaces it as the next prompt. */
export interface MidTurnCaptureHandle {
  /** Capture one completed mid-turn input line. NO-THROW (the underlying
   *  facade swallows internal faults). `turnIndex` is the in-flight turn the
   *  line arrived during (carried into the FollowUp for replay ordering). */
  captureLine(text: string, turnIndex: number): Promise<void>
  /** The underlying capture facade (exposed so a host can also drain/peek the
   *  plan-queue partition for this thread). */
  readonly capture: MidTurnCapture
}

export interface MidTurnCaptureWireDeps {
  /** Gate — the resolved `runtimeConfig.midTurnCapture`. False ⇒ no handle. */
  readonly enabled: boolean
  /** Owning thread id (the live session id). Absent / empty ⇒ no handle (no
   *  plan-queue partition to address). */
  readonly threadId: string | undefined
  /** The live plan-queue store (`defaultPlanQueueStore`) — the captured line is
   *  persisted here so `/queue` surfaces it. */
  readonly planQueue: PlanQueueStore
  /** Mirror the captured text onto the live out-of-band prompt ingress
   *  (`externalPromptQueue.push`) so the turn-boundary race drains it as the
   *  next prompt. Bound by the session loop; MAY throw (full/closed queue) —
   *  the handle swallows it (best-effort, never breaks the turn). */
  readonly pushExternal: (text: string) => void
  /** Injected clock for the capture facade (tests pin it). Default `Date.now`. */
  readonly now?: () => number
}

/**
 * Build the mid-turn capture handle when the knob is ON and a thread id exists.
 * Returns `undefined` otherwise (default-OFF byte-identical — the caller wires
 * nothing). The capture facade is built over the SAME plan-queue store the
 * surface already owns, so a captured line is visible to `/queue` immediately.
 */
export const maybeCreateMidTurnCaptureWire = (
  deps: MidTurnCaptureWireDeps,
): MidTurnCaptureHandle | undefined => {
  if (!deps.enabled) return undefined
  if (deps.threadId === undefined || deps.threadId.length === 0) return undefined

  const capture = defaultMidTurnCapture({
    planQueue: deps.planQueue,
    threadId: deps.threadId,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })

  return {
    capture,
    captureLine: async (text: string, turnIndex: number): Promise<void> => {
      // Persist into the plan-queue via the facade (mode "queue" ⇒ the line is
      // held for the next turn boundary, the typing-while-streaming default).
      await capture.capture({
        text,
        receivedAtMs: deps.now?.() ?? Date.now(),
        mode: "queue",
        observedTurnIndex: turnIndex,
      })
      // Mirror onto the live external ingress so the turn-boundary race surfaces
      // it as the next prompt. Best-effort: a queue fault must never break the
      // in-flight turn that produced the keystroke.
      try {
        deps.pushExternal(text)
      } catch {
        /* full/closed queue — the plan-queue copy survives for `/queue` */
      }
    },
  }
}
