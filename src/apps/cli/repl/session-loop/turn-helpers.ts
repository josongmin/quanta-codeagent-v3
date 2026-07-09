import type { InboundMode } from "@/agent/inbound-mode"
import { sliceWholeChars } from "@/shared"
import type { ConversationActionSurface } from "../conversation-action-surface"
import type { ExternalPromptQueue } from "../external-prompt-queue"
import {
  type InTurnLineReaderHandle,
  type InTurnReaderStdin,
  startInTurnLineReader,
} from "../in-turn-reader"
import { routeMidTurnLine } from "../inbound-dispatch"
import { clearInputLane, enterLaneMode, exitLaneMode, renderInputLane } from "../input-lane"
import type { MidTurnCaptureHandle } from "../mid-turn-capture-wire"
import { type SessionState, updateSessionState } from "../session-state"

/** §steer — UTF-8 byte ceiling for a single mid-turn inbound line (the §steer
 *  `maxInputBytes`). 64 KiB: generous for a pasted instruction, bounded so a
 *  pathological paste cannot be injected wholesale. Named, not an inlined magic
 *  number (no-heuristic rule). */
const INBOUND_MAX_BYTES = 64 * 1024

/** §08b / audit R3 — the bottom mid-turn input-lane renderer. Entered LAZILY on
 *  the FIRST keystroke (a turn with no mid-turn typing never reserves the scroll
 *  region ⇒ byte-identical viewport), capturing the terminal height ONCE so the
 *  per-keystroke render + the teardown all target the SAME row even across a
 *  mid-turn resize. Extracted to a module factory to keep `runSessionLoop` under
 *  the cognitive-complexity cap. The caller writes `render` into the in-turn
 *  reader's `onPartial` and calls `teardown()` in the turn's `finally`. */
const makeLaneRenderer = (
  out: NodeJS.WriteStream,
): {
  render: (buffer: string) => void
  teardown: () => void
} => {
  let laneRows: number | null = null
  return {
    render(buffer: string): void {
      if (buffer.length === 0 && laneRows === null) return // nothing typed yet
      if (laneRows === null) {
        laneRows = out.rows ?? 24 // first keystroke: reserve the bottom row.
        out.write(enterLaneMode(laneRows))
      }
      const cols = out.columns
      out.write(
        buffer.length > 0
          ? renderInputLane(buffer, { rows: laneRows, ...(cols !== undefined ? { cols } : {}) })
          : clearInputLane({ rows: laneRows }),
      )
    },
    teardown(): void {
      if (laneRows === null) return
      try {
        out.write(exitLaneMode(laneRows))
      } catch {
        /* stdout torn down — nothing to restore */
      }
      laneRows = null
    },
  }
}

/** Wrap a `runOneTurn` invocation with the concurrent in-turn reader (+ optional
 *  bottom input lane). Default-OFF passthrough when no capture wire / stdin. When
 *  active, EXACTLY ONE reader is alive for the awaited turn — started before the
 *  await, disposed in `finally` (every exit path) so it never leaks into the next
 *  turn nor collides with the turn-boundary reader. Extracted to a module factory
 *  (owns the per-turn index counter) to keep `runSessionLoop` under the
 *  cognitive-complexity cap. */
