/** ADR-0416 / ADR-0419 — Subagent mailbox LLM tools (`subagent_send_message`
 *  + `subagent_read_messages`) wired to the ADR-0416 `MailboxPort`.
 *
 *  This slice exposes the inter-agent mailbox SEND + READ surfaces to the LLM so
 *  a running agent can message its parent, a sibling, or broadcast to every other
 *  agent WITHOUT teardown — and then POLL its own inbox for incoming mail —
 *  closing the structural gap that quanta subagents are fork-and-forget. Codex
 *  `multi_agents_v2.send_message(agent_id, msg)` parity.
 *
 *  TWO tools, one closed port:
 *    - `subagent_send_message`  — enqueue a message into the mailbox (ADR-0416).
 *    - `subagent_read_messages` — drain / peek the caller's inbox (ADR-0419,
 *      closes the ADR-0416 read deferral).
 *
 *  Sender / reader id: derived from `ctx`. PREFERRED is the STABLE per-agent
 *  mailbox label `ctx.agentLabel` (the subagent runner mints a deterministic
 *  `parentLabel/seq` id and the dispatch seam surfaces it). When absent we FALL
 *  BACK to a stable-per-depth label from `ctx.depth` (root = "root", child =
 *  "agent@depth-N"). The depth-only fallback is correct for root↔single-child,
 *  but it COLLAPSES every sibling forked at the same depth onto one label — so a
 *  parent's DIRECT message to one sibling could be consumed by another. The
 *  stable `agentLabel` is the structural fix for that (audit H). Both tools share
 *  the SAME `senderId` helper so the agent that sent under a label reads its own
 *  inbox under that identical label. The literal target `"parent"` (send only)
 *  resolves to `ctx.parentAgentLabel` when present, else the depth-derived parent
 *  label. This keeps the tool slice free of any `@/agent` import.
 *
 *  HITL tier: `pre-approval-ok` for BOTH (information-class — no FS / shell /
 *  network side effect; send only enqueues in memory, read only polls memory).
 *  `subagent_read_messages` is additionally `isReadOnly: true` (a poll mutates
 *  only the in-memory delivery cursor, never observable state the loop snapshots).
 *
 *  NO-THROW: zod `safeParse` catches malformed input at the boundary; the port
 *  call is wrapped in try/catch so a hostile throwing port surfaces as
 *  `{ ok: false, output: "send failed: ..." }` / `"read failed: ..."` instead of
 *  bubbling past the loop.
 *
 *  SLICE FENCE: declares the narrow mailbox port it consumes locally, then
 *  accepts the host mailbox structurally at the Tier-1 composition seam. This
 *  keeps the tool a library leaf: it imports `../types` (Tool / ToolContext /
 *  ToolEvent / ToolResult), `@/shared` (errMessage), and `zod`, never `@/agent`.
 *  The host-owned mailbox can add storage-only operations without widening this
 *  tool's authority or creating a reverse runtime dependency. */

import { z } from "zod"
import { errMessage, escapeBodyForLine } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

/** The mailbox protocol this LLM-facing surface actually consumes. It is
 * deliberately narrower than the host-owned store: send/read/peek/pending are
 * enough to expose the tools, while snapshot/admin methods remain unavailable
 * to this slice. Structural typing keeps the host adapter checkable without an
 * upward `@/agent` import. */
export type SubagentMailboxMessageKind = "request" | "response" | "broadcast"

export interface SubagentMailboxMessage {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: SubagentMailboxMessageKind
  readonly body: string
  readonly correlationId?: string
  readonly sentAt: number
  /** Present only when the host team-scoped adapter denied delivery. */
  readonly denied?: "cross-team"
}

export interface SubagentMailboxToolPort {
  send(init: {
    from: string
    to: string
    kind: SubagentMailboxMessageKind
    body: string
    correlationId?: string
  }): SubagentMailboxMessage
  read(agentId: string, opts?: { limit?: number }): readonly SubagentMailboxMessage[]
  peek(agentId: string, opts?: { limit?: number }): readonly SubagentMailboxMessage[]
  pendingFor(agentId: string): number
}

/** Stable root mailbox address. This is protocol data, not a host dependency. */
const ROOT_MAILBOX_AGENT_ID = "root"

const KIND_ENUM = [
  "request",
  "response",
  "broadcast",
] as const satisfies readonly SubagentMailboxMessageKind[]
// Two-way drift guard: `satisfies` proves array⊆union; this Assert proves the
// REVERSE. Add a kind to SubagentMailboxMessageKind but forget the zod enum → the
// subagent can never send that kind. Build error instead of silent gap.
type _AssertKind<T extends true> = T
export type _MailboxKindDriftGuard = _AssertKind<
  SubagentMailboxMessageKind extends (typeof KIND_ENUM)[number] ? true : false
>

