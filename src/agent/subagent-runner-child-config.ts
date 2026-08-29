import type { Message } from "@/llm"
import { type RuntimeConfig, runtimeConfig } from "@/shared"
import type { SubagentTurnGate } from "@/subagent"
import { type Tool, ToolRegistry } from "@/tool"
import { ReadFileState } from "@/tool/stale-read-guard"
import type { SubagentRequest } from "../subagent/types"
import {
  buildLeaderDecide,
  buildLeaderHitlBroker,
  type LeaderEscalationDecider,
} from "./coordination-broker-wire"
import { isMutatingMode } from "./mode"
import type { NamedAgentDefinition, NamedAgentResolver } from "./named-agent-registry"
import { buildOwnershipPolicy, narrowChildOwnership } from "./ownership-policy"
import type { AgentMode } from "./prompt"
import { childDepthOf } from "./spawn-depth"
import { resolveChildEffort, resolveChildLlm } from "./subagent-runner-overrides"
import { namespaceRegistry, type ToolNamespaceStrategy } from "./subagent-tool-namespace"
import type { AgentConfig } from "./types"

type MailboxIds = { agentId: string; parentId: string }

const filterRegistry = (
  parent: ToolRegistry,
  toolFilter: string[] | undefined,
  extraTools?: readonly Tool[],
): ToolRegistry => {
  const extra = extraTools ?? []
  const allTools = (): Tool[] =>
    parent
      .specs()
      .map((s) => parent.get(s.name))
      .filter((t): t is Tool => t !== undefined)
  if (!toolFilter) return extra.length === 0 ? parent : new ToolRegistry([...allTools(), ...extra])
  const allow = new Set(toolFilter)
  const kept = parent
    .specs()
    .map((s) => s.name)
    .filter((name) => allow.has(name))
    .map((name) => parent.get(name))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
  return new ToolRegistry([...kept, ...extra])
}

const chainedSignal = (parent: AbortSignal, extra?: AbortSignal): AbortSignal =>
  extra ? AbortSignal.any([parent, extra]) : parent

const buildSeedPrompt = (req: SubagentRequest): string => {
  const parts = [
    req.priorAttempt && req.priorAttempt.length > 0
      ? `## Previous attempt's findings\n${req.priorAttempt}\n\n## Current task\n${req.prompt}`
      : req.prompt,
  ]
  if (req.ownedSurfaces && req.ownedSurfaces.length > 0) {
    parts.push(
      `**Owned surfaces** (you may read/modify these): ${req.ownedSurfaces.map((s) => `- ${s}`).join("\n")}`,
    )
  }
  if (req.forbiddenSurfaces && req.forbiddenSurfaces.length > 0) {
    parts.push(
      `**Forbidden surfaces** (do NOT touch): ${req.forbiddenSurfaces.map((s) => `- ${s}`).join("\n")}`,
    )
  }
  if (req.checkpointPath && req.checkpointPath.length > 0) {
    parts.push(
      `**Checkpoint**: Write your interim progress to \`${req.checkpointPath}\` every few turns (use the \`write\` or \`edit\` tool). The parent uses this file to monitor and to recover work if you are stopped.`,
    )
  }
  if (req.resultShape && req.resultShape.length > 0)
    parts.push(`**Final answer format**: ${req.resultShape}`)
  return parts.join("\n\n")
}