export const makeInTurnCaptureWrapper = (args: {
  readonly midTurnCapture: MidTurnCaptureHandle | undefined
  readonly inTurnStdin: InTurnReaderStdin | undefined
  readonly inboundMode: { current: InboundMode } | undefined
  readonly conversationActions: ConversationActionSurface | undefined
  readonly externalPromptQueue: ExternalPromptQueue
  /** `QUANTA_MIDTURN_VISIBLE` knob value; the TTY gate is applied here. */
  readonly midTurnVisibleKnob: boolean
  /** MID-TURN FIX — flipped `.active` while the reader owns stdin so a mid-turn
   *  approval prompt reads via the captured line (not a second readline). */
  readonly midTurnApprovalChannel: import("../mid-turn-approval-channel").MidTurnApprovalChannel
}): (<R>(run: () => Promise<R>) => Promise<R>) => {
  // §08b — the lane render is opt-in AND TTY-only (ANSI to a pipe corrupts output).
  const midTurnVisible = args.midTurnVisibleKnob && process.stdout.isTTY === true
  let currentTurnIndex = 0
  return async <R>(run: () => Promise<R>): Promise<R> => {
    const { midTurnCapture, inTurnStdin } = args
    if (midTurnCapture === undefined || inTurnStdin === undefined) return await run()
    currentTurnIndex += 1
    const turnIndexForCapture = currentTurnIndex
    // §08b / audit R3 — lazy bottom-input-lane renderer (entered on first
    // keystroke, rows captured once). Undefined ⇒ no `onPartial`, no region change.
    const lane = midTurnVisible ? makeLaneRenderer(process.stdout) : undefined
    const reader: InTurnLineReaderHandle = startInTurnLineReader({
      stdin: inTurnStdin,
      onLine: (line) => {
        // MID-TURN FIX — a pending approval claims the next line as its answer
        // BEFORE follow-up routing (so "y"/"n" confirms the tool, not a queued
        // prompt). Consumed ⇒ stop here.
        if (args.midTurnApprovalChannel.tryResolve(line)) return
        // §steer — route by inbound mode (tested core `routeMidTurnLine`). queue /
        // no surface ⇒ capture path (byte-identical); weave/interrupt ⇒ decide
        // against the live turn. Ack NOT rendered inline (the EFFECT is the signal).
        routeMidTurnLine(line, {
          mode: args.inboundMode?.current ?? "queue",
          surface: args.conversationActions,
          captureLine: (l) => void midTurnCapture.captureLine(l, turnIndexForCapture),
          enqueue: (t) => args.externalPromptQueue.push(t),
          maxInputBytes: INBOUND_MAX_BYTES,
          now: () => Date.now(),
        })
      },
      ...(lane !== undefined ? { onPartial: lane.render } : {}),
    })
    // The in-turn reader now owns stdin ⇒ a mid-turn approval must read via the
    // captured line, not a conflicting readline.
    args.midTurnApprovalChannel.active = true
    try {
      return await run()
    } finally {
      args.midTurnApprovalChannel.active = false
      // WS-A (jul-10, UUX-1-22) — TYPED release: an unanswered approval at turn
      // teardown resolves as `released(turn_teardown)`, which the prompt maps to
      // a fail-closed deny WITH attribution (never a silent fake empty line).
      args.midTurnApprovalChannel.clear("turn_teardown")
      reader.dispose()
      lane?.teardown() // R3 — only if entered; uses rows captured at enter.
    }
  }
}

/** Default Esc-Esc cancel window (ms). Matches the prior inline constant in
 *  `runRepl.installTurnCancel`. Held as a module constant so the runner +
 *  the wrapTurn share ONE value (the prior code duplicated `ESC_WINDOW_MS`
 *  across both call sites). */
export const ESC_WINDOW_MS = 2000

/** L5 M-11 — register THIS session's search-wire teardown on the close stack
 *  when the host threaded one in (per-session, not the module singleton). Kept
 *  as a free function so the branch lives OUTSIDE `runSessionLoop` (its
 *  cognitive complexity is already at the biome cap). No-op when absent ⇒
 *  default-OFF byte-identical (kill-switch / lexical-only path; no wire built). */
export const registerSearchPipelineDispose = (
  closeStack: Array<{ label: string; dispose: () => void | Promise<void> }>,
  dispose: (() => void) | undefined,
): void => {
  if (dispose === undefined) return
  closeStack.push({ label: "searchPipeline.dispose", dispose: () => dispose() })
}

/** RFC-09 (A) — register the completion-notify title restore on the close stack
 *  (LIFO; runs even on abnormal shutdown). Free function so the branch stays
 *  OUT of `runSessionLoop`'s complexity budget. No-op when the port was never
 *  built ⇒ default-OFF byte-identical. */
export const registerNotifyDispose = (
  closeStack: Array<{ label: string; dispose: () => void | Promise<void> }>,
  notify: import("../../notify").NotificationPort | undefined,
): void => {
  if (notify === undefined) return
  closeStack.push({ label: "notify.dispose", dispose: () => notify.dispose() })
}

