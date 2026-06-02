/**
 * RFC-04 / ADR-0437 — subagent introspection tools: `list_agents` +
 * `followup_task`.
 *
 * - `list_agents`  — read-only enumeration of the live (+ optionally settled)
 *   children in the `TaskRegistry`, with id/label prefix filter. Reuses
 *   `TaskRegistry.list()` (concurrency-safe snapshot) joined with the optional
 *   `AgentMetaRegistry` side-table for depth/label. Codex `multi_agents_v2/
 *   list_agents` absorption.
 * - `followup_task` — deliver a message to a non-root target child AND trigger
 *   its turn. Delivery is SYNTHESIZED over the injected mailbox `send` port
 *   (NOT a new store — N1); the trigger is the new {@link TurnWakeRegistry}.
 *   Honest degradation: no waker ⇒ message still delivered, `cause:"no_waker"`.
 *   Codex `multi_agents_v2/followup_task` absorption.
 *
 * SLICE FENCE: imports only `zod`, sibling `@/subagent` modules, `@/tool`
 * (Tool/ToolEvent), `@/shared`. The mailbox is consumed through a LOCAL narrow
 * `MailboxSendPort` mirror (duck-typed) so this slice does NOT import
 * `@/agent/subagent-mailbox` (slice fence: @/subagent may only reach @/tool +
 * @/shared; the host adapts the real MailboxPort onto this mirror at wire time).
 *
 * NO-THROW: handlers are pure/synchronous and return a discriminated
 * `success|error` union; zod validation happens at the tool boundary.
 */

import { z } from "zod"
import type { Tool, ToolEvent } from "@/tool"
import type { AgentMetaRegistry } from "./agent-meta"
import type { TaskRecord, TaskRegistry } from "./registry"
import type { TurnWakeRegistry } from "./turn-wake"

// ─── shared error shape ──────────────────────────────────────────────────────

/** Mirrors tools-6 `ErrorShape` semantics (kept local — slice stays
 *  self-describing). Every handler error is `{kind:"error", message, cause?}`. */
export interface IntrospectError {
  readonly kind: "error"
  readonly message: string
  readonly cause?: string
}

const err = (message: string, cause: string): IntrospectError => ({
  kind: "error",
  message,
  cause,
})

/** Narrow mirror of the mailbox `send` method (the only one followup needs).
 *  Duck-typed so `@/subagent` does not import `@/agent/subagent-mailbox`. */
export interface MailboxSendPort {
  send(init: {
    from: string
    to: string
    kind: "request" | "response" | "broadcast"
    body: string
    correlationId?: string
  }): unknown
}

// ─── list_agents ─────────────────────────────────────────────────────────────

export const ListAgentsInputSchema = z
  .object({
    prefix: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Filter to agents whose id OR label starts with this prefix (no trailing slash)."),
    includeSettled: z
      .boolean()
      .optional()
      .describe("Include completed/failed/stopped children. Default false = live (running) only."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256)
      .optional()
      .describe("Max agents to return (default 256, aligned with the registry settled-LRU)."),
  })
  .strict()

export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>

/** Per-agent enumeration row. The 4-status registry union is narrowed to a
 *  3-bucket view (running / settled / failed) sufficient for LLM decisions. */
export interface ListedAgent {
  readonly id: string
  readonly status: "running" | "settled" | "failed"
  readonly depth: number
  readonly label: string
  readonly startedAt: number
}

export type ListAgentsOutput =
  | { readonly kind: "success"; readonly agents: readonly ListedAgent[] }
  | IntrospectError

/** Bucket the registry's 4-status enum into the 3-bucket view. */
const bucketStatus = (s: TaskRecord["status"]): ListedAgent["status"] => {
  if (s === "running") return "running"
  if (s === "failed") return "failed"
  return "settled" // completed | stopped
}

/** Derive the display label: agentType ?? description prefix ?? id. */
const deriveLabel = (rec: TaskRecord, metaLabel: string | undefined): string => {
  if (metaLabel !== undefined && metaLabel !== "") return metaLabel
  if (rec.agentType !== undefined && rec.agentType !== "") return rec.agentType
  if (rec.description !== undefined && rec.description !== "") return rec.description.slice(0, 40)
  return rec.id
}

const toListed = (rec: TaskRecord, agentMeta: AgentMetaRegistry | undefined): ListedAgent => {
  const meta = agentMeta?.get(rec.id)
  return {
    id: rec.id,
    status: bucketStatus(rec.status),
    depth: meta?.depth ?? 0,
    label: deriveLabel(rec, meta?.label),
    startedAt: rec.startedAt,
  }
}

