import { describe, expect, it } from "vitest"
import { decodeGoalStateFromEnvelope } from "./envelope"

describe("goal state envelope", () => {
  it("decodes the versioned canonical snapshot and rejects version drift", () => {
    const envelope = {
      version: "goal-state.v1",
      kind: "goalState",
      payload: {
        kind: "goal.state",
        emittedAt: 10,
        state: {
          kind: "goal",
          revision: 2,
          freshness: "fresh",
          validationContract: "missing",
          wake: { kind: "stopped" },
          latestSettlement: null,
          objective: null,
        },
      },
    }
    expect(decodeGoalStateFromEnvelope(envelope)?.state.revision).toBe(2)
    expect(decodeGoalStateFromEnvelope({ ...envelope, version: "goal-state.v2" })).toBeNull()
    const missingWake = structuredClone(envelope)
    delete (missingWake.payload.state as { wake?: unknown }).wake
    expect(decodeGoalStateFromEnvelope(missingWake)).toBeNull()
  })
})
