/**
 * Central subagent-observation projection ownership.
 *
 * The AGENT-side half of the multi-agent orchestration SUBSTRATE: the pure
 * read-model projector
 *
 *   AgentEvent -> SubagentObservation
 *
 * mirroring `@/protocol/agent-state`'s `projectAgentEventToAgentStateObservation`.
 * BOTH the CLI `/agents --tree` and the web Sub-Agents panel (later waves) tap
 * THIS seam: the out-of-band tap hands each `subagent_spawn` / `subagent_status`
 * AgentEvent here, and the daemon forwarder ships the resulting observation.
 *
 * REDACTION (defense-in-depth): `description` / `finalTextPreview` / `error`
 * cross to a UI. The registry emit boundary already bounds + scrubs them, but
 * this projector re-scrubs via the `@/security` SoT (`redactSecrets`) so a raw
 * event reaching the projector directly (a test, a non-registry producer) still
 * cannot leak. Bounded FIRST, then scrubbed.
 *
 * Slice fence: `@/protocol` may NOT value-import `@/stream` (it is peer-denied),
 * so `AgentEvent` is `import type` only (the AST scanner skips type-only
 * imports); `redactSecrets` is a value import from `@/security` (allowed).
 */

import { redactSecrets } from "@/security"
import type { AgentEvent } from "@/stream"

/** The two subagent observation types (1:1 with the tapped AgentEvent arms). */
export const SUBAGENT_OBSERVATION_EVENT_TYPES = ["subagent_spawn", "subagent_status"] as const

export type SubagentObservationType = (typeof SUBAGENT_OBSERVATION_EVENT_TYPES)[number]

export const SUBAGENT_OBSERVATION_TYPES: ReadonlySet<SubagentObservationType> =
  new Set<SubagentObservationType>(SUBAGENT_OBSERVATION_EVENT_TYPES)

export const isSubagentObservationType = (value: unknown): value is SubagentObservationType =>
  typeof value === "string" &&
  (SUBAGENT_OBSERVATION_EVENT_TYPES as readonly string[]).includes(value)

/** Terminal statuses a settled subagent can carry (mirror of `TaskStatus`). */
export type SubagentObservationStatus = "running" | "completed" | "failed" | "stopped"

/** A spawn observation — one node ENTERS the tree. `parentTaskId` undefined ⇒
 *  root-level (spawned by the root session agent). */
export interface SubagentSpawnObservation {
  readonly type: "subagent_spawn"
  readonly taskId: string
  readonly parentTaskId?: string
  readonly depth: number
  readonly description: string
  readonly agentType?: string
  readonly at: number
}

/** A status observation — one node TRANSITIONS (settled or re-running). */
export interface SubagentStatusObservation {
  readonly type: "subagent_status"
  readonly taskId: string
  readonly status: SubagentObservationStatus
  readonly at: number
  readonly turns?: number
  readonly finalTextPreview?: string
  readonly error?: string
}

/** The read-model the panel consumes. */
export type SubagentObservation = SubagentSpawnObservation | SubagentStatusObservation

/**
 * SUBSTRATE — the daemon-side concrete sink (mirror of `AgentStateSink`). The
 * composition root wires it into `AgentConfig.onSubagentEvent` (Wave 2). Kept
 * here so the `@/apps/web-daemon` source module can reference the shape without
 * re-declaring it.
 */
export interface SubagentSink {
  capture(observation: SubagentObservation): void
}

/** Max chars a UI-crossing preview carries — bounded FIRST, then scrubbed. */
const PREVIEW_CAP = 240

/** Bound + secret-scrub a UI-crossing string via the `@/security` SoT. */
const boundedRedact = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined
  const bounded = s.length > PREVIEW_CAP ? s.slice(0, PREVIEW_CAP) : s
  return redactSecrets(bounded, { origin: "tool_result" }).text
}

/**
 * Project an AgentEvent onto its {@link SubagentObservation}, or `null` when the
 * event is not a subagent lifecycle event. Mirrors
 * `projectAgentEventToAgentStateObservation`. Pure; deterministic.
 */
export const projectToSubagentObservation = (event: AgentEvent): SubagentObservation | null => {
  if (event.type === "subagent_spawn") {
    return {
      type: "subagent_spawn",
      taskId: event.taskId,
      ...(event.parentTaskId !== undefined ? { parentTaskId: event.parentTaskId } : {}),
      depth: event.depth,
      description: boundedRedact(event.description) ?? "",
      ...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
      at: event.at,
    }
  }
  if (event.type === "subagent_status") {
    const preview = boundedRedact(event.finalTextPreview)
    const err = boundedRedact(event.error)
    return {
      type: "subagent_status",
      taskId: event.taskId,
      status: event.status,
      at: event.at,
      ...(event.turns !== undefined ? { turns: event.turns } : {}),
      ...(preview !== undefined ? { finalTextPreview: preview } : {}),
      ...(err !== undefined ? { error: err } : {}),
    }
  }
  return null
}
