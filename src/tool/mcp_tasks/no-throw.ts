/** NO-THROW boundary (Tool contract §2) for the MCP-tasks tools.
 *
 * The `TasksHandle` port is duck-typed and adapted from `@/mcp` at the
 * composition root; a misbehaving / rejecting adapter MUST NOT reject the
 * tool's async iterator (that hangs/corrupts the dispatch loop — see
 * `tests/unit/tool-no-throw-contract-guard.test.ts`). Every `execute` routes
 * its port call through {@link callPort}, which maps ANY rejection to a typed
 * `ok:false` the tool renders as a single `error`-mode result. Mirrors the
 * same discipline as `mcp_resources/render.ts#callPort`. */

import { errMessage } from "@/shared"
import type { ToolEvent } from "../types"

export type PortCall<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/** Run a port thunk, collapsing a throw/rejection into a typed `ok:false`. */
export const callPort = async <T>(produce: () => Promise<T>): Promise<PortCall<T>> => {
  try {
    return { ok: true, value: await produce() }
  } catch (e) {
    return { ok: false, message: errMessage(e) }
  }
}

/** The single terminal `error`-mode result a tool yields when a port call
 *  throws/rejects (NO-THROW contract §2 — never let it escape the iterator). */
export const backendErrorEvent = (message: string): ToolEvent => ({
  type: "result",
  result: {
    ok: false,
    output: `mcp-tasks backend-error: ${message}`,
    failure: { mode: "error", modelVisibleError: message },
  },
})