const applyNamedAgent = (parent: AgentConfig, req: SubagentRequest): SubagentRequest => {
  const resolver = (parent as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver
  if (resolver === undefined || req.agentType === undefined || req.agentType.length === 0)
    return req
  const def: NamedAgentDefinition | undefined = resolver.resolve(req.agentType)
  if (def === undefined) return req
  return {
    ...req,
    ...(req.system === undefined ? { system: def.system } : {}),
    ...(req.toolFilter === undefined && def.tools !== undefined ? { toolFilter: def.tools } : {}),
    ...(req.model === undefined && def.model !== undefined ? { model: def.model } : {}),
    ...(req.mode === undefined && def.mode !== undefined ? { mode: def.mode } : {}),
  }
}

const resolveChildMode = (
  parent: AgentConfig,
  req: SubagentRequest,
): Pick<AgentConfig, "mode"> | Record<string, never> => {
  const parentMode = parent.mode
  if (req.mode === undefined || req.mode.length === 0)
    return parentMode === undefined ? {} : { mode: parentMode }
  const requested = req.mode as AgentMode
  return parentMode !== undefined && !isMutatingMode(parentMode) && isMutatingMode(requested)
    ? { mode: parentMode }
    : { mode: requested }
}

const maybeWireCoordinationBroker = (
  parent: AgentConfig,
  mailboxIds: MailboxIds,
): Pick<AgentConfig, "admissibility"> | Record<string, never> => {
  if (!runtimeConfig().teamBroker || parent.onConfirm === undefined) return {}
  const { agentId: workerId, parentId: leaderId } = mailboxIds
  if (workerId.length === 0 || leaderId.length === 0) return {}
  const leaderDecide: LeaderEscalationDecider = buildLeaderDecide(parent.onConfirm, { workerId })
  let esc = 0
  const broker = buildLeaderHitlBroker({
    workerId,
    leaderId,
    leaderDecide,
    ...(parent.subagentMailbox ? { mailbox: parent.subagentMailbox } : {}),
    nextCorrelationId: () => `${workerId}#esc${esc++}`,
  })
  return { admissibility: { coordinationBroker: broker } }
}

type ChildBase = Pick<
  AgentConfig,
  | "llm"
  | "registry"
  | "stream"
  | "permission"
  | "messages"
  | "system"
  | "cwd"
  | "maxTurns"
  | "signal"
> &
  Partial<Pick<AgentConfig, "toolAllowlist" | "ownershipPolicy">>

const buildChildBase = (
  parent: AgentConfig,
  req: SubagentRequest,
  cwd: string,
  mailboxId: string,
  toolNamespace: ToolNamespaceStrategy | undefined,
  childRuntime: Pick<RuntimeConfig, "fsOwnershipEnforce">,
): ChildBase => {
  const filtered = filterRegistry(parent.registry, req.toolFilter, req.extraTools)
  const registry =
    toolNamespace === undefined ? filtered : namespaceRegistry(filtered, toolNamespace, mailboxId)
  // SECURITY: compose the child's requested surfaces with the PARENT's fence so
  // the child can only NARROW it, never widen/escape it. A fenced parent spawning
  // a child with no/omitted surfaces makes the child INHERIT the parent boundary
  // (not fall to unfenced) — closes the spawn-boundary bypass (jul-27 audit HIGH).
  const requestedPolicy = buildOwnershipPolicy({
    ...(req.ownedSurfaces ? { owned: req.ownedSurfaces } : {}),
    ...(req.forbiddenSurfaces ? { forbidden: req.forbiddenSurfaces } : {}),
    cwd,
    enforced: childRuntime.fsOwnershipEnforce,
  })
  const ownershipPolicy = narrowChildOwnership(parent.ownershipPolicy, requestedPolicy)
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: buildSeedPrompt(req) }] },
  ]
  return {
    llm: resolveChildLlm(parent, req),
    registry,
    ...(req.toolFilter !== undefined ? { toolAllowlist: req.toolFilter } : {}),
    stream: parent.stream,
    permission: parent.permission,
    messages,
    system: req.system !== undefined && req.system.length > 0 ? req.system : parent.system,
    cwd,
    ...(ownershipPolicy !== undefined ? { ownershipPolicy } : {}),
    maxTurns: req.budget?.maxTurns ?? parent.maxTurns,
    signal: chainedSignal(parent.signal, req.signal),
    ...childReadFileState(parent),
  }
}

/**
 * §17 packet F2 — the child's OWN stale-read observations.
 *
 * Two things were wrong at once. The child config never mentioned
 * `readFileState`, so a subagent ran with NO stale-read guard at all — every
 * child mutation skipped it.
 *
 * And the fix must NOT be to hand down the parent's instance. A read is an
 * OBSERVATION BY ONE AGENT: if the child inherited the parent's, it would
 * believe it had read files it never saw and would happily overwrite them; and
 * a sibling re-reading a file would launder another sibling's stale baseline
 * back to fresh. Freshness is per-observer, so each child gets a NEW instance
 * with the same posture.
 *
 * Absent parent guard ⇒ slot omitted ⇒ byte-identical to the prior child shape.
 */
const childReadFileState = (
  parent: Pick<AgentConfig, "readFileState">,
): Pick<AgentConfig, "readFileState"> | Record<string, never> =>
  parent.readFileState === undefined ? {} : { readFileState: new ReadFileState() }

