/**
 * Hellgate — T01 item-stream DUAL-PLANE drift ratchet (the "single path" proof).
 *
 * The DoD demands a "projection 단일경로 라쳇 (scheduler reducer ↔ agent-state
 * mapper 동치 증명)". The SINGLE source is {@link ItemStreamProjector}; two thin
 * transports carry its cores:
 *   - SESSION wire: `item.stream` SessionHostTurnEvent → `projectSessionHostTurnEvent`
 *     → `item.started` / `item.delta` / `item.completed` SessionEvent.
 *   - AGENT-STATE wire: `itemCoreToAgentStateMessage` → `item.*` AgentStateMessage.
 *
 * This ratchet feeds ONE canonical AgentEvent sequence through the projector and
 * runs BOTH transports on every emitted core, then asserts the carried item
 * fields are IDENTICAL on both planes. A future edit that drops/renames a field
 * on ONE transport (the drift this guards) turns this RED.
 */
import { describe, expect, test } from "bun:test"
import { createKernelSessionState } from "@/kernel/session"
import {
  projectSessionHostTurnEvent,
  SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES,
} from "@/kernel/session/session-host-turn-event-projection"
import type { AgentStateMessage } from "@/protocol/agent-state"
import { itemCoreToAgentStateMessage } from "@/protocol/agent-state"
import type { SessionEvent } from "@/protocol/session"
import type { ItemStreamCore } from "@/shared"
import type { AgentEvent } from "@/stream"
import { ItemStreamProjector } from "@/stream"
import { capabilitiesFor } from "../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", tools: true, artifacts: true })

// A representative turn interior: reasoning run → bash command run → edit patch
// run → boundary flush. Exercises every itemType + both phases + accumulation.
const CANONICAL_EVENTS: AgentEvent[] = [
  { type: "assistant_thinking", delta: "Let me " },
  { type: "assistant_thinking", delta: "plan." },
  { type: "tool_call", id: "t1", name: "bash", input: {} } as AgentEvent,
  { type: "tool_progress", id: "t1", name: "bash", message: "line1\n" } as AgentEvent,
  { type: "tool_progress", id: "t1", name: "bash", message: "line2\n" } as AgentEvent,
  { type: "tool_result", id: "t1", name: "bash", ok: true, preview: "" } as AgentEvent,
  { type: "tool_call", id: "e1", name: "edit", input: {} } as AgentEvent,
  { type: "tool_progress", id: "e1", name: "edit", message: "@@ -1 +1 @@" } as AgentEvent,
  { type: "done", reason: "ok", turns: 1 },
]

const collectCores = (events: readonly AgentEvent[]): ItemStreamCore[] => {
  const p = new ItemStreamProjector()
  const out: ItemStreamCore[] = []
  for (const ev of events) out.push(...p.project(ev))
  return out
}

/** The item-identifying fields a transport MUST carry, normalized for compare. */
const coreFields = (item: ItemStreamCore): Record<string, unknown> => ({
  phase: item.phase,
  itemId: item.itemId,
  itemType: item.itemType,
  ...(item.phase === "started" ? { index: item.index } : {}),
  ...(item.phase === "delta" ? { deltaKind: item.deltaKind, delta: item.delta } : {}),
  ...(item.phase === "completed" ? { text: item.text } : {}),
})

const sessionEventFields = (e: SessionEvent): Record<string, unknown> => {
  if (e.type === "item.started") {
    return { phase: "started", itemId: e.itemId, itemType: e.itemType, index: e.itemIndex }
  }
  if (e.type === "item.delta") {
    return {
      phase: "delta",
      itemId: e.itemId,
      itemType: e.itemType,
      deltaKind: e.deltaKind,
      delta: e.delta,
    }
  }
  if (e.type === "item.completed") {
    return {
      phase: "completed",
      itemId: e.itemId,
      itemType: e.itemType,
      ...(e.text !== undefined ? { text: e.text } : { text: undefined }),
    }
  }
  throw new Error(`not an item event: ${e.type}`)
}

const agentStateMessageFields = (m: AgentStateMessage): Record<string, unknown> => {
  if (m.kind === "item.started") {
    return { phase: "started", itemId: m.itemId, itemType: m.itemType, index: m.itemIndex }
  }
  if (m.kind === "item.delta") {
    return {
      phase: "delta",
      itemId: m.itemId,
      itemType: m.itemType,
      deltaKind: m.deltaKind,
      delta: m.delta,
    }
  }
  if (m.kind === "item.completed") {
    return {
      phase: "completed",
      itemId: m.itemId,
      itemType: m.itemType,
      ...(m.text !== undefined ? { text: m.text } : { text: undefined }),
    }
  }
  throw new Error(`not an item message: ${m.kind}`)
}

describe("item-stream dual-plane drift ratchet", () => {
  test("both planes carry IDENTICAL item cores for the same AgentEvent sequence", () => {
    const cores = collectCores(CANONICAL_EVENTS)
    // Sanity: the canonical sequence actually produces items (not a vacuous pass).
    expect(cores.length).toBeGreaterThanOrEqual(9)

    const state = createKernelSessionState({
      sessionId: "drift-s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })

    for (const core of cores) {
      const sessionEvent = projectSessionHostTurnEvent({
        state,
        commandId: "c1",
        emittedAt: "2026-06-13T00:00:00.000Z",
        event: { type: "item.stream", item: core },
      }).emitted
      const message = itemCoreToAgentStateMessage(core, 1234)

      const expected = coreFields(core)
      // SESSION plane === core
      expect(sessionEventFields(sessionEvent)).toEqual(expected)
      // AGENT-STATE plane === core
      expect(agentStateMessageFields(message)).toEqual(expected)
      // belt-and-suspenders: the two planes === each other
      expect(sessionEventFields(sessionEvent)).toEqual(agentStateMessageFields(message))
    }
  })

  test("the session plane materializes all three item target types from the sequence", () => {
    const cores = collectCores(CANONICAL_EVENTS)
    const state = createKernelSessionState({
      sessionId: "drift-s2",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const emittedTypes = new Set(
      cores.map(
        (core) =>
          projectSessionHostTurnEvent({
            state,
            commandId: "c1",
            emittedAt: "2026-06-13T00:00:00.000Z",
            event: { type: "item.stream", item: core },
          }).emitted.type,
      ),
    )
    for (const t of ["item.started", "item.delta", "item.completed"] as const) {
      expect(emittedTypes.has(t)).toBe(true)
      expect(
        (SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES as readonly string[]).includes(t),
      ).toBe(true)
    }
  })

  test("seq is strictly monotonic across a run of item.stream projections", () => {
    const cores = collectCores(CANONICAL_EVENTS)
    let state = createKernelSessionState({
      sessionId: "drift-s3",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const seqs: number[] = []
    for (const core of cores) {
      const r = projectSessionHostTurnEvent({
        state,
        commandId: "c1",
        emittedAt: "2026-06-13T00:00:00.000Z",
        event: { type: "item.stream", item: core },
      })
      seqs.push(r.emitted.seq)
      state = r.state
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number)
    }
  })
})
