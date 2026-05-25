import { z } from "zod"
import type { DeferredResultRegistry } from "./deferred/port"
import type { DeferredError, Status } from "./deferred/types"
import { defineTool } from "./factory"
import type { Tool, ToolEvent, ToolResult } from "./types"

/**
 * ADR-0287 — `poll_deferred` tool. The LLM-visible probe surface for
 * deferred work registered by `defineToolAsync` (ADR-0287) or any other
 * caller that owns the same `DeferredResultRegistry`.
 *
 * The tool takes a handle id (the string the dispatch wire surfaces inside
 * the `<deferred handle="..."/>` envelope) and an optional `awaitMs`. When
 * `awaitMs` is `0` or absent the tool calls `registry.poll(handle)` and
 * returns immediately. When `awaitMs > 0` the tool calls
 * `registry.await(handle, awaitMs)` so the LLM can ask "wait up to N ms,
 * then tell me what you see" in one round trip.
 *
 * The terminal `output` text encodes the closed 5-arm `Status` literally
 * (`pending`/`running`/`completed`/`failed`/`cancelled`) so the LLM can
 * branch deterministically without parsing. When the status is `completed`
 * the underlying `ToolResult` is unwrapped into THIS tool's terminal
 * result (with a `<completed via=deferred>` prefix so the model can see
 * the indirection). For non-completed terminal states (`failed` /
 * `cancelled`) the error reason is rendered in a stable format
 * `[<kind>] <details>` so a future regex consumer is locked.
 *
 * Default-OFF wiring: the tool is REGISTERED ONLY when the assembly layer
 * passes a non-undefined `registry` — same caller-wire pattern as
 * `mcp_tasks_*`, `shadow_*`, `subagent_*_bg`. The barrel re-exports the
 * factory so a composition root can opt in with one line.
 */

export const pollDeferredInputSchema = z.object({
  handle: z.string().min(1).describe("Deferred handle id (from the <deferred> envelope)."),
  awaitMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("OPTIONAL: wait up to this many ms for the work to settle. 0/absent ⇒ poll only."),
})

export type PollDeferredInput = z.infer<typeof pollDeferredInputSchema>

/** Render a terminal `Status` into an LLM-facing string. The renderer is
 *  pure + total — every closed-union arm is covered. Adding a 6th `kind`
 *  is a `tsc` error at the `never` default. */
const renderStatus = (s: Status): string => {
  switch (s.kind) {
    case "pending":
      return "[pending] not started"
    case "running":
      return "[running] worker in progress"
    case "completed":
      return "[completed]"
    case "failed":
      return `[failed] ${renderError(s.error)}`
    case "cancelled":
      return `[cancelled] ${renderError(s.error)}`
    default: {
      const _exhaust: never = s
      void _exhaust
      return "[unknown]"
    }
  }
}

const renderError = (e: DeferredError): string => {
  switch (e.kind) {
    case "unknown-handle":
      return `unknown-handle id=${e.id}`
    case "worker-threw":
      return `worker-threw: ${e.message}`
    case "cancelled":
      return "cancelled"
    case "await-timeout":
      return `await-timeout after ${e.timeoutMs}ms`
    case "handle-evicted":
      return `handle-evicted id=${e.id}`
    default: {
      const _exhaust: never = e
      void _exhaust
      return "unknown"
    }
  }
}

/** Build the `poll_deferred` tool against a specific registry. Caller-wire
 *  pattern — composition root passes the same registry it wired to every
 *  `defineToolAsync` instance. */
export const pollDeferredTool = (registry: DeferredResultRegistry): Tool<PollDeferredInput> =>
  defineTool<PollDeferredInput>({
    name: "poll_deferred",
    description:
      "Poll an async tool's deferred result by handle id. Returns the lifecycle status (pending/running/completed/failed/cancelled). When `awaitMs > 0` blocks up to that many ms.",
    inputSchema: pollDeferredInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input: PollDeferredInput): AsyncIterable<ToolEvent> {
      const wantedAwait = typeof input.awaitMs === "number" && input.awaitMs > 0
      const status: Status = wantedAwait
        ? await registry.await({ id: input.handle, createdAt: 0 }, input.awaitMs)
        : registry.poll({ id: input.handle, createdAt: 0 })
      const head = renderStatus(status)
      if (status.kind === "completed") {
        const inner: ToolResult = status.result
        const result: ToolResult = {
          ...inner,
          output: `<completed via=deferred handle=${input.handle}>\n${inner.output}`,
        }
        yield { type: "result", result }
        return
      }
      // Non-terminal or non-completed terminal — surface the status string as
      // the tool result. `ok` mirrors whether the status is a SUCCESS arm
      // (`completed`) — pending/running are ok:true (no error yet); failed
      // and cancelled are ok:false.
      const ok = status.kind === "pending" || status.kind === "running"
      const result: ToolResult = {
        ok,
        output: head,
      }
      if (!ok) {
        result.failure = { mode: "error", modelVisibleError: head }
      }
      yield { type: "result", result }
    },
  })
