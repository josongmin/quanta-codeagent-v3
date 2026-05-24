/** ADR-0126 / ADR-0137 — compose Anthropic-API tool_result `content` from a
 *  ToolResult.
 *
 *  Returns one of TWO shapes:
 *    - When `result.images` AND `result.documents` are absent or both empty →
 *      the LEGACY string (byte-identical to today's tool_result content).
 *      dispatch.ts wired today expects a string; that path stays unchanged.
 *    - When either is present and non-empty → an ARRAY of ContentBlock-like
 *      records `[{type:"text",text:output}, ...images, ...documents]` that
 *      callers turn into the API-shaped tool_result content. Images come
 *      BEFORE documents — the order is stable so adapter wire output is
 *      deterministic across re-runs.
 *
 *  Plane-clean: imports only `@/llm`, `../types`. The helper is pure and has
 *  no side effects; the dispatch seam wires it at the model-message boundary
 *  in a follow-up PR (the deferred-caller-wire idiom from ADR-0125).
 *
 *  Empty-array semantics: `images: []` / `documents: []` is treated as ABSENT.
 *  Tools that opt into a field but happen to produce zero attachments on a
 *  given call MUST omit the field rather than emit an empty array — but the
 *  composer is defensive about it so a misbehaving custom tool can't silently
 *  downgrade every byte-identical caller to the array shape.
 *
 *  Why one composer (not two): ADR-0137 §"Alternatives rejected" picks Option
 *  A (extend the existing composer) over Option B (separate document
 *  composer + extra dispatch wiring). The composed array shape is the same on
 *  the wire; the additional dispatch.ts changes a second composer would need
 *  are sibling-touched territory this slice MUST NOT modify.
 */

import type { DocumentBlock, ImageBlock } from "@/llm"
import type { ToolResult } from "../types"

export type ToolResultContent =
  | string
  | ReadonlyArray<{ type: "text"; text: string } | ImageBlock | DocumentBlock>

export const composeToolResultContent = (result: ToolResult): ToolResultContent => {
  const hasImages = result.images !== undefined && result.images.length > 0
  const hasDocuments = result.documents !== undefined && result.documents.length > 0
  if (!hasImages && !hasDocuments) {
    return result.output
  }
  const out: Array<{ type: "text"; text: string } | ImageBlock | DocumentBlock> = [
    { type: "text", text: result.output },
  ]
  if (hasImages && result.images !== undefined) {
    for (const img of result.images) out.push(img)
  }
  if (hasDocuments && result.documents !== undefined) {
    for (const doc of result.documents) out.push(doc)
  }
  return out
}
