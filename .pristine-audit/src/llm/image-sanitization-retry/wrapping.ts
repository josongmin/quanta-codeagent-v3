/**
 * ADR-0328 — `withImageSanitizationRetry` adapter wrap.
 *
 * Sibling-pattern decorator to `withFailureCounter` (ADR-0237) and
 * `withSandboxLlmErrorEmit` (ADR-0237): consumes an inner {@link LLMPort}
 * and a {@link HistorySanitizationPort} (ADR-0323) and produces a new
 * `LLMPort` that, on an `LLMError("invalid_image", ...)` THROWN by the
 * inner stream BEFORE any event was yielded, calls
 * `port.replaceLastTurnImages("invalid_image", placeholder)` and re-streams.
 *
 * # Codex parity (`codex-rs/core/src/session/turn.rs:363-381`)
 *
 *     Err(CodexErr::InvalidImageRequest()) => {
 *         if state.history.replace_last_turn_images("Invalid image") {
 *             continue;
 *         }
 *         // ... else: surface Error + break
 *     }
 *
 * Our `continue` re-iterates `inner.stream(freshInput)` exactly once, where
 * `freshInput` carries the wm's POST-sanitize messages — see "wm-live retry"
 * below for the rationale.
 *
 * # wm-live retry (ADR-0337) — closes ADR-0328/0333 stale-input limitation
 *
 * Pre-ADR-0337: the decorator re-passed the SAME `input` reference, including
 * the SAME `input.messages` array that was snapshotted by the loop BEFORE the
 * pre-sanitize stream attempt. The wm mutation done by
 * `port.replaceLastTurnImages` was therefore INVISIBLE to the inner adapter
 * on retry: it re-serialized the stale poisoned buffer and the provider
 * re-rejected with the same 400.
 *
 * Post-ADR-0337: between the sanitize call and the retry stream, we ask the
 * port for `snapshotMessages()` — a wm-live re-snapshot of the buffer the
 * sanitize just mutated — and build a fresh `StreamInput` whose `messages`
 * field points at the sanitized snapshot. All other knobs (`tools`, `system`,
 * `toolChoice`, `thinking`, `signal`, `turnTimingCapture`, `onChunk`) are
 * preserved by spread, so byte-identical wire shape EXCEPT for the now-clean
 * message tail. Codex parity is finally honest: `state.history.replace_last_turn_images`
 * is observed by the next sample because the next sample reads from the SAME
 * `state.history`.
 *
 * # NO-THROW fallback on snapshotMessages
 *
 * `HistorySanitizationPort.snapshotMessages` is contractually no-throw and
 * MUST return a `readonly` view of the current wm buffer (default adapter
 * delegates to `wm.snapshot()`). Defense-in-depth: if a hostile adapter
 * throws or returns an empty array (degenerate / malformed), the retry FALLS
 * BACK to the caller's `input.messages`. This keeps the wrap correct for
 * legacy `HistorySanitizationPort` mocks (the wrap's pre-ADR-0337 hellgate
 * cases continue to pass byte-identical events through the retry).
 *
 * # Mid-stream throws DO NOT participate
 *
 * If the inner stream yielded ≥1 event before throwing, we re-throw without
 * sanitizing. Mid-stream throws are transcript-corruption rethrows, not
 * "request rejected at the boundary" — by the time the model is mid-stream,
 * the provider already accepted the image. Same semantic as
 * `withFailureCounter`.
 *
 * # NO-THROW from the port
 *
 * `HistorySanitizationPort` is contractually no-throw (ADR-0323), but we add
 * a belt-and-suspenders try/catch around `replaceLastTurnImages` anyway:
 * a buggy adapter returning `{wasMutated: false}` is OBSERVATIONALLY identical
 * to a thrown port-side error from this wrap's POV (no sanitize ⇒ no retry ⇒
 * propagate original).
 *
 * # Sanitize result `wasMutated:false` ⇒ propagate original
 *
 * Codex parity: when `replace_last_turn_images` returns `false` (nothing to
 * scrub), Codex EMITS the Error event and BREAKS rather than retry. Our
 * mirror: propagate the original `invalid_image` LLMError untouched. Retry
 * would re-fail identically — the history is poisoned in a way the
 * sanitizer cannot reach.
 *
 * # Default-OFF posture
 *
 * `maxAttempts === 0` ⇒ identity wrap, sanitize never fires. Both
 * `withFailureCounter` (sets identity at `enabled !== true`) and
 * `withSandboxLlmErrorEmit` (returns inner verbatim) use the same posture.
 * We are slightly different: the wrap ALWAYS allocates a new port object
 * (so the call site can opt-out by `maxAttempts: 0` AT WIRE TIME), but the
 * hot path on a successful (non-throwing) inner stream is a single
 * `for-await-yield` loop — same shape as the identity.
 */