/** RFC-09 (A) — fire the turn-completion notify from a finished {@link runOneTurn}
 *  result. Reuses the runner-measured `durationMs` (no new timing source); the
 *  adapter's slow-turn gate decides whether to emit. Shared by the one-shot and
 *  interactive branches. No-op when `notify` is absent ⇒ byte-identical. Free
 *  function so the call stays out of `runSessionLoop`'s complexity budget. */
export const notifyTurnComplete = (
  notify: import("../../notify").NotificationPort | undefined,
  out: { readonly durationMs: number; readonly result: unknown; readonly turnAborted: boolean },
  cwdBasename: string,
): void => {
  notify?.onTurnComplete({
    durationMs: out.durationMs,
    ok: out.result !== undefined && !out.turnAborted,
    cwdBasename,
  })
}

/** RFC-09 — build the optional prompt-pipeline deps (A idle notify + B warning
 *  preamble) as an `exactOptionalPropertyTypes`-safe partial. Each field is
 *  omitted (not `undefined`) when absent so the pipeline stays byte-identical.
 *  Free function so the 3 presence ternaries live OUT of `runSessionLoop`'s
 *  complexity budget. */
export const buildPromptPipelineNotifyDeps = (args: {
  readonly notify: import("../../notify").NotificationPort | undefined
  readonly notifyCwdBasename: string | undefined
  readonly contextWarning: (() => string) | undefined
}): {
  notify?: import("../../notify").NotificationPort
  notifyCwdBasename?: string
  contextWarning?: () => string
} => ({
  ...(args.notify !== undefined ? { notify: args.notify } : {}),
  ...(args.notifyCwdBasename !== undefined ? { notifyCwdBasename: args.notifyCwdBasename } : {}),
  ...(args.contextWarning !== undefined ? { contextWarning: args.contextWarning } : {}),
})

/** Ticket 18 (V1) — WEAVE GUARD. Decide whether the interactive turn should wire
 *  the Ctrl+B `onMovedToBackground` sink. Pure predicate (no I/O) so it is unit-
 *  testable in isolation.
 *
 *  Ctrl+B detaches the running turn — the body keeps streaming, and the loop
 *  returns to a fresh prompt. That is INCOMPATIBLE with WEAVE mode, where a
 *  mid-turn line is blended into the CURRENT turn (backgrounding would orphan the
 *  live blend), and with an in-flight INTERRUPT (the surface is mid-resume of a
 *  partial turn). So Ctrl+B is wired ONLY when:
 *    - a portal exists (`QUANTA_BG_TURN`),
 *    - the inbound mode is NOT `weave`, AND
 *    - the conversation-action surface is absent OR idle (no interrupted turn).
 *  Any other case ⇒ Ctrl+B is a silent no-op: `onBackground` is never passed to
 *  the cancel FSM, so the keypress falls through unhandled (no detach, no status
 *  line) — the turn keeps running exactly as if the key were unbound. */
export const shouldWireBackground = (args: {
  readonly portal: import("../background-turn-portal").BackgroundTurnPortal | undefined
  readonly inboundMode: { current: InboundMode } | undefined
  readonly conversationActions: ConversationActionSurface | undefined
}): boolean => {
  if (args.portal === undefined) return false
  if (args.inboundMode?.current === "weave") return false
  const ca = args.conversationActions
  if (ca !== undefined && ca.activeTurnRef.current.isInterrupted) return false
  return true
}

/** Ticket 18 (V1) — derive a short, single-line portal label from the prompt
 *  head. Collapses whitespace + truncates so the `/background list` table stays
 *  scannable (the full prompt is never the label). NO-THROW on empty input. */
const BG_LABEL_MAX = 48
export const backgroundTurnLabel = (text: string): string => {
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length === 0) return "(empty prompt)"
  return oneLine.length > BG_LABEL_MAX ? `${sliceWholeChars(oneLine, BG_LABEL_MAX - 1)}…` : oneLine
}

export const drainTurnImages = (
  surfaceState: SessionState,
  promptImages: readonly import("@/llm").ImageBlock[],
): { readonly nextState: SessionState; readonly images: readonly import("@/llm").ImageBlock[] } => {
  const seedImages = surfaceState.pendingImages
  const nextState = updateSessionState(surfaceState, { pendingImages: [] })
  return {
    nextState,
    images: [...seedImages, ...promptImages],
  }
}
