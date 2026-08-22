/** ADR-0197 — closed-port for MCP elicitation/* RPCs.
 *
 *  Seven methods, one per rmcp 0.15 schema. Titled vs Untitled is conveyed
 *  via the request's optional `title` field — not method-doubled. Every
 *  result is a closed 6-arm union: `ok:true { value }` carries the answer;
 *  `ok:false { reason: "headless-denied" | "validation-error" | "cancelled"
 *  | "empty-enum" | "invalid-input" }` covers the typed failure space.
 *  No throws. */

import type {
  BooleanRequest,
  EnumRequest,
  IntegerRequest,
  MultiSelectEnumRequest,
  NumberRequest,
  SingleSelectEnumRequest,
  StringRequest,
  UrlRequest,
} from "./schemas"

export type ElicitationFailureReason =
  | "headless-denied"
  | "validation-error"
  | "cancelled"
  | "empty-enum"
  | "invalid-input"

export type ElicitationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ElicitationFailureReason }

export interface ElicitationPrompter {
  promptString(req: StringRequest, signal?: AbortSignal): Promise<ElicitationResult<string>>
  promptNumber(req: NumberRequest, signal?: AbortSignal): Promise<ElicitationResult<number>>
  promptInteger(req: IntegerRequest, signal?: AbortSignal): Promise<ElicitationResult<number>>
  promptBoolean(req: BooleanRequest, signal?: AbortSignal): Promise<ElicitationResult<boolean>>
  promptEnum(req: EnumRequest, signal?: AbortSignal): Promise<ElicitationResult<string>>
  promptMultiEnum(
    req: MultiSelectEnumRequest,
    signal?: AbortSignal,
  ): Promise<ElicitationResult<ReadonlyArray<string>>>
  promptSingleEnum(
    req: SingleSelectEnumRequest,
    signal?: AbortSignal,
  ): Promise<ElicitationResult<string>>
  /** TICKET-22 — the URL variant: render `req.url`, confirm, and (on yes) open
   *  it in the user's browser. The resolved `value` is the opened url, keeping
   *  the `{action:'accept', content:{value}}` envelope symmetric with the other
   *  six string-valued prompts. */
  promptUrl(req: UrlRequest, signal?: AbortSignal): Promise<ElicitationResult<string>>
}