import type { HistorySanitizationPort } from "@/memory/history-sanitization"
import { LLMError } from "@/shared"
import type { LLMPort } from "../ports"
import type { Message, StreamEvent, StreamInput } from "../types"
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PLACEHOLDER,
  type ImageSanitizationRetryOptions,
} from "./types"

/** Clamp `maxAttempts` to `[0, MAX]`. `undefined` / `NaN` / `Infinity` →
 *  {@link DEFAULT_MAX_ATTEMPTS}. Hellgate-pinned. */
const MAX_ALLOWED_ATTEMPTS = 5

const clampMaxAttempts = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_MAX_ATTEMPTS
  if (!Number.isFinite(raw)) return DEFAULT_MAX_ATTEMPTS
  const n = Math.floor(raw)
  if (n < 0) return 0
  if (n > MAX_ALLOWED_ATTEMPTS) return MAX_ALLOWED_ATTEMPTS
  return n
}

/** True iff `e` is an `LLMError` with `.kind === "invalid_image"`. The
 *  classifier at `LLMError.fromSdkError` is the boundary that stamps this
 *  kind; this wrap consumes the discriminator without ever re-parsing
 *  `.message` (the documented errors.ts contract). */
const isInvalidImage = (e: unknown): e is LLMError => {
  return e instanceof LLMError && e.kind === "invalid_image"
}

/** No-throw shim around the port. Catches anything the port might throw
 *  (the ADR-0323 contract says it never will, but the wrap is the load-
 *  bearing recovery seam — a port bug must NOT crash the live agent loop).
 *  Returns the result on success; on throw returns
 *  `{replacedCount:0, wasMutated:false}` so the caller propagates the
 *  original error. */
const safeSanitize = (
  port: HistorySanitizationPort,
  placeholder: string,
): { readonly replacedCount: number; readonly wasMutated: boolean } => {
  try {
    return port.replaceLastTurnImages("invalid_image", placeholder)
  } catch {
    return { replacedCount: 0, wasMutated: false }
  }
}

/** ADR-0337 — build a fresh {@link StreamInput} for the retry attempt whose
 *  `messages` field is the POST-sanitize wm snapshot.
 *
 *  Calls `port.snapshotMessages()` defensively (NO-THROW: any thrown value or
 *  empty / non-array return collapses to "fall back to the original input").
 *  When the wm-live snapshot is usable, we spread the original `input` and
 *  overwrite ONLY `messages` — every other StreamInput knob (`tools`,
 *  `system`, `toolChoice`, `thinking`, `signal`, `turnTimingCapture`,
 *  `onChunk`) is preserved verbatim.
 *
 *  The structural cast from `readonly SanitizationMessageLike[]` to
 *  `Message[]` is sound at the wire boundary: the default adapter
 *  `createWorkingMemoryHistorySanitization(wm)` is bound to a
 *  `WorkingMemory<Message>` (`src/agent/loop.ts:2171`), so the snapshot
 *  elements ARE `Message`s. The port surface is intentionally structural so
 *  the `@/memory` slice does not import `@/llm`. We slice() to defeat the
 *  `readonly` view — `StreamInput.messages` is declared mutable. */
const buildWmLiveInput = (port: HistorySanitizationPort, input: StreamInput): StreamInput => {
  let fresh: readonly unknown[]
  try {
    fresh = port.snapshotMessages()
  } catch {
    return input
  }
  if (!Array.isArray(fresh) || fresh.length === 0) return input
  // Defensive copy: `StreamInput.messages` is mutable per its type; some
  // inner adapters may push tool-result fragments. The slice() severs the
  // readonly view from the wm buffer.
  return { ...input, messages: (fresh as readonly Message[]).slice() }
}

