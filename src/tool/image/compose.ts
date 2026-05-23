/** ADR-0126 — compose Anthropic-API tool_result `content` from a ToolResult.
 *
 *  Returns one of TWO shapes:
 *    - When `result.images` is absent or empty → the LEGACY string
 *      (byte-identical to today's tool_result content). dispatch.ts wired
 *      today expects a string; that path stays unchanged.
 *    - When `result.images` is present and non-empty → an ARRAY of
 *      ContentBlock-like records `[{type:"text",text:output}, ...images]`
 *      that callers turn into the API-shaped tool_result content.
 *
 *  Plane-clean: imports only `@/llm`, `../types`. The helper is pure and has
 *  no side effects; the dispatch seam wires it at the model-message boundary
 *  in a follow-up PR (the deferred-caller-wire idiom from ADR-0125).
 *
 *  Empty-array semantics: `images: []` is treated as ABSENT. Tools that opt
 *  into the field but happen to produce zero images on a given call MUST omit
 *  the field rather than emit an empty array — but the composer is defensive
 *  about it so a misbehaving custom tool can't silently downgrade every
 *  byte-identical caller to the array shape.
 */

import type { ImageBlock } from "@/llm"
import type { ToolResult } from "../types"

export type ToolResultContent =
  | string
  | ReadonlyArray<{ type: "text"; text: string } | ImageBlock>

export const composeToolResultContent = (result: ToolResult): ToolResultContent => {
  if (result.images === undefined || result.images.length === 0) {
    return result.output
  }
  return [{ type: "text", text: result.output }, ...result.images]
}
