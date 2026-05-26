import { describe, expect, test } from "bun:test"
import {
  runConformanceTranscript,
  runRevisionConflictFlow,
} from "./session-transport-conformance-fixtures"

describe("websocket session transport conformance", () => {
  test("connect, command dispatch, and event ordering match the session protocol", async () => {
    const flow = await runConformanceTranscript("websocket")
    try {
      expect(flow.accepted).toEqual(["websocket-command"])
      expect(flow.seen).toEqual([
        { kind: "snapshot", snapshot: flow.snapshot },
        { kind: "event", event: flow.events[0] },
        { kind: "event", event: flow.events[1] },
      ])
      expect(flow.harness.client.currentResumeFromSeq()).toBe(12)
    } finally {
      await flow.harness.close()
      await flow.bridge.close()
    }
  })

  test("stale revision rejects and resyncs with snapshot plus retained tail", async () => {
    const flow = await runRevisionConflictFlow("websocket")
    try {
      expect(flow.seen).toEqual([
        {
          kind: "rejected",
          sessionId: "session-1",
          target: "command",
          reason: "revision_conflict",
          commandId: "websocket-stale-command",
          expectedRevision: 5,
          actualRevision: 6,
        },
        { kind: "snapshot", snapshot: flow.snapshot },
        { kind: "event", event: flow.liveTailEvent },
      ])
    } finally {
      await flow.harness.close()
      await flow.bridge.close()
    }
  })
})