// Input caps (R2 audit-H — DoS via 16MB `to`/100MB `correlation_id` → 1024-cell
// retention × cap = bounded memory; `limit` cap is intent signalling — `collect`
// is already self-bound by `cells.size ≤ 1024`):
//   - `to` ≤ 128: agent ids are deterministic `parentLabel/seq` (< 64 chars);
//     128 is a generous backstop, not a tuning knob.
//   - `correlation_id` ≤ 128: same shape as message id (ulid-class).
//   - `limit` ≤ 256: ≥ 1024-cell hard ceiling caps a single drain; 256 is
//     a comfortable per-tool-call return ceiling.
const TO_MAX = 128
const CORRELATION_ID_MAX = 128
const READ_LIMIT_MAX = 256

export const subagentSendMessageSchema = z.object({
  to: z.string().min(1).max(TO_MAX).describe('Target agent id, "*" broadcast, or "parent".'),
  kind: z.enum(KIND_ENUM),
  body: z.string().min(1).max(8000),
  correlation_id: z.string().max(CORRELATION_ID_MAX).optional(),
})
export type SubagentSendMessageInput = z.infer<typeof subagentSendMessageSchema>

/** A usable stable label is a non-empty string. The runner mints these
 *  deterministically (`parentLabel/seq`); a hostile / empty value falls through
 *  to the depth fallback rather than corrupting addressing. */
const usableLabel = (v: unknown): v is string => typeof v === "string" && v.length > 0

/** Depth-derived label (the FALLBACK identity): root (0 / absent) ⇒ "root";
 *  a child at depth N ⇒ "agent@depth-N". Correct for root↔single-child, but
 *  COLLAPSES same-depth siblings onto one label — which is exactly why the
 *  stable `agentLabel` seam exists (audit H). */
const depthLabel = (ctx: ToolContext): string => {
  const d = ctx.depth
  const depth = typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0
  // F1 (jul-15) SSOT: a root caller's manual-read id MUST be the SAME label the
  // side-agent finding WRITE recipient + turn-top drain use (`rootMailboxRecipient`).
  return depth === 0 ? ROOT_MAILBOX_AGENT_ID : `agent@depth-${depth}`
}

/** Resolve the calling agent's mailbox identity. PREFERS the stable
 *  `ctx.agentLabel` (deterministic per-agent id from the subagent runner);
 *  FALLS BACK to the depth-derived label so a legacy caller that sets only
 *  `ctx.depth` is byte-identical. */
const senderId = (ctx: ToolContext): string =>
  usableLabel(ctx.agentLabel) ? ctx.agentLabel : depthLabel(ctx)

/** Resolve the literal target `"parent"`. PREFERS the stable
 *  `ctx.parentAgentLabel` (the exact agent that spawned this one) so a child
 *  addresses the right parent even when siblings share a depth; FALLS BACK to
 *  depth arithmetic (a depth-N child's parent is depth N-1) when the stable
 *  parent label is absent. Everything else (a concrete id or `"*"`) passes
 *  through verbatim. */
const resolveTarget = (to: string, ctx: ToolContext): string => {
  if (to !== "parent") return to
  if (usableLabel(ctx.parentAgentLabel)) return ctx.parentAgentLabel
  const d = ctx.depth
  const depth = typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0
  const parentDepth = depth > 0 ? depth - 1 : 0
  return parentDepth === 0 ? "root" : `agent@depth-${parentDepth}`
}

