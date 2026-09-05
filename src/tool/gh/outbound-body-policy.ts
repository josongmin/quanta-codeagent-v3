/**
 * HITL `gh_pr_comment` outbound body contract.
 *
 * Structurally matches `@/integrations/github` `OutboundBodyPolicyPort` without
 * importing that slice — `@/tool` must not take a dependency on integrations.
 * Production default redacts via `@/security` then UTF-8 caps. Missing or
 * throwing prepare returns ok:false and the tool makes zero `gh` calls.
 */

import { redactSecrets } from "@/security/redaction"
import { errMessage } from "@/shared"

export const GH_COMMENT_BODY_MAX_BYTES = 65_000

export type OutboundBodyPrepareResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly error: string }

export interface OutboundBodyPolicyPort {
  prepare(body: string): OutboundBodyPrepareResult
}

const ELLIPSIS_BYTES = 3

const utf8Truncate = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  const trimBudget = Math.max(0, maxBytes - ELLIPSIS_BYTES)
  return `${buf.subarray(0, trimBudget).toString("utf8")}…`
}

export const createGhCommentBodyPolicy = (opts: {
  readonly redact: (text: string) => string
  readonly maxBytes?: number
}): OutboundBodyPolicyPort => ({
  prepare(body: string): OutboundBodyPrepareResult {
    if (typeof opts.redact !== "function") {
      return { ok: false, error: "gh comment body policy: redact is required" }
    }
    try {
      const redacted = opts.redact(body)
      const cap = Math.max(256, opts.maxBytes ?? GH_COMMENT_BODY_MAX_BYTES)
      return { ok: true, body: utf8Truncate(redacted, cap) }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  },
})

export const defaultGhCommentBodyPolicy: OutboundBodyPolicyPort = createGhCommentBodyPolicy({
  redact: (text) => redactSecrets(text, { origin: "tool_result" }).text,
})