/** WS2 (RFC jul-18 §4.2) — the child's control surface (port + active-turn
 *  holder), threaded ONLY when the control capability is wired. Absent ⇒ no port
 *  / no ref allocated ⇒ the loop never polls conversation actions (byte-identical
 *  to the prior child config shape). Extracted so the caller stays under biome's
 *  cognitive-complexity cap. */
const childControlConfig = (
  control: ChildControlWiring | undefined,
):
  | Pick<
      AgentConfig,
      "conversationActionPort" | "activeTurnRef" | "childSteerDrain" | "steerFinalization"
    >
  | Record<string, never> =>
  control === undefined
    ? {}
    : {
        // MED-2 — thread the loop-facing port + ref ONLY when present (steer plane
        // wired). Steer OFF ⇒ absent ⇒ byte-identical followup child (RFC §9).
        ...(control.conversationActionPort !== undefined
          ? { conversationActionPort: control.conversationActionPort }
          : {}),
        ...(control.activeTurnRef !== undefined ? { activeTurnRef: control.activeTurnRef } : {}),
        // WS4 — thread the steer drain view + finalization ONLY when present
        // (steer plane wired). Absent ⇒ no safe-point drain (byte-identical).
        ...(control.childSteerDrain !== undefined
          ? { childSteerDrain: control.childSteerDrain }
          : {}),
        ...(control.steerFinalization !== undefined
          ? { steerFinalization: control.steerFinalization }
          : {}),
      }

/** RFC-01 A3 — propagate the attention pending-question authority DOWN the whole
 *  spawn tree so every descendant shares ONE broker (the same instance A2's
 *  `AttentionReader` reads). The child's OWN `spawnedAsTaskId` is what the
 *  dispatch seam binds as the question owner, so each child's question projects
 *  to its own exact task id. Absent at the root ⇒ absent everywhere ⇒
 *  byte-identical OFF (the gate is the broker's presence). Extracted so the
 *  caller stays under biome's cognitive-complexity cap. */
const inheritQuestionBroker = (
  parent: AgentConfig,
): Pick<AgentConfig, "questionBroker"> | Record<string, never> =>
  parent.questionBroker !== undefined ? { questionBroker: parent.questionBroker } : {}

/** The parent's approval/verification gates, inherited verbatim so a child can
 *  never escape a gate its parent runs under. A unit because the three travel
 *  together — dropping one silently downgrades the child's safety posture — and
 *  because hoisting them keeps the caller under the cognitive-complexity cap. */
const inheritParentGuards = (
  parent: AgentConfig,
): Pick<AgentConfig, "verifyGuard" | "closeoutGuard" | "hitl"> | Record<string, never> => ({
  ...(parent.verifyGuard !== undefined ? { verifyGuard: parent.verifyGuard } : {}),
  ...(parent.closeoutGuard !== undefined ? { closeoutGuard: parent.closeoutGuard } : {}),
  ...(parent.hitl !== undefined ? { hitl: parent.hitl } : {}),
})

const buildChildInheritedConfig = (
  parent: AgentConfig,
  req: SubagentRequest,
  mailboxIds: MailboxIds,
  turnGate: SubagentTurnGate | undefined,
  spawnedAsTaskId: string | undefined,
  control: ChildControlWiring | undefined,
): Partial<AgentConfig> => {
  const childEffort = resolveChildEffort(req)
  return {
    ...({ depth: childDepthOf(parent) } as { depth: number }),
    ...inheritedCostAccounting(parent),
    mailboxAgentId: mailboxIds.agentId,
    mailboxParentId: mailboxIds.parentId,
    ...(req.taskId !== undefined ? { subagentTaskId: req.taskId } : {}),
    ...(spawnedAsTaskId !== undefined ? { spawnedAsTaskId } : {}),
    ...(parent.subagentMailbox ? { subagentMailbox: parent.subagentMailbox } : {}),
    ...(parent.teamRegistry ? { teamRegistry: parent.teamRegistry } : {}),
    ...(parent.peerInbox ? { peerInbox: parent.peerInbox } : {}),
    ...(turnGate !== undefined ? { subagentTurnGate: turnGate } : {}),
    ...childControlConfig(control),
    ...(childEffort !== undefined ? { sessionEffort: childEffort } : {}),
    ...(parent.onConfirm ? { onConfirm: parent.onConfirm } : {}),
    ...(parent.embedder ? { embedder: parent.embedder } : {}),
    ...(parent.compaction ? { compaction: parent.compaction } : {}),
    ...(parent.planMode !== undefined ? { planMode: parent.planMode } : {}),
    ...resolveChildMode(parent, req),
    ...inheritParentGuards(parent),
    ...(parent.subagent ? { subagent: parent.subagent } : {}),
    // Propagate the Sub-Agents panel observer DOWN the whole spawn tree so a
    // depth-2+ descendant emits + registers too (the panel shows the full tree,
    // not just direct children). Also makes the runner's foreground-register gate
    // (`parent.onSubagentEvent !== undefined`) consistent at every level — absent
    // at the root ⇒ absent everywhere ⇒ byte-identical OFF.
    ...(parent.onSubagentEvent !== undefined ? { onSubagentEvent: parent.onSubagentEvent } : {}),
    ...inheritQuestionBroker(parent),
    ...maybeWireCoordinationBroker(parent, mailboxIds),
  }
}

