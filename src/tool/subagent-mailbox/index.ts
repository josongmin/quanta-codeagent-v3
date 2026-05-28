/** ADR-0416 — Subagent mailbox LLM tool (`subagent_send_message`) wired to the
 *  ADR-0416 `MailboxPort`.
 *
 *  This slice exposes the inter-agent mailbox SEND surface to the LLM so a
 *  running agent can message its parent, a sibling, or broadcast to every other
 *  agent WITHOUT teardown — closing the structural gap that quanta subagents are
 *  fork-and-forget. Codex `multi_agents_v2.send_message(agent_id, msg)` parity.
 *
 *  ONE tool, one closed port:
 *    - `subagent_send_message` — enqueue a message into the mailbox.
 *
 *  NO READ tool THIS WAVE: incoming messages are surfaced to a recipient via
 *  the existing `task_output` summary / child-seed channels (ADR documents this
 *  deferral). The send surface lands first because it is the strictly-additive
 *  half — a recipient that never polls simply leaves the message unread (the
 *  store retains/evicts it).
 *
 *  Sender id: derived from `ctx`. `ToolContext` carries no session id today, so
 *  we derive a stable-per-depth sender label from `ctx.depth` (root = "root",
 *  child = "agent@depth-N"). The literal target `"parent"` is rewritten to the
 *  parent's derived label so a child can address its parent without knowing the
 *  parent's id. This keeps the tool slice free of any `@/agent` import.
 *
 *  HITL tier: `pre-approval-ok` (information-class — no FS / shell / network
 *  side effect; the only effect is an in-memory enqueue).
 *
 *  NO-THROW: zod `safeParse` catches malformed input at the boundary; the port
 *  call is wrapped in try/catch so a hostile throwing port surfaces as
 *  `{ ok: false, output: "send failed: ..." }` instead of bubbling past the loop.
 *
 *  SLICE FENCE: imports `@/agent/subagent-mailbox` (the closed ADR-0416
 *  substrate) for typed `MailboxPort` + `MailboxMessage`, `../types` (Tool /
 *  ToolContext / ToolEvent / ToolResult), `@/shared` (errMessage), and `zod`.
 *  NEVER `@/agent` core (loop / dispatch / prompt / features / types). */

import { z } from "zod"
import type { MailboxMessage, MailboxMessageKind, MailboxPort } from "@/agent/subagent-mailbox"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

const KIND_ENUM = [
  "request",
  "response",
  "broadcast",
] as const satisfies readonly MailboxMessageKind[]

export const subagentSendMessageSchema = z.object({
  to: z.string().describe('Target agent id, "*" broadcast, or "parent".'),
  kind: z.enum(KIND_ENUM),
  body: z.string().min(1).max(8000),
  correlation_id: z.string().optional(),
})
export type SubagentSendMessageInput = z.infer<typeof subagentSendMessageSchema>

/** Derive a stable sender label from the calling agent's recursion depth.
 *  `ToolContext` has no session id today; depth is the only stable agent-
 *  identity signal the dispatch seam threads in (`AgentConfig.depth`). Root
 *  (0 / absent) ⇒ "root"; a child at depth N ⇒ "agent@depth-N". */
const senderId = (ctx: ToolContext): string => {
  const d = ctx.depth
  const depth = typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0
  return depth === 0 ? "root" : `agent@depth-${depth}`
}

/** Resolve the literal target `"parent"` to the parent's derived label so a
 *  child can address its parent without knowing the id. A depth-N child's
 *  parent is depth N-1. Everything else (a concrete id or `"*"`) passes
 *  through verbatim. */
const resolveTarget = (to: string, ctx: ToolContext): string => {
  if (to !== "parent") return to
  const d = ctx.depth
  const depth = typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0
  const parentDepth = depth > 0 ? depth - 1 : 0
  return parentDepth === 0 ? "root" : `agent@depth-${parentDepth}`
}

/** Render a sent message to concise model-facing confirmation text. */
const renderSent = (m: MailboxMessage): string => {
  const lines: string[] = []
  lines.push(`sent message ${m.id}`)
  lines.push(`from: ${m.from}`)
  lines.push(`to: ${m.to}`)
  lines.push(`kind: ${m.kind}`)
  if (m.correlationId !== undefined) lines.push(`correlation_id: ${m.correlationId}`)
  lines.push(`sentAt: ${m.sentAt}`)
  return lines.join("\n")
}

const errResult = (msg: string): ToolResult => ({ ok: false, output: msg })

const buildSubagentSendMessage = (port: MailboxPort): Tool<SubagentSendMessageInput> => ({
  name: "subagent_send_message",
  description:
    "Send a message to another agent in this run WITHOUT tearing it down. " +
    '`to`: a target agent id, "*" to broadcast to every other agent, or ' +
    '"parent" to address the agent that spawned you. `kind`: request / ' +
    "response / broadcast (use `correlation_id` to tie a response to a prior " +
    "request). The recipient receives the message the next time it polls its " +
    "inbox (no read tool this wave; incoming surfaces via task_output / child " +
    "seed). Returns the queued message. An unknown target sits unread until " +
    "that agent (eventually) reads.",
  inputSchema: subagentSendMessageSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = subagentSendMessageSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      const from = senderId(ctx)
      const to = resolveTarget(parsed.data.to, ctx)
      const init: {
        from: string
        to: string
        kind: MailboxMessageKind
        body: string
        correlationId?: string
      } = { from, to, kind: parsed.data.kind, body: parsed.data.body }
      if (parsed.data.correlation_id !== undefined) {
        init.correlationId = parsed.data.correlation_id
      }
      const m = port.send(init)
      yield { type: "result", result: { ok: true, output: renderSent(m) } }
    } catch (e) {
      yield { type: "result", result: errResult(`send failed: ${errMessage(e)}`) }
    }
  },
})

/** Build the subagent-mailbox tool wired to a single `MailboxPort`. Returned as
 *  a stable array so the tier-1 composer can spread it uniformly (mirrors
 *  `objectiveTools` / `subagentBgTools` shape). */
export const subagentMailboxTools = (port: MailboxPort): Tool[] => [
  buildSubagentSendMessage(port) as Tool,
]