const prefixMatch = (prefix: string | undefined, a: ListedAgent): boolean => {
  if (prefix === undefined) return true
  return a.id.startsWith(prefix) || a.label.startsWith(prefix)
}

export interface ListAgentsDeps {
  readonly registry: TaskRegistry
  readonly agentMeta?: AgentMetaRegistry
}

/** Pure, synchronous, no-throw enumeration. */
export const handleListAgents = (
  input: ListAgentsInput,
  deps: ListAgentsDeps,
): ListAgentsOutput => {
  const wantSettled = input.includeSettled === true
  const limit = input.limit ?? 256
  const rows = deps.registry
    .list() // concurrency-safe snapshot copy
    .map((rec) => toListed(rec, deps.agentMeta))
    .filter((a) => (wantSettled ? true : a.status === "running"))
    .filter((a) => prefixMatch(input.prefix, a))
    .slice(0, limit)
  return { kind: "success", agents: rows }
}

// ─── followup_task ───────────────────────────────────────────────────────────

export const FollowupTaskInputSchema = z
  .object({
    agentId: z.string().min(1).describe("Target agent id (from spawn_agent). Must be non-root."),
    message: z
      .string()
      .min(1)
      .max(8192)
      .describe("Message delivered to the target before triggering its turn (8KB cap)."),
    interrupt: z
      .boolean()
      .optional()
      .describe(
        "When true, stop the target's current task and handle this immediately. Default false = queue for the next turn.",
      ),
  })
  .strict()

export type FollowupTaskInput = z.infer<typeof FollowupTaskInputSchema>

export type FollowupTaskOutput =
  | {
      readonly kind: "success"
      readonly delivered: true
      /** true ⇒ woke an idle child immediately; false ⇒ queued (mid-turn). */
      readonly triggered: boolean
    }
  | IntrospectError

export interface FollowupTaskDeps {
  readonly registry: TaskRegistry
  readonly mailbox: MailboxSendPort
  readonly wake: TurnWakeRegistry
  /** Caller's mailbox label (sender). Defaults to "parent" when the host did
   *  not derive one. */
  readonly callerLabel: string
  /** Maps an agentId to its mailbox label. Absent ⇒ id used verbatim. */
  readonly resolveLabel?: (agentId: string) => string
  /** When set, a `followup_task` whose `agentId` equals this is rejected with
   *  `cause:"self_target"` (a child must not re-trigger its own loop). Absent ⇒
   *  no self-target guard (host did not inject own id). */
  readonly ownAgentId?: string
}

/** Pure, synchronous, no-throw deliver-and-trigger. */
export const handleFollowupTask = (
  input: FollowupTaskInput,
  deps: FollowupTaskDeps,
): FollowupTaskOutput => {
  if (deps.ownAgentId !== undefined && input.agentId === deps.ownAgentId) {
    return err("cannot followup_task your own loop", "self_target")
  }
  const rec = deps.registry.get(input.agentId)
  // root is the main loop — never in the registry. An unknown id covers both a
  // genuinely-unknown id AND a root-targeting attempt (non-root only policy).
  if (rec === undefined) {
    return err(
      `No agent found with id ${input.agentId} (target must be a non-root child)`,
      "id_unknown",
    )
  }
  if (rec.status !== "running") {
    return err(`target ${input.agentId} is not running (status=${rec.status})`, "settled")
  }

  // 1) Deliver via the mailbox (NO-THROW; inherits quota/escape protections).
  const to = deps.resolveLabel?.(input.agentId) ?? input.agentId
  deps.mailbox.send({ from: deps.callerLabel, to, kind: "request", body: input.message })

  // 2) Trigger the target's turn via the wake registry.
  const reason = input.interrupt === true ? "interrupt" : "followup"
  const outcome = deps.wake.wake(input.agentId, reason)
  if (outcome === "no-receiver") {
    // Honest degradation: the message WAS delivered, but no live turn-wake
    // receiver exists to trigger a turn. The target sees the message on its
    // next read.
    return err(
      `delivered to ${input.agentId} but it has no live turn-wake receiver (message queued for next read)`,
      "no_waker",
    )
  }
  return { kind: "success", delivered: true, triggered: outcome === "woke" }
}

// ─── tool builder ────────────────────────────────────────────────────────────

const successEvent = (output: string, structured: unknown): ToolEvent => ({
  type: "result",
  result: { ok: true, output, structured },
})

const errorEvent = (e: IntrospectError): ToolEvent => ({
  type: "result",
  result: { ok: false, output: `${e.message} (cause: ${e.cause ?? "unknown"})` },
})

