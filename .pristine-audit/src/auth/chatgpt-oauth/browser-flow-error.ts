/** Typed error from the OAuth browser flow + its callback providers.
 *
 *  Pulled into its own file so the default callback provider (CLI loopback)
 *  can throw the same error class without a circular import between
 *  `browser-flow.ts` ↔ `cli-callback.ts`. Re-exported from
 *  `browser-flow.ts` so existing `import { BrowserFlowError } from "@/auth/chatgpt-oauth"`
 *  consumers remain byte-identical.
 */

export type BrowserFlowErrorReason =
  | "ports_in_use"
  | "timeout"
  | "state_mismatch"
  | "user_cancel"
  | "open_failed"

export class BrowserFlowError extends Error {
  readonly reason: BrowserFlowErrorReason
  constructor(reason: BrowserFlowErrorReason, message: string) {
    super(message)
    this.name = "BrowserFlowError"
    this.reason = reason
  }
}
