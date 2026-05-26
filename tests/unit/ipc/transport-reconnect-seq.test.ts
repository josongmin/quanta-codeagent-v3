import { describe, expect, test } from "bun:test"
import { runReconnectFlow } from "./session-transport-conformance-fixtures"

for (const kind of ["stdio", "websocket"] as const) {
  describe(`${kind} reconnect seq discipline`, () => {
    test("reconnect resumes from the last observed seq and replays only missing events", async () => {
      const flow = await runReconnectFlow(kind)
      try {
        expect(flow.resumeFromSeq).toBe(12)
        expect(flow.firstSeen).toEqual([
          { kind: "snapshot", snapshot: flow.snapshot },
          { kind: "event", event: flow.events[0] },
          { kind: "event", event: flow.events[1] },
        ])
        expect(flow.secondSeen).toEqual([{ kind: "event", event: flow.events[2] }])
      } finally {
        await flow.second.close()
        await flow.bridge.close()
      }
    })
  })
}
