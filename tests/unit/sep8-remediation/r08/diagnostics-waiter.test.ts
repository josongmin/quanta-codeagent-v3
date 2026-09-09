import { describe, expect, test } from "bun:test"
import { DiagnosticsHub } from "@/lsp/adapters/base/diagnostics-hub"

const URI = "file:///work/a.ts"
const raw = {
  uri: URI,
  diagnostics: [
    {
      message: "used",
      severity: 1,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
  ],
}

describe("C-F12 diagnostics waiter identity", () => {
  test("repeated timeouts leave zero retained callbacks/keys", async () => {
    const hub = new DiagnosticsHub(15)
    for (let i = 0; i < 4; i++) {
      const diags = await hub.waitForDiagnostics(URI)
      expect(diags).toEqual([])
    }
    expect(hub.diagnosticsWaiters.size).toBe(0)
  })

  test("timeout drops only self; sibling waiter still receives late publish", async () => {
    const hub = new DiagnosticsHub(25)
    const timedOut = hub.waitForDiagnostics(URI)
    await Bun.sleep(5)
    const live = hub.waitForDiagnostics(URI)
    await expect(timedOut).resolves.toEqual([])
    expect(hub.diagnosticsWaiters.get(URI)?.length).toBe(1)
    hub.onPublishDiagnostics(raw)
    const got = await live
    expect(got).toHaveLength(1)
    expect(got[0]?.message).toBe("used")
    expect(hub.diagnosticsWaiters.size).toBe(0)
  })

  test("publish-timeout-dispose race does not double-settle or leak timers", async () => {
    const hub = new DiagnosticsHub(20)
    const p = hub.waitForDiagnostics(URI)
    hub.failAll()
    await expect(p).resolves.toEqual([])
    expect(hub.diagnosticsWaiters.size).toBe(0)
    hub.onPublishDiagnostics(raw)
    await Bun.sleep(30)
    expect(hub.diagnosticsWaiters.size).toBe(0)
  })

  test("clear settles waiters immediately instead of waiting for timeout", async () => {
    const hub = new DiagnosticsHub(5_000)
    const p = hub.waitForDiagnostics(URI)
    hub.clear()
    await expect(p).resolves.toEqual([])
    expect(hub.diagnosticsWaiters.size).toBe(0)
  })
})
