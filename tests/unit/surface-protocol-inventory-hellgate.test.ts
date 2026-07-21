import { describe, expect, test } from "bun:test"
import { AGENT_STATE_TYPES } from "@/protocol/agent-state"
import {
  LEGACY_DEFAULT_SURFACE_SUBSCRIPTION,
  resolveReadModels,
  SESSION_EVENT_TYPES,
  SURFACE_READ_MODEL_IDS,
  SURFACE_READ_MODEL_STATUSES,
  supported,
} from "@/protocol/session"
import { AGENT_EVENT_TYPES } from "@/stream"

/**
 * Surface-protocol inventory hellgate.
 *
 * This is the Phase-0 truth inventory in executable form. It pins the current
 * canonical counts and the key inclusion relationship the jun-11 audit depends
 * on: agent-state is a strict subset projection of AgentEvent, while
 * SessionEvent is the separate boundary protocol inventory.
 *
 * If one of these counts changes, the test SHOULD go red so the inventory and
 * owning docs are reviewed intentionally rather than drifting silently.
 */
describe("surface-protocol inventory hellgate", () => {
  test("current canonical inventories stay at the reviewed counts", () => {
    // ALBB-21 — +1 advisory `budget_breach` (soft/hard cost-cap crossing).
    // Multi-agent-panel SUBSTRATE — +2 subagent lifecycle events
    // (`subagent_spawn` / `subagent_status`) for the `/agents --tree` CLI + web
    // Sub-Agents panel (later waves), consumed off the `@/protocol/subagent`
    // projection seam. Transient render-only (recorder skips them).
    // Side-agent peer delivery adds `peer_message`; targeted steer adds the
    // correlated `subagent_delivery` admission/finalization lifecycle.
    expect(AGENT_EVENT_TYPES.length).toBe(41)
    // T01 — +3 additive session.v1 item events (item.started/delta/completed).
    // ALBB-04 — +1 dedicated cancel terminal (turn.aborted).
    // UUX-1-12 (jul-10) — +4 additive observability events (tool.progress /
    // turn.recovery / context.compacted / budget.breach); reviewed with the
    // bridge expansion hellgate (session-host-turn-event-bridge-observability).
    expect(SESSION_EVENT_TYPES.length).toBe(23)
    expect(AGENT_STATE_TYPES.size).toBe(9)
    expect(SURFACE_READ_MODEL_IDS.length).toBe(4)
    expect(SURFACE_READ_MODEL_STATUSES).toEqual(["subscribed", "supported", "unsupported"])
  })

  test("agent-state tapped types are all valid AgentEvent types", () => {
    const canonical = new Set<string>(AGENT_EVENT_TYPES)
    for (const type of AGENT_STATE_TYPES) {
      expect(canonical.has(type)).toBe(true)
    }
  })

  test("inventory teeth: a renamed agent-state type would break the subset relation", () => {
    const canonical = new Set<string>(AGENT_EVENT_TYPES)
    const mutated = new Set<string>(AGENT_STATE_TYPES)
    mutated.delete("plan_created")
    mutated.add("plan_created.RENAMED")
    for (const type of mutated) {
      if (type.endsWith(".RENAMED")) {
        expect(canonical.has(type)).toBe(false)
      }
    }
  })

  test("legacy fallback surface subscription is explicit about every read model", () => {
    expect(LEGACY_DEFAULT_SURFACE_SUBSCRIPTION).toEqual({
      session: { status: "subscribed", protocol: "session.v1" },
      agentState: { status: "subscribed", protocol: "agent-state.v1" },
      canvas: { status: "subscribed", protocol: "canvas.v1" },
      observability: { status: "subscribed", protocol: "observability.v1" },
    })
  })

  test("resolved read-model coverage preserves support truth separately from subscription truth", () => {
    expect(
      resolveReadModels(
        {
          session: supported("session.v1"),
          agentState: { status: "unsupported" },
          canvas: supported("canvas.v1"),
          observability: supported("observability.v1"),
        },
        {
          session: { status: "subscribed", protocol: "session.v1" },
          agentState: { status: "subscribed", protocol: "agent-state.v1" },
          canvas: { status: "unsupported" },
          observability: { status: "subscribed", protocol: "observability.v1" },
        },
      ),
    ).toEqual({
      session: { status: "subscribed", protocol: "session.v1" },
      agentState: { status: "unsupported" },
      canvas: { status: "supported", protocol: "canvas.v1" },
      observability: { status: "subscribed", protocol: "observability.v1" },
    })
  })
})
