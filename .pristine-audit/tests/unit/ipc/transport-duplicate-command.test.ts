import { describe, expect, test } from "bun:test"
import { runDuplicateCommandFlow } from "./session-transport-conformance-fixtures"

for (const kind of ["stdio", "websocket"] as const) {
  describe(`${kind} duplicate command discipline`, () => {
    test("duplicate commandId is rejected and prior command events are replayed", async () => {
      const flow = await runDuplicateCommandFlow(kind)
      try {
        expect(flow.accepted).toEqual([`${kind}-dup-command`])
        expect(flow.seen).toEqual([
          {
            kind: "rejected",
            sessionId: "session-1",
            target: "command",
            reason: "duplicate_command",
            commandId: `${kind}-dup-command`,
          },
          { kind: "event", event: flow.appliedEvent },
        ])
      } finally {
        await flow.harness.close()
        await flow.bridge.close()
      }
    })
  })
}
