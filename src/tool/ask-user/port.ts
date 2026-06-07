/** Closed-port for `ask_user` — generalized structured elicitation (ADR-0494).
 *
 *  Generalizes the binary host `onConfirm` (allow/deny) into a STRUCTURED
 *  question the agent — or an MCP server, via the host bridge — can put to the
 *  user mid-task. The vocabulary mirrors the MCP `elicitation/*` request kinds
 *  (`@/mcp/elicitation`) so a host can adapt ONE prompter to both surfaces, but
 *  this port stays plane-clean (no `@/mcp` import) so `@/tool` keeps its leaf
 *  fence (advisor-rule: `../types` + `zod` + `@/shared` only).
 *
 *  NO-THROW contract: every outcome is a closed result arm. A host that cannot
 *  prompt (headless / no TTY / absent callback) returns `{ ok:false,
 *  reason:"headless-denied" }` — the agent never blocks waiting on a human that
 *  is not there. */

/** A structured question. Discriminated on `kind`. */
export type AskUserRequest =
  | {
      readonly kind: "string"
      readonly prompt: string
      readonly title?: string
      readonly minLength?: number
      readonly maxLength?: number
      readonly pattern?: string
    }
  | { readonly kind: "boolean"; readonly prompt: string; readonly title?: string }
  | {
      readonly kind: "number"
      readonly prompt: string
      readonly title?: string
      readonly min?: number
      readonly max?: number
    }
  | {
      readonly kind: "integer"
      readonly prompt: string
      readonly title?: string
      readonly min?: number
      readonly max?: number
    }
  | {
      readonly kind: "select"
      readonly prompt: string
      readonly title?: string
      readonly options: readonly string[]
    }
  | {
      readonly kind: "multiselect"
      readonly prompt: string
      readonly title?: string
      readonly options: readonly string[]
      readonly minSelected?: number
      readonly maxSelected?: number
    }

/** The typed value a successful answer carries, by request kind. */
export type AskUserValue = string | boolean | number | readonly string[]

/** Closed failure space — mirrors {@link ElicitationFailureReason}. */
export type AskUserFailureReason =
  | "headless-denied"
  | "cancelled"
  | "validation-error"
  | "empty-options"
  | "invalid-input"

export type AskUserResult =
  | { readonly ok: true; readonly value: AskUserValue }
  | { readonly ok: false; readonly reason: AskUserFailureReason }

/** The host-supplied prompter. Default-OFF: when the host wires no port the
 *  `ask_user` tool is not registered at all (byte-identical). NO-THROW. */
export interface AskUserPort {
  ask(req: AskUserRequest, signal?: AbortSignal): Promise<AskUserResult>
}
