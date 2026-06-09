/**
 * W5 hellgate — `debug_inspect` end-to-end through a FAKE DebugAdapterPort whose
 * transport speaks the real DAP launch handshake. Proves the whole stack
 * (port.spawn → DapClient → inspectViaDap → render) and the failure modes
 * (spawn fault / unknown adapter) collapse to ok:false without throwing.
 */
import { describe, expect, test } from "bun:test"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"
import type { DapTransport } from "@/tool/debug/dap-client"
import type { DebugAdapterPort } from "@/tool/debug/port"
import { makeDebugInspectTool } from "@/tool/debug/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/** Scripted fake adapter (same DAP choreography as a real debugpy session). */
const fakeAdapterTransport = (): DapTransport => {
  let toClient: ((chunk: string | Buffer) => void) | undefined
  let initialized = false
  let bpSet = false
  let deferredLaunchSeq: number | undefined
  const dec = new DapFrameDecoder()
  const send = (m: unknown) => toClient?.(encodeDapMessage(m))
  return {
    send: (data) => {
      for (const raw of dec.push(data)) {
        const req = raw as { seq: number; command: string; arguments?: Record<string, unknown> }
        const respondTo = (seq: number, command: string, body?: unknown, ok = true, message?: string) =>
          send({ type: "response", request_seq: seq, success: ok, command, ...(body !== undefined ? { body } : {}), ...(message ? { message } : {}) })
        const respond = (body?: unknown, ok = true, message?: string) => respondTo(req.seq, req.command, body, ok, message)
        switch (req.command) {
          // Faithful to real debugpy: launch response DEFERRED until configurationDone.
          case "initialize": respond({ supportsConfigurationDoneRequest: true }); break
          case "launch": deferredLaunchSeq = req.seq; initialized = true; send({ type: "event", event: "initialized" }); break
          case "setBreakpoints": initialized ? (bpSet = true, respond({ breakpoints: [{ verified: true }] })) : respond(undefined, false, "too early"); break
          case "configurationDone":
            if (!bpSet) { respond(undefined, false, "no bp"); break }
            respond()
            if (deferredLaunchSeq !== undefined) respondTo(deferredLaunchSeq, "launch")
            send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } })
            break
          case "threads": respond({ threads: [{ id: 1, name: "main" }] }); break
          case "stackTrace": respond({ stackFrames: [{ id: 7, name: "foo", line: 5, source: { path: "/w/x.py" } }] }); break
          case "scopes": respond({ scopes: [{ name: "Locals", variablesReference: 9 }] }); break
          case "variables": respond({ variables: [{ name: "y", value: "7" }] }); break
          case "terminate": respond(); send({ type: "event", event: "terminated", body: {} }); break
          default: respond(undefined, false, `?${req.command}`)
        }
      }
    },
    onData: (cb) => { toClient = cb },
    close: () => {},
  }
}

const fakePort = (t: DapTransport | (() => never)): DebugAdapterPort => ({
  spawn: async () => (typeof t === "function" ? t() : t),
})

const ctx = (): ToolContext => ({ cwd: "/w", signal: new AbortController().signal }) as ToolContext
const run = async (tool: ReturnType<typeof makeDebugInspectTool>, input: object): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") last = ev.result
  if (last === undefined) throw new Error("no result")
  return last
}

describe("debug_inspect — full-stack hellgate", () => {
  test("stops at a breakpoint and renders stack + locals", async () => {
    const tool = makeDebugInspectTool(fakePort(fakeAdapterTransport()))
    const r = await run(tool, { program: "/w/x.py", adapter: "python", breakpoints: [{ file: "/w/x.py", line: 5 }] })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Stopped (breakpoint)")
    expect(r.output).toContain("foo (/w/x.py:5)")
    expect(r.output).toContain("y = 7")
  })

  test("metadata: always-confirm tier (executes user code) + not read-only", () => {
    const tool = makeDebugInspectTool(fakePort(fakeAdapterTransport()))
    expect(tool.hitlTier?.({} as never)).toBe("always-confirm")
    expect(tool.isReadOnly?.()).toBe(false)
  })

  test("no adapter and no adapterCommand ⇒ ok:false (no spawn)", async () => {
    let spawned = false
    const port: DebugAdapterPort = { spawn: async () => { spawned = true; return fakeAdapterTransport() } }
    const r = await run(makeDebugInspectTool(port), { program: "/w/x.py", breakpoints: [{ file: "/w/x.py", line: 5 }] })
    expect(r.ok).toBe(false)
    expect(spawned).toBe(false)
  })

  test("spawn fault ⇒ ok:false, never throws", async () => {
    const port = fakePort((): never => { throw new Error("debugpy not found") })
    const r = await run(makeDebugInspectTool(port), { program: "/w/x.py", adapter: "python", breakpoints: [{ file: "/w/x.py", line: 5 }] })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("debugpy not found")
  })

  test("aborted before start ⇒ ok:false", async () => {
    const tool = makeDebugInspectTool(fakePort(fakeAdapterTransport()))
    let last: ToolResult | undefined
    const aborted = { cwd: "/w", signal: AbortSignal.abort() } as ToolContext
    for await (const ev of tool.execute({ program: "/w/x.py", adapter: "python", breakpoints: [{ file: "/w/x.py", line: 5 }] } as never, aborted) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") last = ev.result
    expect(last?.ok).toBe(false)
  })
})
