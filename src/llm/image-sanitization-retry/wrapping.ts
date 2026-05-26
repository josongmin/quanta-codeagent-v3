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
 * Our `continue` is "re-iterate `inner.stream(input)` exactly once". We do
 * NOT re-issue with a different StreamInput — the inner adapter reads
 * messages from the WorkingMemory snapshot the loop already passed in. The
 * port mutates the shared `WorkingMemory<Message>` so the SAME `input.messages`
 * reference, when re-snapshotted by the inner adapter on next call, would
 * see the sanitized buffer. HOWEVER our inner adapters read `input.messages`
 * by-reference at call time and do NOT re-snapshot the WorkingMemory mid-call,
 * so this wrap is correct ONLY when the AgentConfig wires `port` as a
 * `createWorkingMemoryHistorySanitization(wm)` bound to the SAME `wm` that
 * the agent loop assembles `input.messages` from BEFORE each stream call.
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
import type { StreamEvent, StreamInput } from "../types"
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
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      // Attempt loop. `attempt === 0` is the original call; subsequent
      // iterations are post-sanitize retries. Recovery decision is delegated
      // to `decideRecovery` to keep this generator's cognitive complexity
      // under the biome cap — every retry branch is one line here.
      const sanitize = (): { readonly wasMutated: boolean } => safeSanitize(port, placeholder)
      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        let yielded = false
        try {
          for await (const ev of inner.stream(input)) {
            yielded = true
            yield ev
          }
          return
        } catch (e) {
          if (decideRecovery(e, yielded, attempt, maxAttempts, sanitize) === "throw") {
            throw e
          }
          // wasMutated ⇒ fall through, re-stream the inner.
        }
      }
      // Structurally unreachable (decideRecovery either returns "retry"
      // forever or the loop returned/threw). Defense-in-depth: do not
      // silently succeed with zero events.
    },
  }
}
