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
import type { DeliveryMode } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import type { AgentMetaRegistry } from "./agent-meta"
import { ownersForRegistry } from "./agent-tool"
import type { TaskRecord, TaskRegistry } from "./registry"

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

// ─── delivery port (WS3 — RFC jul-18 §4.4) ──────────────────────────────────
//
// The `followup_task` tool no longer sequences mailbox-send + wake itself; it
// hands a canonical delivery request to the `@/agent` controller and renders its
// closed outcome. These are DUCK-TYPED mirrors of
// `@/agent/subagent-delivery/{types,ports}` so this slice stays fenced (@/subagent
// may only reach @/tool + @/shared; the host adapts the real controller onto this
// mirror at wire time). Structural identity is asserted at the wire site.

/** Mirror of `SubagentDeliveryRequest` — the caller intent the tool builds. */
export interface DeliveryRequestMirror {
  readonly targetTaskId: string
  readonly from: string
  readonly body: string
  readonly mode: DeliveryMode
  readonly activation: "passive" | "ensure-turn"
  readonly expectedTurnId?: string
  readonly correlationId?: string
}

/** Mirror of the discriminated `SubagentDeliveryOutcome`. The tool reads `kind`
 *  + the per-arm fields it maps back onto {@link FollowupTaskOutput}. */
export type DeliveryOutcomeMirror =
  | {
      readonly kind: "accepted"
      readonly deliveryId: string
      readonly requestedMode: "steer"
      readonly effect: "steer_pending"
      readonly targetTurnId: string
    }
  | {
      readonly kind: "applied"
      readonly deliveryId: string
      readonly requestedMode: "queue" | "interrupt"
      readonly effectiveMode: "queue" | "interrupt"
      readonly effect: "queued" | "woke" | "interrupted"
    }
  | {
      readonly kind: "degraded"
      readonly deliveryId: string
      readonly requestedMode: "queue" | "steer" | "interrupt"
      readonly effectiveMode: "queue"
      readonly effect: "queued" | "woke"
      readonly reason: string
    }
  | { readonly kind: "rejected"; readonly reason: string }

/** Narrow mirror of `SubagentDeliveryPort` — the ONE method followup consumes. */
export interface DeliveryPort {
  deliver(req: DeliveryRequestMirror): DeliveryOutcomeMirror
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
  /** F-B (jul-7 audit) — the enumerating agent's stable lineage label (its own
   *  `mailboxAgentId`). When set, the listing is SCOPED: only tasks stamped by
   *  THIS lineage (via the spawn owners ledger) plus owner-less host-seeded tasks
   *  are returned, so a child cannot enumerate a sibling's id/label. Absent ⇒ no
   *  scoping (byte-identical legacy path; the top-level root has no label). */
  readonly requesterLineage?: string
}

/** True when `a` is visible to `requesterLineage`: no lineage set ⇒ all visible;
 *  else own-lineage tasks + owner-less host-seeded ones (mirrors the wait/continue_from
 *  disclosure rule — an unstamped task stays legacy-visible). */
const lineageVisible = (
  owners: ReadonlyMap<string, string> | undefined,
  requester: string | undefined,
  id: string,
): boolean => {
  if (requester === undefined || owners === undefined) return true
  const owner = owners.get(id)
  return owner === undefined || owner === requester
}

/** Pure, synchronous, no-throw enumeration. */
export const handleListAgents = (
  input: ListAgentsInput,
  deps: ListAgentsDeps,
): ListAgentsOutput => {
  const wantSettled = input.includeSettled === true
  const limit = input.limit ?? 256
  // F-B — resolve the owners ledger ONLY when a lineage scope is requested (so the
  // unscoped legacy path never touches it ⇒ byte-identical).
  const owners = deps.requesterLineage === undefined ? undefined : ownersForRegistry(deps.registry)
  const rows = deps.registry
    .list() // concurrency-safe snapshot copy
    .filter((rec) => lineageVisible(owners, deps.requesterLineage, rec.id))
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
    mode: z
      .enum(["queue", "steer", "interrupt"])
      .optional()
      .describe(
        "Delivery timing (default queue). queue = delivered for the target's next turn; " +
          "interrupt = abort the target's CURRENT turn so it reports-and-continues now (the " +
          "child stays running — this is NOT a kill; forceStop/task_stop is the separate " +
          "terminal path); steer = inject into the current turn without aborting (requires the " +
          "steer capability, else rejected).",
      ),
  })
  .strict()

