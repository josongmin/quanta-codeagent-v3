/**
 * Mandatory outbound PR-comment body policy: redact, then UTF-8 cap.
 *
 * Automation additionally stamps a hidden idempotency marker that is reserved
 * inside the byte budget. HITL one-off comments use the same redact/cap
 * contract without the marker (create-new semantics).
 */

import { errMessage } from "@/shared"

import { asIdempotencyKey, type IdempotencyKey } from "./types"

export const COMMENT_BODY_MAX_BYTES = 65_000
export const IDEMPOTENCY_MARKER_PREFIX = "<!-- quanta:idempotency="
export const IDEMPOTENCY_MARKER_SUFFIX = " -->"

export type OutboundBodyPrepareResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly error: string }

export interface OutboundBodyPolicyPort {
  prepare(body: string): OutboundBodyPrepareResult
}

export interface AutomatedPrCommentPort {
  post(input: {
    readonly body: string
    readonly key: IdempotencyKey
  }): Promise<{ readonly ok: boolean; readonly url?: string; readonly error?: string }>
}

export interface OutboundBodyPolicyOpts {
  readonly redact: (text: string) => string
  readonly maxBytes?: number
  readonly marker?: string
}

const ELLIPSIS_BYTES = 3

export const utf8Truncate = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  const trimBudget = Math.max(0, maxBytes - ELLIPSIS_BYTES)
  return `${buf.subarray(0, trimBudget).toString("utf8")}…`
}

export const clampWithMarker = (body: string, marker: string, maxBytes: number): string => {
  const markerBuf = Buffer.from(`\n${marker}`, "utf8")
  if (markerBuf.length >= maxBytes) return marker
  const bodyBudget = maxBytes - markerBuf.length
  const bodyBuf = Buffer.from(body, "utf8")
  if (bodyBuf.length <= bodyBudget) return `${body}\n${marker}`
  const trimBudget = Math.max(0, bodyBudget - ELLIPSIS_BYTES)
  const trimmed = bodyBuf.subarray(0, trimBudget).toString("utf8")
  return `${trimmed}…\n${marker}`
}

export const createOutboundBodyPolicy = (opts: OutboundBodyPolicyOpts): OutboundBodyPolicyPort => ({
  prepare(body: string): OutboundBodyPrepareResult {
    if (typeof opts.redact !== "function") {
      return { ok: false, error: "outbound body policy: redact is required" }
    }
    try {
      const redacted = opts.redact(body)
      const cap = Math.max(256, opts.maxBytes ?? COMMENT_BODY_MAX_BYTES)
      const marker = opts.marker
      const prepared =
        marker === undefined ? utf8Truncate(redacted, cap) : clampWithMarker(redacted, marker, cap)
      return { ok: true, body: prepared }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  },
})

export const automatedPrCommentKey = (parts: {
  readonly repo: string
  readonly pr: number
  readonly runId: string
  readonly kind: string
}): IdempotencyKey => {
  const runId = parts.runId.trim()
  if (runId === "") {
    throw new Error("automatedPrCommentKey: runId is required")
  }
  return asIdempotencyKey(`${parts.repo}#${parts.pr}#${runId}#${parts.kind}`)
}

export const idempotencyMarker = (key: IdempotencyKey): string =>
  `${IDEMPOTENCY_MARKER_PREFIX}${key}${IDEMPOTENCY_MARKER_SUFFIX}`
