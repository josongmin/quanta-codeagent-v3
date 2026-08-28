/**
 * Spinner-stall LIVE CLI composition (follow-up from e81010371 / UUX-1-15).
 *
 * # Why this module exists
 *
 * ADR-0227 shipped the stall detector as a pure slice and e81010371 added the
 * detector → operator-notice bridge (`wireStallDetectorToOperatorNotices`),
 * but NOTHING ever constructed a detector — adapters only honor the optional
 * `StreamInput.onChunk` tick (ADR-0234), which is a no-op with zero
 * registered correlations. This module is the missing COMPOSITION ROOT: the
 * CLI session (`session-setup.ts`) builds ONE wire per session and decorates
 * the session `LLMPort` with it, so a provider stream that goes silent
 * mid-turn surfaces as a latched operator notice ("model stream stalled…")
 * and its recovery as one info clear — the agent-state-visibility north star.
 *
 * # Gate (NEW, default-OFF — same discipline as `QUANTA_BG_TURN`)
 *
 * `QUANTA_SPINNER_STALL`, registered in `src/config/knob-inventory/host.ts`
 * with THIS file as the readSite (the literal below is the canonical
 * declaration the knob-registry completeness ratchet counts). NOT seeded by
 * `cli-feature-gates.ts` — strictly operator opt-in. Gate OFF ⇒
 * {@link buildSpinnerStallLiveWire} returns `undefined`, session-setup keeps
 * the LITERAL `boot.llm` reference and no timer is ever scheduled
 * (byte-identical; pinned by `session-setup-hellgate.test.ts`).
 *
 * # Composition shape
 *
 *   const wire = buildSpinnerStallLiveWire(gateOn(env, SPINNER_STALL_ENV_GATE))
 *   const llm  = wire === undefined ? boot.llm : wire.wrapLlm(boot.llm)
 *   // session close (shutdown closure): wire?.teardown()
 *
 * - **Per-call correlation.** Each `stream()` call registers a fresh
 *   correlation id, threads a COMPOSED `onChunk` (detector tick + the
 *   caller's own hook, never clobbered) into the input, ticks on every
 *   yielded `StreamEvent` as a backstop for transports that bypass the raw
 *   chunk hook, and stops the correlation in `finally` (completion, throw,
 *   or consumer abandon) — no leaked correlation across turns.
 * - **One poll timer per session.** Scheduled at construction
 *   ({@link SPINNER_STALL_POLL_INTERVAL_MS}); `teardown()` cancels it
 *   (idempotent). Clock + scheduler are injectable seams so the hellgate
 *   drives virtual time; production defaults are `Date.now` +
 *   `setInterval`/`clearInterval` (unref'd best-effort so a missed teardown
 *   can never pin the process).
 * - **Metadata forwarding.** The wrapper forwards the inner port's
 *   identity fields (`model`/`provider`/…) conditionally, mirroring the
 *   `withImageSanitizationRetry` decorator precedent (exactOptional-honest).
 *
 * Hellgate: `tests/unit/apps/cli/repl/spinner-stall-live-wire-hellgate.test.ts`.
 */

import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { forwardPortIdentity } from "@/llm/port-identity"
import {
  createDefaultStallDetector,
  DEFAULT_SPINNER_STALL_THRESHOLD_MS,
  wireStallDetectorToOperatorNotices,
} from "@/llm/spinner-stall"

/** The NEW default-OFF gate (knob-inventory host.ts entry; this literal is
 *  the canonical read-site declaration). */
export const SPINNER_STALL_ENV_GATE = "QUANTA_SPINNER_STALL"

/** Poll cadence for the stall emitter. 1s mirrors the CLI turn-indicator
 *  repaint cadence — fine-grained enough that a 30s-threshold stall surfaces
 *  within ~3% of its true onset, coarse enough to be free. */
export const SPINNER_STALL_POLL_INTERVAL_MS = 1_000

/** Injectable seams (tests drive a virtual clock + manual scheduler;
 *  production omits everything). */