/** Decide whether the current pre-stream throw is recoverable. Pulled out of
 *  the generator body to keep the stream() complexity under the biome cap.
 *
 *  Inputs:
 *    - `e`             the thrown value
 *    - `yielded`       did the inner stream yield ≥1 event before throwing
 *    - `attempt`       current attempt index (0 = original call)
 *    - `maxAttempts`   total sanitize-retry budget (already clamped ≥1 here)
 *    - `sanitize()`    no-throw fn returning `{wasMutated}` of the cleanup
 *
 *  Output: `"retry"` ⇒ caller continues the for-loop. Anything else means
 *          the caller MUST rethrow `e` (the decision is final). The two
 *          rethrow variants are folded into `"throw"` because the wrap NEVER
 *          replaces the original error — Codex parity is verbatim
 *          propagation. */
const decideRecovery = (
  e: unknown,
  yielded: boolean,
  attempt: number,
  maxAttempts: number,
  sanitize: () => { readonly wasMutated: boolean },
): "retry" | "throw" => {
  // Mid-stream throw: NEVER sanitize (provider already accepted the image).
  if (yielded) return "throw"
  // Non-invalid_image kind: propagate verbatim.
  if (!isInvalidImage(e)) return "throw"
  // Out of budget: propagate the LAST invalid_image error.
  if (attempt >= maxAttempts) return "throw"
  // Attempt sanitize. wasMutated:false ⇒ Codex `break` parity.
  if (!sanitize().wasMutated) return "throw"
  return "retry"
}

/**
 * Decorate `inner` so an `LLMError("invalid_image", ...)` thrown BEFORE any
 * event is yielded triggers a sanitize-and-retry pass. Closed-port factory.
 *
 * @param inner The adapter to wrap. Returned verbatim when
 *              `maxAttempts === 0` — no allocation in the byte-identical
 *              opt-out path.
 * @param port  ADR-0323 history sanitization port. The factory
 *              `createWorkingMemoryHistorySanitization(wm)` returns an
 *              adapter bound to the live agent-loop WorkingMemory.
 * @param opts  See {@link ImageSanitizationRetryOptions}. Defaults: `maxAttempts:1`
 *              (Codex parity), `placeholder:"[invalid image removed]"`.
 */
export const withImageSanitizationRetry = (
  inner: LLMPort,
  port: HistorySanitizationPort,
  opts?: ImageSanitizationRetryOptions,
): LLMPort => {
  const maxAttempts = clampMaxAttempts(opts?.maxAttempts)
  const placeholder = opts?.placeholder ?? DEFAULT_PLACEHOLDER

  // Opt-out: maxAttempts === 0 ⇒ identity wrap. Return inner verbatim so
  // a caller that wired the wrap "off" pays no allocation and no observable
  // bytes change. Mirrors `withFailureCounter`'s identity posture.
  if (maxAttempts === 0) {
    return inner
  }

  return {
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.surfaceId !== undefined ? { surfaceId: inner.surfaceId } : {}),
    ...(inner.transportId !== undefined ? { transportId: inner.transportId } : {}),
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      // Attempt loop. `attempt === 0` is the original call; subsequent
      // iterations are post-sanitize retries. Recovery decision is delegated
      // to `decideRecovery` to keep this generator's cognitive complexity
      // under the biome cap — every retry branch is one line here.
      //
      // ADR-0337: `currentInput` is rebound to a wm-live snapshot AFTER a
      // successful sanitize call, so the retry sees the cleaned messages.
      // The first attempt always uses the caller's `input` verbatim
      // (byte-identical to the pre-ADR happy path).
      const sanitize = (): { readonly wasMutated: boolean } => safeSanitize(port, placeholder)
      let currentInput = input
      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        let yielded = false
        try {
          for await (const ev of inner.stream(currentInput)) {
            yielded = true
            yield ev
          }
          return
        } catch (e) {
          if (decideRecovery(e, yielded, attempt, maxAttempts, sanitize) === "throw") {
            throw e
          }
          // wasMutated ⇒ fall through, re-stream the inner with the
          // POST-sanitize wm snapshot. Falls back to the prior `currentInput`
          // if the port can't deliver a usable snapshot (NO-THROW invariant).
          currentInput = buildWmLiveInput(port, currentInput)
        }
      }
      // Structurally unreachable (decideRecovery either returns "retry"
      // forever or the loop returned/threw). Defense-in-depth: do not
      // silently succeed with zero events.
    },
  }
}
