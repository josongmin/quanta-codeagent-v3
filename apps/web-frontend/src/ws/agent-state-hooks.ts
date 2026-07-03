/**
 * QUANTA_WEB_AGENT_STATE — React hooks over the agent-state WS channel.
 *
 * Consumes the 9 agent-state frames the in-band session protocol DROPS
 * (`plan.*` / `mode.changed` / `tool.progress` / `context.compacted` /
 * `ratelimit.snapshot`) off the out-of-band `QUANTA_WEB_AGENT_STATE` channel and
 * folds them into one live {@link AgentStateView} the {@link AgentStatePanel}
 * renders.
 *
 * Mirrors `canvas-hooks.ts` (ADR-0440): the hook accepts an event source (the
 * production caller wraps the existing `SessionClient.onAgentState`; tests pass a
 * stub). With no source / no frames the hook returns {@link EMPTY_AGENT_STATE}
 * (extended with `plan: null`) so the panel renders nothing — chat UI unchanged
 * (default-OFF).
 *
 * Fold semantics (latest-wins per kind):
 *   - `mode.changed`          → `mode = to`
 *   - `tool.progress`         → `toolProgress[toolCallId] = msg` (latest-wins,
 *                               insertion-ordered)
 *   - `context.compacted`     → `compaction = { summary, tokens }`
 *   - `ratelimit.snapshot`    → `ratelimit = msg`
 *   - `plan.input.requested`  → `planPrompt = msg`
 *   - `plan.input.resolved`   → clear `planPrompt` IFF its `promptId` matches the
 *                               outstanding prompt (a stale resolve is ignored)
 *   - `plan.created`/`.snapshot` → `plan = full snapshot` (replaces wholesale)
 *   - `plan.updated`          → `plan = applyPlanDelta(plan, delta, version)`
 *
 * The COPIED frontend mirror union (`../types/protocol.ts`, copy-not-import) is
 * the message type — the web bundle lives outside the bun tsconfig `paths`.
 */

import { useEffect, useReducer } from "react"
import {
  type AgentStateView,
  type CompactionMarker,
  EMPTY_AGENT_STATE,
} from "../components/AgentStatePanel"
import type {
  AgentStateMessage,
  AgentStatePlan,
  ContextCompactedMessage,
  ModeChangedMessage,
  PlanCreatedMessage,
  PlanInputRequestedMessage,
  PlanInputResolvedMessage,
  PlanSnapshotMessage,
  PlanUpdatedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
} from "../types/protocol"
import { applyPlanDelta } from "./plan-reducer"

/** The live plan mirror the surface renders — the wire snapshot shape
 *  (`plan.created` / `plan.snapshot` carry it; `plan.updated` folds onto it). */
export type PlanMirror = AgentStatePlan

/** Minimal event source the hook subscribes to. Production callers wrap the
 *  existing `SessionClient.onAgentState`; tests pass a stub. Clones
 *  {@link CanvasSource} in `canvas-hooks.ts`. */
export interface AgentStateSource {
  subscribe(handler: (msg: AgentStateMessage) => void): () => void
}

/**
 * The full agent-state view — the {@link AgentStatePanel} contract
 * ({@link AgentStateView}: mode / toolProgress / compaction / ratelimit /
 * planPrompt) EXTENDED with the live `plan` mirror the channel ships on
 * `plan.created` / `plan.snapshot` / `plan.updated`. The panel reads the base
 * axes; a future plan panel reads `plan`. Keeping the base names verbatim means
 * the existing panel consumes this view with ZERO drift.
 */
export interface FullAgentStateView extends AgentStateView {
  /** The live plan mirror, or `null` before any `plan.created`/`plan.snapshot`. */
  readonly plan: PlanMirror | null
}

/** The empty view — what {@link useAgentState} returns before any frame
 *  arrives. Extends {@link EMPTY_AGENT_STATE} with `plan: null`. */
export const EMPTY_FULL_AGENT_STATE: FullAgentStateView = {
  ...EMPTY_AGENT_STATE,
  plan: null,
}

/* ------------------------------------------------------------------ */
/* Per-kind narrowing — the SINGLE filter the reducer routes on.       */
/*                                                                     */
/* Exported (and load-bearing: the reducer below switches on these so  */
/* the routing is unit-tested directly instead of re-implemented inline */
/* in the test). The agent-state channel multiplexes 9 message kinds;  */
/* each predicate narrows exactly one. Mirrors `canvas-hooks.ts`.      */
/* ------------------------------------------------------------------ */

export const isPlanCreatedMsg = (m: AgentStateMessage): m is PlanCreatedMessage =>
  m.kind === "plan.created"

export const isPlanSnapshotMsg = (m: AgentStateMessage): m is PlanSnapshotMessage =>
  m.kind === "plan.snapshot"

export const isPlanUpdatedMsg = (m: AgentStateMessage): m is PlanUpdatedMessage =>
  m.kind === "plan.updated"

export const isPlanInputRequestedMsg = (m: AgentStateMessage): m is PlanInputRequestedMessage =>
  m.kind === "plan.input.requested"