const renderListed = (out: { agents: readonly ListedAgent[] }): string => {
  if (out.agents.length === 0) return "no matching agents"
  return out.agents.map((a) => `${a.id}  [${a.status}]  depth=${a.depth}  ${a.label}`).join("\n")
}

/**
 * Deps for the introspect tool builder. `list_agents` needs only `registry`
 * (+ optional `agentMeta`). `followup_task` additionally needs `mailbox` +
 * `wake` + `callerLabel`; when those are absent ONLY `list_agents` is built
 * (so a host can enable enumeration without followup).
 */
export interface IntrospectToolsDeps {
  readonly registry: TaskRegistry
  readonly agentMeta?: AgentMetaRegistry
  /** Followup substrate. When all three are present, `followup_task` is built. */
  readonly mailbox?: MailboxSendPort
  readonly wake?: TurnWakeRegistry
  readonly callerLabel?: string
  readonly resolveLabel?: (agentId: string) => string
  readonly ownAgentId?: string
  /** Gate: build `list_agents` only when true. */
  readonly enableIntrospect?: boolean
  /** Gate: build `followup_task` only when true AND the substrate exists. */
  readonly enableFollowup?: boolean
}

const listAgentsTool = (deps: IntrospectToolsDeps): Tool<ListAgentsInput> => ({
  name: "list_agents",
  description:
    "List the live child subagents in this session (id, status, depth, label). " +
    "Set includeSettled:true to also see finished children; filter by id/label prefix.",
  inputSchema: ListAgentsInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // eslint-disable-next-line require-yield
  async *execute(input: ListAgentsInput): AsyncIterable<ToolEvent> {
    const parsed = ListAgentsInputSchema.safeParse(input)
    if (!parsed.success) {
      yield errorEvent(err(`invalid input: ${parsed.error.message}`, "input_invalid"))
      return
    }
    const out = handleListAgents(parsed.data, {
      registry: deps.registry,
      ...(deps.agentMeta !== undefined ? { agentMeta: deps.agentMeta } : {}),
    })
    if (out.kind === "error") {
      yield errorEvent(out)
      return
    }
    yield successEvent(renderListed(out), out)
  },
})

const followupTaskTool = (
  deps: IntrospectToolsDeps & { mailbox: MailboxSendPort; wake: TurnWakeRegistry },
): Tool<FollowupTaskInput> => ({
  name: "followup_task",
  description:
    "Send a message to an existing non-root child subagent AND trigger a turn in it. " +
    "If the target is mid-turn the message is queued and starts its next turn. " +
    "Set interrupt:true to stop its current task and handle the message immediately.",
  inputSchema: FollowupTaskInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  // eslint-disable-next-line require-yield
  async *execute(input: FollowupTaskInput): AsyncIterable<ToolEvent> {
    const parsed = FollowupTaskInputSchema.safeParse(input)
    if (!parsed.success) {
      yield errorEvent(err(`invalid input: ${parsed.error.message}`, "input_invalid"))
      return
    }
    const out = handleFollowupTask(parsed.data, {
      registry: deps.registry,
      mailbox: deps.mailbox,
      wake: deps.wake,
      callerLabel: deps.callerLabel ?? "parent",
      ...(deps.resolveLabel !== undefined ? { resolveLabel: deps.resolveLabel } : {}),
      ...(deps.ownAgentId !== undefined ? { ownAgentId: deps.ownAgentId } : {}),
    })
    if (out.kind === "error") {
      yield errorEvent(out)
      return
    }
    yield successEvent(
      `delivered to ${input.agentId}; turn ${out.triggered ? "started" : "queued for next turn"}`,
      out,
    )
  },
})

/**
 * Build the introspection tools per the gates. Returns `list_agents` when
 * `enableIntrospect`; `followup_task` when `enableFollowup` AND the followup
 * substrate (`mailbox` + `wake`) is wired. Gates OFF / substrate absent ⇒ the
 * corresponding tool is simply not built (default-OFF, byte-identical).
 */
export const createIntrospectTools = (deps: IntrospectToolsDeps): Tool[] => {
  const tools: Tool[] = []
  if (deps.enableIntrospect === true) {
    tools.push(listAgentsTool(deps) as Tool)
  }
  if (deps.enableFollowup === true && deps.mailbox !== undefined && deps.wake !== undefined) {
    tools.push(followupTaskTool({ ...deps, mailbox: deps.mailbox, wake: deps.wake }) as Tool)
  }
  return tools
}
