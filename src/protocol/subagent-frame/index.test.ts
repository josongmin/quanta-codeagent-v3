/**
 * `@/protocol/subagent-frame` codec hellgate — round-trip + version gate +
 * shape rejection. Mirrors the agent-state / canvas codec pins.
 */

import { describe, expect, it } from "bun:test"
import {
  decodeSubagentFrame,
  encodeSubagentFrame,
  SUBAGENT_PROTOCOL_VERSION,
  subagentObservationToMessage,
} from "./index"

describe("subagent-frame codec", () => {
  it("round-trips a spawn observation through encode/decode", () => {
    const msg = subagentObservationToMessage(
      {
        type: "subagent_spawn",
        taskId: "t1",
        parentTaskId: "t0",
        depth: 2,
        description: "d",
        agentType: "explorer",
        at: 10,
      },
      { now: 999 },
    )
    const decoded = decodeSubagentFrame(encodeSubagentFrame(msg))
    expect(decoded).toEqual(msg)
    if (decoded?.type !== "subagent_spawn") throw new Error("arm")
    expect(decoded.emittedAt).toBe(999)
  })

  it("round-trips a status observation", () => {
    const msg = subagentObservationToMessage(
      { type: "subagent_status", taskId: "t1", status: "completed", at: 20, turns: 3 },
      { now: 5 },
    )
    expect(decodeSubagentFrame(encodeSubagentFrame(msg))).toEqual(msg)
  })

  it("rejects a mismatched protocol version", () => {
    const bad = JSON.stringify({
      version: "subagent.v2",
      kind: "subagent",
      payload: {
        type: "subagent_spawn",
        taskId: "t",
        depth: 0,
        description: "",
        at: 1,
        emittedAt: 1,
      },
    })
    expect(decodeSubagentFrame(bad)).toBeNull()
  })

  it("rejects a foreign / malformed frame", () => {
    expect(decodeSubagentFrame(JSON.stringify({ kind: "agentState", version: "x" }))).toBeNull()
    expect(decodeSubagentFrame("not json")).toBeNull()
    expect(decodeSubagentFrame(42)).toBeNull()
    expect(
      decodeSubagentFrame(
        JSON.stringify({
          version: SUBAGENT_PROTOCOL_VERSION,
          kind: "subagent",
          payload: { type: "x" },
        }),
      ),
    ).toBeNull()
  })
})