export const isPlanInputResolvedMsg = (m: AgentStateMessage): m is PlanInputResolvedMessage =>
  m.kind === "plan.input.resolved"

export const isModeChangedMsg = (m: AgentStateMessage): m is ModeChangedMessage =>
  m.kind === "mode.changed"

export const isToolProgressMsg = (m: AgentStateMessage): m is ToolProgressMessage =>
  m.kind === "tool.progress"

export const isContextCompactedMsg = (m: AgentStateMessage): m is ContextCompactedMessage =>
  m.kind === "context.compacted"

export const isRatelimitSnapshotMsg = (m: AgentStateMessage): m is RatelimitSnapshotMessage =>
  m.kind === "ratelimit.snapshot"

/* ------------------------------------------------------------------ */
/* Reducer — pure, latest-wins per kind                                */
/* ------------------------------------------------------------------ */

type AgentStateAction = { type: "message"; msg: AgentStateMessage } | { type: "reset" }

/**
 * P3 (memory backstop): FIFO cap on the number of DISTINCT `toolCallId`s the
 * latest-wins `toolProgress` Map retains. BACKSTOP, not a tuned value — mirrors
 * `EVENT_DEDUP_CAP` (`session-hooks.ts`) and `TOOL_DIFFS_CAP` (`canvas-hooks.ts`):
 * a cap so high it never evicts in a normal session, only bounding memory for a
 * pathological one where thousands of distinct tool calls each leave a progress
 * marker. 256 is far beyond any realistic live-tool count; eviction is
 * oldest-first, so the recent window the panel renders is always retained.
 * Measure-first: revisit only if real sessions approach it.
 */
export const TOOL_PROGRESS_CAP = 256

/**
 * Latest-wins insert into an insertion-ordered Map with a FIFO memory cap.
 * `set` on an existing key updates in place WITHOUT reordering (latest-wins,
 * so re-touching a recent key never evicts it); a new key that pushes size over
 * `cap` evicts the oldest inserted key (Map's first entry). Mutates `next`.
 */
const setWithFifoCap = <V>(next: Map<string, V>, key: string, value: V, cap: number): void => {
  next.set(key, value)
  if (next.size > cap) {
    const oldest = next.keys().next().value
    if (oldest !== undefined) next.delete(oldest)
  }
}

/**
 * Fold one agent-state message onto the view. Pure (exported so the state
 * semantics are unit-tested in the node test env, no DOM render). Latest-wins
 * per kind; an unrecognised kind returns the prior state by reference (idle).
 */
export const agentStateReducer = (
  state: FullAgentStateView,
  action: AgentStateAction,
): FullAgentStateView => {
  if (action.type === "reset") return EMPTY_FULL_AGENT_STATE
  const { msg } = action

  if (isModeChangedMsg(msg)) {
    return { ...state, mode: msg.to }
  }
  if (isToolProgressMsg(msg)) {
    // Latest-wins per toolCallId; insertion order preserved (Map iteration).
    // FIFO-capped as a memory backstop (P3).
    const toolProgress = new Map(state.toolProgress)
    setWithFifoCap(toolProgress, msg.toolCallId, msg, TOOL_PROGRESS_CAP)
    return { ...state, toolProgress }
  }
  if (isContextCompactedMsg(msg)) {
    const compaction: CompactionMarker = { summary: msg.summary, tokens: msg.tokens }
    return { ...state, compaction }
  }
  if (isRatelimitSnapshotMsg(msg)) {
    return { ...state, ratelimit: msg }
  }
  if (isPlanInputRequestedMsg(msg)) {
    return { ...state, planPrompt: msg }
  }
  if (isPlanInputResolvedMsg(msg)) {
    // Clear the prompt only if it is the one being resolved — a stale resolve
    // (different promptId) must not blank a fresh prompt.
    if (state.planPrompt !== null && state.planPrompt.promptId === msg.promptId) {
      return { ...state, planPrompt: null }
    }
    return state
  }
  if (isPlanCreatedMsg(msg) || isPlanSnapshotMsg(msg)) {
    return { ...state, plan: msg.plan }
  }
  if (isPlanUpdatedMsg(msg)) {
    return { ...state, plan: applyPlanDelta(state.plan, msg.delta, msg.version) }
  }
  // Forward-compat: an unrecognised kind is a no-op (idle).
  return state
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to the agent-state channel and fold every frame into one live
 * {@link FullAgentStateView}. With `source === null` (the gate is OFF / no
 * client) the hook never subscribes and returns {@link EMPTY_FULL_AGENT_STATE}
 * — the panel renders nothing (default-OFF, chat UI unchanged).
 */
export const useAgentState = (source: AgentStateSource | null): FullAgentStateView => {
  const [state, dispatch] = useReducer(agentStateReducer, EMPTY_FULL_AGENT_STATE)
  useEffect(() => {
    if (source === null) return
    return source.subscribe((msg) => dispatch({ type: "message", msg }))
  }, [source])
  return state
}
