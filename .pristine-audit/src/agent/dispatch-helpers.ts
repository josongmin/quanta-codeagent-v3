/**
 * Shared dispatch helpers used by `dispatch.ts` (execute path + result
 * shaping) and `admissibility-gate.ts` (gate short-circuit results). Extracted
 * so both files can build `DispatchResult` values without a circular import —
 * `dispatch.ts` consumes the gate, the gate consumes only types + these
 * helpers.
 *
 * Why this lives next to the seam (not in `@/shared`):
 *  - `resultBlock`/`deny` shape `ToolResultBlock` for the dispatch contract;
 *    no other slice constructs those.
 *  - `HANDOFF_SUFFIX` is the verbatim phrasing the HITL hand-off tier emits;
 *    keeping it next to the gate prevents drift if the wording is tuned.
 */

import type { ToolResultBlock } from "@/llm"
import { denyContentPrefix, type StructuredDenyReason } from "@/permission"
import { runtimeConfig } from "@/shared"
import type { DispatchResult } from "./dispatch-types"

/** Suffix appended to every HITL hand-off message. Phrased to make it clear
 *  to the model that no further attempt will help — only a human can resume. */
export const HANDOFF_SUFFIX = ". Agent cannot proceed without explicit human takeover."

/** True when a thrown error is the session-approval-required control signal
 *  (an object carrying an `{approval:{approvalId, reason, requestedAt}}` shape).
 *  This decides which errors RE-THROW past the dispatch no-throw contract, so
 *  it is duplicated-prone and security-relevant — kept here as the single
 *  source shared by the sync (`dispatch.ts`) and streaming (`streaming-dispatch.ts`)
 *  paths, which must never diverge. */
export const isSessionApprovalRequiredError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("approval" in error)) return false
  const approval = (error as { approval?: unknown }).approval
  return (
    typeof approval === "object" &&
    approval !== null &&
    "approvalId" in approval &&
    "reason" in approval &&
    "requestedAt" in approval
  )
}

/** Build a tool_result block. `isError:true` becomes `is_error:true` on the
 *  block; we omit the field on success so the wire shape stays minimal.
 *
 *  `contentBlocks` is the OPTIONAL ADR-0126 structured form. When absent, the
 *  result is byte-identical to the pre-feature shape. Only the dispatch seam's
 *  image-composer path threads it through (every tool result with no images
 *  passes `undefined`, so `exactOptionalPropertyTypes` keeps the field omitted
 *  rather than set to `undefined`). */
export const resultBlock = (
  id: string,
  content: string,
  isError: boolean,
  contentBlocks?: ToolResultBlock["contentBlocks"],
): ToolResultBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
  ...(contentBlocks !== undefined ? { contentBlocks } : {}),
})

/** Build a deny short-circuit result. `preview` is a stable string tag used by
 *  trajectory tests to classify the deny reason (`denied`/`declined`/`handoff`
 *  /`plan-blocked`/`hook-denied`/…) without parsing the user-facing content.
 *
 *  C6 (RFC jun-6-deny-reason-surfacing) — the OPTIONAL `denyReason` is the
 *  pre-sanitized {@link StructuredDenyReason} the admissibility-gate deny SITE
 *  hands down (its `safeReason` is the SAME already-scrubbed recorder one-liner;
 *  the HARD_DENY case uses the categorical `hardDenySafeReason()`, never the
 *  command-echoing prose). It is surfaced ONLY when BOTH:
 *    1. `denyReason` is present (the gate passed one), AND
 *    2. `runtimeConfig().surfaceDenyReason` (`QUANTA_DENY_REASON`) is ON.
 *  In that case the categorical `[denied · layer=… · pillar=…]` prefix
 *  (derived ONLY from `layer`/`pillar` — never `safeReason`/raw text) is
 *  PREPENDED to `content`, and the structured record is attached to the
 *  `ToolFailure.permission_denied` envelope so the model can branch on the
 *  deciding layer.
 *
 *  DEFAULT-OFF BYTE-IDENTITY (sacred): when `denyReason` is absent OR the knob
 *  is off, the returned value is the verbatim `{block, ok:false, preview}` —
 *  no prefix, NO `failure` key (exactOptionalPropertyTypes ⇒ never set to
 *  `undefined`), identical to every legacy caller. The knob is read lazily so
 *  the OFF path allocates nothing extra. */
export const deny = (
  id: string,
  content: string,
  preview: string,
  denyReason?: StructuredDenyReason,
): DispatchResult => {
  if (denyReason === undefined || !runtimeConfig().surfaceDenyReason) {
    return { block: resultBlock(id, content, true), ok: false, preview }
  }
  const prefixed = `${denyContentPrefix(denyReason)}${content}`
  return {
    block: resultBlock(id, prefixed, true),
    ok: false,
    preview,
    failure: { mode: "permission_denied", denyReason },
  }
}
