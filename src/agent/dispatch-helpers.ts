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
import type { DispatchResult } from "./dispatch-types"

/** Suffix appended to every HITL hand-off message. Phrased to make it clear
 *  to the model that no further attempt will help — only a human can resume. */
export const HANDOFF_SUFFIX = ". Agent cannot proceed without explicit human takeover."

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
 *  /`plan-blocked`/`hook-denied`/…) without parsing the user-facing content. */
export const deny = (id: string, content: string, preview: string): DispatchResult => ({
  block: resultBlock(id, content, true),
  ok: false,
  preview,
})
