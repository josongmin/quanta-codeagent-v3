/** `fork_session` — ADR-0201 first-class agent tool wrapping `SessionForker.fork`.
 *
 *  Mints a NEW session id branched from an existing conversation checkpoint
 *  (recorded under `checkpointId` via `ConversationCheckpointStore`). The
 *  parent session is unaffected — fork is the missing half of the standard
 *  rewind+fork pair (Claude / Cursor parity). Output is read-only with
 *  respect to the workspace (no FS writes), so it routes through the loop
 *  as a `none` HITL tier.
 *
 *  Output contract: NEVER throws past the loop. Every `ForkError` is mapped
 *  to an `ok:false` ToolResult whose `output` BEGINS with the typed code
 *  (e.g. `"checkpoint-not-found: …"`) so future surfaces can branch on the
 *  code without parsing prose. Unknown throws bubble (programmer-bug
 *  convention).
 *
 *  Plane-clean: imports only `zod` + `../types`. The `SessionForker` port is
 *  DUCK-TYPED here so `@/tool` does NOT import `@/agent` (slice-isolation,
 *  per the `ToolContext` doc-block convention). The assembly seam
 *  (`@/agent/tier1/fork-session`) supplies a structurally-compatible
 *  `SessionForker` from `@/agent/fork-session`. */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"

/** Duck-typed mirror of `@/agent/fork-session.SessionForker`. Structurally
 *  identical to the producer (same method + return shape). Equivalence is
 *  guarded by a consumer-side test that can see both slices (RFC §3.1, same
 *  pattern as `GitWriteProtectReason` etc. in `../types.ts`). */
export interface SessionForkerLike {
  fork(checkpointId: string):
    | {
        ok: true
        value: {
          readonly sessionId: string
          readonly parentSessionId: string
          readonly parentCheckpointId: string
          readonly forkedAt: number
          readonly messages: ReadonlyArray<unknown>
        }
      }
    | {
        ok: false
        error: { readonly code: string; readonly message: string }
      }
}

export const forkSessionInputSchema = z.object({
  checkpointId: z
    .string()
    .min(1, "checkpointId must be non-empty")
    .describe("Id of the conversation checkpoint to fork from"),
})
export type ForkSessionInput = z.infer<typeof forkSessionInputSchema>

export const forkSessionTool = (forker: SessionForkerLike): Tool<ForkSessionInput> => ({
  name: "fork_session",
  description:
    "Fork a NEW session branched from a recorded conversation checkpoint. " +
    "The parent session is unaffected; the new session inherits the parent's " +
    "messages snapshot and a fresh sessionId. Read-only with respect to the " +
    "workspace (no FS writes).",
  inputSchema: forkSessionInputSchema,
  isReadOnly: () => true,
  // Concurrency-safe: the underlying store mutates an in-memory map under a
  // single-threaded JS runtime; consecutive calls cannot interleave at the
  // primitive level.
  isConcurrencySafe: () => true,
  // Non-destructive — the parent's snapshot is shared (immutable) and a new
  // entry is added under a freshly-minted UUID. No operator confirmation
  // required (mistakes are reversible: the forked session can be discarded).
  hitlTier: () => "none",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = forkSessionInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    const result = forker.fork(parsed.data.checkpointId)
    if (!result.ok) {
      yield {
        type: "result",
        result: { ok: false, output: `${result.error.code}: ${result.error.message}` },
      }
      return
    }
    const h = result.value
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          `Forked session ${h.sessionId} from parent ${h.parentSessionId} ` +
          `(checkpoint ${h.parentCheckpointId}) at ${h.forkedAt}. ` +
          `${h.messages.length} message(s) inherited.`,
      },
    }
  },
})