/** Render a sent message to concise model-facing confirmation text. */
const renderSent = (m: SubagentMailboxMessage): string => {
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

const buildSubagentSendMessage = (
  port: SubagentMailboxToolPort,
): Tool<SubagentSendMessageInput> => ({
  name: "subagent_send_message",
  description:
    "Send a message to another agent in this run WITHOUT tearing it down. " +
    '`to`: a target agent id, "*" to broadcast to every other agent, or ' +
    '"parent" to address the agent that spawned you. `kind`: request / ' +
    "response / broadcast (use `correlation_id` to tie a response to a prior " +
    "request). The recipient receives the message the next time it polls its " +
    "inbox via `subagent_read_messages`. Returns the queued message. An " +
    "unknown target sits unread until that agent (eventually) reads. When team " +
    "messaging is enabled, delivery requires a SHARED team with the target: a " +
    "cross-team or un-teamed send is DENIED (ok:false) rather than silently " +
    "dropped — create/join a team (team_create) or address a same-team agent.",
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
        kind: SubagentMailboxMessageKind
        body: string
        correlationId?: string
      } = { from, to, kind: parsed.data.kind, body: parsed.data.body }
      if (parsed.data.correlation_id !== undefined) {
        init.correlationId = parsed.data.correlation_id
      }
      const m = port.send(init)
      // F3 (jul-15) — honest deny. The team-scoped decorator DROPS a cross-team
      // direct message (or a broadcast from an un-teamed sender that reaches no
      // one) before enqueue and stamps `denied:"cross-team"` on the stand-in.
      // Report the TRUTH — a fake `ok:true` "sent message ..." made the model
      // believe an undelivered message went through.
      if (m.denied !== undefined) {
        yield {
          type: "result",
          result: errResult(
            `send denied: ${m.to === "*" ? "no teammates to broadcast to" : "cross-team target"} — ` +
              "team messaging is on and you are not in a shared team with the target. " +
              "Create or join a team (team_create) and address a same-team agent. " +
              // NB: addressing "parent" is NOT a workaround here — an un-teamed
              // child is denied against its parent identically (both un-teamed),
              // so the ONLY remedy is a shared team.
              'Once you and the target share a team, "parent" and concrete ids both work.',
          ),
        }
        return
      }
      yield { type: "result", result: { ok: true, output: renderSent(m) } }
    } catch (e) {
      yield { type: "result", result: errResult(`send failed: ${errMessage(e)}`) }
    }
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0419 — READ side (`subagent_read_messages`). Closes the ADR-0416 deferral.
// ─────────────────────────────────────────────────────────────────────────────

const READ_MODE_ENUM = ["read", "peek"] as const

export const subagentReadMessagesSchema = z.object({
  mode: z
    .enum(READ_MODE_ENUM)
    .optional()
    .describe('"read" marks delivered (default); "peek" leaves undelivered.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(READ_LIMIT_MAX)
    .optional()
    .describe("Max messages to return (oldest-first)."),
})
export type SubagentReadMessagesInput = z.infer<typeof subagentReadMessagesSchema>

/** Escape control chars in a message body so a hostile/garbled body cannot
 *  forge additional inbox lines. Each rendered message MUST occupy exactly one
 *  line; without this, a body containing a newline + a fake `victim→root
 *  [response] …` line would be parsed by the reading model as a SEPARATE
 *  message (sender spoofing). Newlines/CR collapse to the literal two-char
 *  `\n` via the shared `escapeBodyForLine`; the 8 KB body is otherwise verbatim. */

/** Render one inbox message to a concise model-facing line:
 *  `from→to [kind] body (id, correlationId?)`. One line per message — the body
 *  is newline-escaped so it cannot inject a forged second line. */
const renderMessage = (m: SubagentMailboxMessage): string => {
  const tail = m.correlationId !== undefined ? `(${m.id}, ${m.correlationId})` : `(${m.id})`
  return `${m.from}→${m.to} [${m.kind}] ${escapeBodyForLine(m.body)} ${tail}`
}

/** Render the full inbox view: messages oldest-first (the port already returns
 *  them sorted by `sentAt`) plus a trailing `pending: <n>` line. Empty inbox ⇒
 *  the literal `"(no messages)"` followed by the pending line. */
const renderInbox = (messages: readonly SubagentMailboxMessage[], pending: number): string => {
  const body = messages.length === 0 ? "(no messages)" : messages.map(renderMessage).join("\n")
  return `${body}\npending: ${pending}`
}

const buildSubagentReadMessages = (
  port: SubagentMailboxToolPort,
): Tool<SubagentReadMessagesInput> => ({
  name: "subagent_read_messages",
  description:
    "Poll your own inbox for messages other agents sent you (or broadcast). " +
    '`mode`: "read" (default) returns undelivered messages addressed to you and ' +
    'MARKS them delivered so a re-read is idempotent; "peek" returns the same ' +
    "set WITHOUT marking (leaves them pending). `limit` caps the oldest-first " +
    "result. Each line is `from→to [kind] body (id, correlationId?)`; a trailing " +
    "`pending: <n>` line reports how many messages remain undelivered to you " +
    "AFTER this call. Your identity is derived from your subagent depth (root / " +
    "agent@depth-N), matching subagent_send_message.",
  inputSchema: subagentReadMessagesSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = subagentReadMessagesSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      const agentId = senderId(ctx)
      const mode = parsed.data.mode ?? "read"
      const opts = parsed.data.limit !== undefined ? { limit: parsed.data.limit } : undefined
      const messages = mode === "peek" ? port.peek(agentId, opts) : port.read(agentId, opts)
      const pending = port.pendingFor(agentId)
      yield { type: "result", result: { ok: true, output: renderInbox(messages, pending) } }
    } catch (e) {
      yield { type: "result", result: errResult(`read failed: ${errMessage(e)}`) }
    }
  },
})

/** Build the subagent-mailbox tools wired to a single narrow port. Returned as
 *  a stable array so the tier-1 composer can spread it uniformly (mirrors
 *  `objectiveTools` / `subagentBgTools` shape). Both the SEND (ADR-0416) and READ
 *  (ADR-0419) tools share the SAME port instance and the SAME id-derivation. */
export const subagentMailboxTools = (port: SubagentMailboxToolPort): Tool[] => [
  buildSubagentSendMessage(port) as Tool,
  buildSubagentReadMessages(port) as Tool,
]