export interface SpinnerStallLiveWireSeams {
  /** Wall-clock ms source. Default `Date.now`. */
  readonly clock?: () => number
  /** Per-correlation stall threshold. Default
   *  {@link DEFAULT_SPINNER_STALL_THRESHOLD_MS} (~30s, Claude Code parity). */
  readonly thresholdMs?: number
  /** Poll cadence. Default {@link SPINNER_STALL_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number
  /** Timer scheduler. Default `setInterval`. */
  readonly schedule?: (fn: () => void, intervalMs: number) => unknown
  /** Timer canceller. Default `clearInterval`. */
  readonly cancel?: (handle: unknown) => void
}

export interface SpinnerStallLiveWire {
  /** Decorate the session LLM so every `stream()` call is stall-tracked. */
  wrapLlm(llm: LLMPort): LLMPort
  /** Cancel the poll timer. Idempotent — the session shutdown closure calls
   *  it once; a duplicate call is a no-op. */
  teardown(): void
}

/**
 * Build the live wire, or `undefined` when the gate is off (the caller then
 * keeps its LITERAL un-wrapped port — byte-identical, nothing scheduled).
 */
export const buildSpinnerStallLiveWire = (
  enabled: boolean,
  seams: SpinnerStallLiveWireSeams = {},
): SpinnerStallLiveWire | undefined => {
  if (!enabled) return undefined
  const clock = seams.clock ?? Date.now
  const thresholdMs = seams.thresholdMs ?? DEFAULT_SPINNER_STALL_THRESHOLD_MS
  const pollIntervalMs = seams.pollIntervalMs ?? SPINNER_STALL_POLL_INTERVAL_MS
  const schedule = seams.schedule ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const cancel =
    seams.cancel ?? ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>))

  const detector = createDefaultStallDetector()
  const emitter = wireStallDetectorToOperatorNotices(detector)
  const handle = schedule(() => emitter.poll(clock()), pollIntervalMs)
  // Best-effort unref (real setInterval handles have it; injected fakes may
  // not): a session that somehow skips teardown must never pin the process.
  ;(handle as { unref?: () => void } | null | undefined)?.unref?.()

  let tornDown = false
  let streamSeq = 0

  const wrapStream = (llm: LLMPort, input: StreamInput): AsyncIterable<StreamEvent> => {
    streamSeq += 1
    const correlationId = `llm-stream-${streamSeq}`
    const callerOnChunk = input.onChunk
    const tick = (): void => detector.tickEvent({ correlationId, now: clock() })
    const inner = llm.stream({
      ...input,
      // ADR-0234 raw-chunk tick, COMPOSED with the caller's own hook (the
      // adapters' no-throw dispatcher swallows either side's failure).
      onChunk: (): void => {
        tick()
        callerOnChunk?.()
      },
    })
    return (async function* (): AsyncGenerator<StreamEvent> {
      detector.start({ correlationId, stallThresholdMs: thresholdMs, now: clock() })
      try {
        for await (const event of inner) {
          // StreamEvent-granularity backstop: transports that bypass the raw
          // onChunk hook still refresh the correlation on every event. A
          // double tick (raw + event) is harmless — tick = bump lastEventMs.
          tick()
          yield event
        }
      } finally {
        // Completion, throw, or consumer abandon (early `return()`): remove
        // the correlation AND clear a latched stall immediately, so the
        // operator never sees a phantom "stalled" for a dead stream.
        detector.stop({ correlationId })
        emitter.forceClear(correlationId)
      }
    })()
  }

  return {
    wrapLlm(llm: LLMPort): LLMPort {
      return {
        // ONE forwarder for the whole non-stream surface (aug-27). The inline
        // copy this replaces dropped `listModels`, so `/model`'s catalog probe
        // never reached the interactive surface — the picker could list only the
        // boot model. A new port field must not default to being eaten here.
        ...forwardPortIdentity(llm),
        stream: (input: StreamInput): AsyncIterable<StreamEvent> => wrapStream(llm, input),
      }
    },
    teardown(): void {
      if (tornDown) return
      tornDown = true
      cancel(handle)
    },
  }
}