export type FollowupTaskInput = z.infer<typeof FollowupTaskInputSchema>

export type FollowupTaskOutput =
  | {
      readonly kind: "success"
      readonly status: "accepted"
      readonly deliveryId: string
      readonly delivered: false
      readonly triggered: false
      readonly requestedMode: "steer"
      readonly targetTurnId: string
    }
  | {
      readonly kind: "success"
      readonly status: "applied"
      readonly deliveryId: string
      readonly delivered: true
      /** true ⇒ woke an idle child or interrupted an active turn immediately;
       *  false ⇒ queued (mid-turn, drains next turn). */
      readonly triggered: boolean
      readonly requestedMode: "queue" | "interrupt"
      readonly effectiveMode: "queue" | "interrupt"
    }
  | {
      readonly kind: "success"
      readonly status: "degraded"
      readonly deliveryId: string
      readonly delivered: true
      readonly triggered: boolean
      readonly requestedMode: "queue" | "steer" | "interrupt"
      readonly effectiveMode: "queue"
      readonly reason: string
    }
  | IntrospectError

export interface FollowupTaskDeps {
  /** WS3 — the narrow delivery controller (RFC §4.4). The tool builds a canonical
   *  request and renders the closed outcome; it NO LONGER sequences mailbox-send +
   *  wake itself. Ownership / self / settled / label-resolution all live in the
   *  controller now (RFC §4.3). */
  readonly delivery: DeliveryPort
  /** Caller's mailbox label (sender). Defaults to "parent" when the host did
   *  not derive one. */
  readonly callerLabel: string
}

/** Map a controller reject/degrade reason onto the tool's legacy
 *  `IntrospectError.cause` so existing callers/telemetry keep their vocabulary
 *  across the migration. */
const rejectCause = (reason: string): string => {
  switch (reason) {
    case "target_unknown":
      return "id_unknown"
    case "target_settled":
      return "settled"
    case "ownership_denied":
      return "denied"
    case "self_target":
      return "self_target"
    case "invalid_input":
      return "input_invalid"
    case "mode_disabled":
      return "mode_disabled"
    default:
      return reason
  }
}

/** Resolve the effective delivery mode from the schema. The deprecated
 *  `interrupt?: boolean` was deleted post-migration (RFC §4.4 "No indefinite dual
 *  truth"); the zod-validated `mode` enum is now the sole source of truth,
 *  defaulting to `queue` when omitted. */
const effectiveMode = (input: FollowupTaskInput): DeliveryMode => input.mode ?? "queue"

/** Pure, synchronous, no-throw deliver-and-trigger. Delegates the whole
 *  decide/apply to the injected {@link DeliveryPort}; only the mode resolution +
 *  outcome→output mapping live here. */