/** WS2 (RFC jul-18 §4.2) — the control bits threaded onto the child config when
 *  the control capability is wired. Structurally the fields the child loop
 *  consumes; the runner owns the full {@link ChildControlSurface} + endpoint. */
export interface ChildControlWiring {
  /** MED-2 — present only when the steer plane exists (gate ON); steer OFF ⇒ the
   *  child is byte-identical to the pre-jul-18 followup baseline (RFC §9). */
  readonly conversationActionPort?: NonNullable<AgentConfig["conversationActionPort"]>
  readonly activeTurnRef?: NonNullable<AgentConfig["activeTurnRef"]>
  /** WS4 — loop-facing steer drain view + finalization port, present only when
   *  the session steer plane exists (gate ON). Absent ⇒ no safe-point drain. */
  readonly childSteerDrain?: NonNullable<AgentConfig["childSteerDrain"]>
  readonly steerFinalization?: NonNullable<AgentConfig["steerFinalization"]>
}

/**
 * The cost slots a subagent SHARES with its parent rather than getting its own
 * copy of. All three are session- or run-scoped, and leaving any of them
 * un-inherited puts the child's spend somewhere the parent's numbers cannot
 * see it:
 *
 *   - `usageAccounting` — the session's source of truth for every cost
 *     surface. Un-shared, the parent's totals stay correct-looking and short by
 *     the whole child.
 *   - `budgetMeter` — the RUN's cost ceiling. Un-shared, a run walks past
 *     `maxCostUsd` simply by doing the spending inside a subagent. Only SPEND
 *     is shared: turn boundaries stay with the root (see `turn-iteration`), or
 *     a child turn would reset the parent's per-turn guard mid-turn.
 *   - `budgetLedger` — the cross-run daily cap, which had the same hole.
 *
 * Each is spread conditionally because the slots are optional under
 * `exactOptionalPropertyTypes`: an absent parent slot must stay ABSENT on the
 * child, not become an explicit `undefined`.
 */
const inheritedCostAccounting = (parent: AgentConfig): Partial<AgentConfig> => ({
  ...(parent.usageAccounting !== undefined ? { usageAccounting: parent.usageAccounting } : {}),
  ...(parent.budgetMeter !== undefined ? { budgetMeter: parent.budgetMeter } : {}),
  ...(parent.budgetLedger !== undefined ? { budgetLedger: parent.budgetLedger } : {}),
})

/** Assemble the child-only config; intentionally omits parent durable state. */
export const buildChildConfig = (
  parent: AgentConfig,
  rawReq: SubagentRequest,
  cwd: string,
  mailboxIds: MailboxIds,
  toolNamespace?: ToolNamespaceStrategy,
  turnGate?: SubagentTurnGate,
  spawnedAsTaskId?: string,
  childRuntime: Pick<RuntimeConfig, "fsOwnershipEnforce"> = runtimeConfig(),
  // WS2 — appended AFTER `childRuntime` to preserve the historical positional
  // call sites (the runtime override was the 8th positional arg pre-WS2).
  control?: ChildControlWiring,
): AgentConfig => {
  const req = applyNamedAgent(parent, rawReq)
  return {
    ...buildChildBase(parent, req, cwd, mailboxIds.agentId, toolNamespace, childRuntime),
    ...buildChildInheritedConfig(parent, req, mailboxIds, turnGate, spawnedAsTaskId, control),
  } as AgentConfig
}
