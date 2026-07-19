/**
 * Ticket 04 (jul-16 transport-unified SDK) — wire fidelity opt-in CORE.
 *
 * By default the session wire carries only a ~256-char PREVIEW of a tool's args
 * and result (see the host bridge `clampPreview`/`previewToolArgs`). A subscriber
 * that needs the model-visible payload verbatim — the same string the LLM saw,
 * already redaction-applied at the AgentEvent boundary (RFC §1.1) — must opt in.
 *
 * Two-layer opt-in (both default-OFF ⇒ byte-identical, RFC §0):
 *  1. PRODUCTION gate — {@link fullFidelityEnabled} (`QUANTA_SESSION_FULL_FIDELITY`).
 *     OFF ⇒ the host bridge never sets `argsFull`/`resultFull`, so the field is
 *     absent on the kernel event, and every downstream consumer (wire, in-proc,
 *     JSONL log, sqlite archive) is byte-identical.
 *  2. per-peer NEGOTIATION (S2) — even with production ON, the ipc bridge STRIPS
 *     the full fields for any wire peer that did not negotiate `requestedFidelity`
 *     (the server-side sole defense — the passthrough codec cannot protect an old
 *     client, RFC §1.2). In-process subscribers share the trust boundary and keep
 *     the full payload.
 *
 * This module owns ONLY the gate + the size cap, neither of which depends on a
 * slice (mirrors `@/shared/item-stream`).
 */
import { gateOn } from "./env-flag"

export const FULL_FIDELITY_FLAG = "QUANTA_SESSION_FULL_FIDELITY"

/** Default-OFF opt-in check via the `@/shared` gate SSOT. */
export const fullFidelityEnabled = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, FULL_FIDELITY_FLAG)

/**
 * Per-field character cap for a full-fidelity payload. DERIVED, not a novel
 * threshold (RFC §7): the shared transports wedge-guard tears a socket down once
 * a single frame exceeds `MAX_FRAME_CHARS = 32 MiB` (see
 * `ipc/session/transports/stdio.ts`). JSON string escaping can expand a payload
 * up to ~6x worst case, and a frame carries envelope + BOTH args and result — so
 * a single full field is capped at `32 MiB / 8 = 4 MiB` to keep the encoded
 * frame comfortably under the wedge guard even in the escape-heavy worst case. A
 * field beyond this is DROPPED (not truncated to a lie) and the event is stamped
 * `fidelityDegraded: true` so a consumer knows the wire could not carry the whole
 * payload (it must fall back to the preview / an out-of-band `fullLogPath`).
 */
export const FULL_FIDELITY_MAX_CHARS = (32 * 1024 * 1024) / 8

export interface FullFidelityField {
  /** The carried full payload — present only when within the cap. */
  readonly value?: string
  /** `true` when the payload exceeded {@link FULL_FIDELITY_MAX_CHARS} and was
   *  dropped rather than truncated. */
  readonly degraded: boolean
}

/**
 * Cap-check a full-fidelity payload. Over the cap ⇒ `{ degraded: true }` with NO
 * value (the honest "we could not carry it" signal, never a silent truncation).
 */
export const capFullFidelityField = (payload: string): FullFidelityField =>
  payload.length > FULL_FIDELITY_MAX_CHARS
    ? { degraded: true }
    : { value: payload, degraded: false }