export const handleFollowupTask = (
  input: FollowupTaskInput,
  deps: FollowupTaskDeps,
): FollowupTaskOutput => {
  const mode = effectiveMode(input)
  // followup_task always guarantees an eligible child gets a turn (ensure-turn);
  // `subagent_send_message` owns the passive queue path (RFC §3.1).
  const outcome = deps.delivery.deliver({
    targetTaskId: input.agentId,
    from: deps.callerLabel,
    body: input.message,
    mode,
    activation: "ensure-turn",
  })
  switch (outcome.kind) {
    case "rejected":
      return err(
        `followup_task ${input.agentId} rejected: ${outcome.reason}`,
        rejectCause(outcome.reason),
      )
    case "accepted":
      // Admission is not delivery. The correlated final receipt decides whether
      // this becomes applied/degraded/cancelled/failed.
      return {
        kind: "success",
        status: "accepted",
        deliveryId: outcome.deliveryId,
        delivered: false,
        triggered: false,
        requestedMode: outcome.requestedMode,
        targetTurnId: outcome.targetTurnId,
      }
    case "applied":
      return {
        kind: "success",
        status: "applied",
        deliveryId: outcome.deliveryId,
        delivered: true,
        triggered: outcome.effect === "woke" || outcome.effect === "interrupted",
        requestedMode: outcome.requestedMode,
        effectiveMode: outcome.effectiveMode,
      }
    case "degraded":
      // The payload WAS delivered (retained in the mailbox); the live mode
      // downgraded to queue. It remains a successful delivery with an explicit
      // degraded status even when no live waker exists.
      return {
        kind: "success",
        status: "degraded",
        deliveryId: outcome.deliveryId,
        delivered: true,
        triggered: outcome.effect === "woke",
        requestedMode: outcome.requestedMode,
        effectiveMode: "queue",
        reason: outcome.reason,
      }
  }
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
 * (+ optional `agentMeta`). `followup_task` additionally needs the WS3
 * {@link DeliveryPort} (+ `callerLabel`); absent ⇒ ONLY `list_agents` is built
 * (so a host can enable enumeration without followup).
 */
export interface IntrospectToolsDeps {
  readonly registry: TaskRegistry
  readonly agentMeta?: AgentMetaRegistry
  /** WS3 — the delivery controller. When present, `followup_task` is built.
   *  Ownership / self / settled / label-resolution / wake now live in it. */
  readonly delivery?: DeliveryPort
  readonly callerLabel?: string
  /** Best-effort lifecycle observation. Admission has no effective mode; the
   *  finalization authority emits the correlated terminal event separately. */
  readonly onSteerAdmission?: (notice: {
    readonly deliveryId: string
    readonly targetTaskId: string
    readonly targetTurnId: string
  }) => void
  /** Gate: build `list_agents` only when true. */
  readonly enableIntrospect?: boolean
  /** Gate: build `followup_task` only when true AND the delivery port exists. */
  readonly enableFollowup?: boolean
  /** F-B (jul-7 audit) — the enumerating agent's own lineage label, forwarded into
   *  `list_agents` so enumeration is lineage-scoped. Absent ⇒ unscoped (byte-identical). */
  readonly requesterLineage?: string
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
      ...(deps.requesterLineage !== undefined ? { requesterLineage: deps.requesterLineage } : {}),
    })
    if (out.kind === "error") {
      yield errorEvent(out)
      return
    }
    yield successEvent(renderListed(out), out)
  },
})

const followupTaskTool = (
  deps: IntrospectToolsDeps & { delivery: DeliveryPort },
): Tool<FollowupTaskInput> => ({
  name: "followup_task",
  description:
    "Send a message to an existing non-root child subagent AND trigger a turn in it. " +
    'Three delivery modes (default mode:"queue"): queue = if the target is mid-turn the ' +
    "message is queued and drains at its next turn; " +
    'mode:"interrupt" = abort the target\'s CURRENT turn so it reports-and-continues on the ' +
    "message immediately — the child stays running (this is NOT a kill; forceStop/task_stop " +
    'is the separate terminal path); mode:"steer" = inject into its current turn without ' +
    "aborting (requires the steer capability, else rejected).",
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
      delivery: deps.delivery,
      callerLabel: deps.callerLabel ?? "parent",
    })
    if (out.kind === "error") {
      yield errorEvent(out)
      return
    }
    if (out.status === "accepted") {
      try {
        deps.onSteerAdmission?.({
          deliveryId: out.deliveryId,
          targetTaskId: input.agentId,
          targetTurnId: out.targetTurnId,
        })
      } catch {
        // Observation only: a broken stream sink cannot revoke admission.
      }
      yield successEvent(
        `steer accepted for ${input.agentId}; pending finalization (delivery ${out.deliveryId}, turn ${out.targetTurnId})`,
        out,
      )
      return
    }
    const delivery = `delivery ${out.deliveryId}`
    if (out.status === "degraded") {
      yield successEvent(
        `delivered to ${input.agentId}; ${out.requestedMode} degraded to queue (${out.reason}, ${delivery})`,
        out,
      )
      return
    }
    yield successEvent(
      `delivered to ${input.agentId}; turn ${out.triggered ? "started" : "queued for next turn"} (${out.effectiveMode}, ${delivery})`,
      out,
    )
  },
})

/**
 * Build the introspection tools per the gates. Returns `list_agents` when
 * `enableIntrospect`; `followup_task` when `enableFollowup` AND the WS3
 * {@link DeliveryPort} is wired. Gates OFF / port absent ⇒ the corresponding
 * tool is simply not built (default-OFF, byte-identical).
 */
export const createIntrospectTools = (deps: IntrospectToolsDeps): Tool[] => {
  const tools: Tool[] = []
  if (deps.enableIntrospect === true) {
    tools.push(listAgentsTool(deps) as Tool)
  }
  if (deps.enableFollowup === true && deps.delivery !== undefined) {
    tools.push(followupTaskTool({ ...deps, delivery: deps.delivery }) as Tool)
  }
  return tools
}
