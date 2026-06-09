/**
 * W5 DAP — `inspectViaDap` handshake driver, end-to-end through a FAKE debug
 * adapter that speaks the REAL DAP launch sequence (initialize → initialized
 * event → setBreakpoints → configurationDone → stopped event → threads →
 * stackTrace → scopes → variables → terminate → terminated event). This is the
 * hellgate: the driver must issue the canonical sequence, react to async events
 * in the right order, and assemble the inspection. red-on-injection: scrambling
 * the order (e.g. setBreakpoints before `initialized`) makes the fake reply with
 * an error and the assertion fails.
 */
import { describe, expect, test } from "bun:test"
import { DapClient, type DapTransport } from "@/tool/debug/dap-client"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"
import { inspectViaDap } from "@/tool/debug/inspect-driver"

/**
 * A scripted fake debug adapter. Tracks handshake order and breakpoints; on
 * `configurationDone` it emits a `stopped` event (breakpoint hit) UNLESS
 * `neverStops` is set (then it `terminated` — program ran to completion).
 */
const makeFakeAdapter = (opts: { neverStops?: boolean; failEvaluate?: boolean; stallStopped?: boolean } = {}) => {
  let toClient: ((chunk: string | Buffer) => void) | undefined
  let initialized = false
  let bpSet = false
  let deferredLaunchSeq: number | undefined // debugpy DEFERS the launch response
  const decoder = new DapFrameDecoder()
  const send = (msg: unknown) => toClient?.(encodeDapMessage(msg))

  const handle = (req: { seq: number; command: string; arguments?: Record<string, unknown> }) => {
    const respondTo = (seq: number, command: string, body?: unknown, ok = true, message?: string) =>
      send({ type: "response", request_seq: seq, success: ok, command, ...(body !== undefined ? { body } : {}), ...(message ? { message } : {}) })
    const respond = (body?: unknown, ok = true, message?: string) => respondTo(req.seq, req.command, body, ok, message)
    switch (req.command) {
      case "initialize":
        // Faithful to real debugpy: NO `initialized` event until launch arrives,
        // and the launch RESPONSE is deferred until configurationDone.
        respond({ supportsConfigurationDoneRequest: true })
        break
      case "launch":
        deferredLaunchSeq = req.seq // do NOT respond yet (red-on-injection: an
        // `await launch` driver deadlocks here — exactly the real-debugpy bug)
        initialized = true
        send({ type: "event", event: "initialized" }) // launch makes adapter config-ready
        break
      case "setBreakpoints":
        if (!initialized) return respond(undefined, false, "setBreakpoints before initialized")
        bpSet = true
        respond({ breakpoints: [{ verified: true, line: 10 }] })
        break
      case "configurationDone":
        if (!bpSet) return respond(undefined, false, "configurationDone before breakpoints")
        respond()
        if (deferredLaunchSeq !== undefined) respondTo(deferredLaunchSeq, "launch") // NOW the launch resp
        if (opts.stallStopped) break // emit neither stopped nor terminated (hang unless aborted)
        if (opts.neverStops) send({ type: "event", event: "terminated", body: {} })
        else send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } })
        break
      case "threads":
        respond({ threads: [{ id: 1, name: "MainThread" }] })
        break
      case "stackTrace":
        respond({ stackFrames: [{ id: 100, name: "compute", line: 10, source: { path: "/p/app.py" } }, { id: 101, name: "<module>", line: 20 }] })
        break
      case "scopes":
        respond({ scopes: [{ name: "Locals", variablesReference: 1000 }, { name: "Globals", variablesReference: 1001 }] })
        break
      case "variables":
        respond({ variables: req.arguments?.variablesReference === 1000 ? [{ name: "n", value: "42" }, { name: "acc", value: "[1, 2]" }] : [{ name: "__name__", value: "'__main__'" }] })
        break
      case "evaluate":
        if (opts.failEvaluate) return respond(undefined, false, "not available")
        respond({ result: "84", variablesReference: 0 })
        break
      case "terminate":
      case "disconnect":
        respond()
        send({ type: "event", event: "terminated", body: {} })
        break
      default:
        respond(undefined, false, `unknown command ${req.command}`)
    }
  }

  const transport: DapTransport = {
    send: (data) => {
      for (const m of decoder.push(data)) {
        handle(m as { seq: number; command: string; arguments?: Record<string, unknown> })
      }
    },
    onData: (cb) => {
      toClient = cb
    },
    close: () => {},
  }
  return transport
}

describe("inspectViaDap — full DAP launch+inspect handshake", () => {
  test("stops at a breakpoint and assembles stack + locals", async () => {
    const client = new DapClient(makeFakeAdapter())
    const r = await inspectViaDap(client, {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [{ file: "/p/app.py", line: 10 }],
    })
    expect(r.outcome).toBe("stopped")
    if (r.outcome !== "stopped") return
    expect(r.reason).toBe("breakpoint")
    expect(r.stack.map((f) => f.name)).toEqual(["compute", "<module>"])
    expect(r.stack[0]).toMatchObject({ name: "compute", line: 10 })
    const locals = r.variables.find((s) => s.scope === "Locals")
    expect(locals?.vars).toEqual([{ name: "n", value: "42" }, { name: "acc", value: "[1, 2]" }])
  })

  test("program that never hits a breakpoint ⇒ exited outcome (not a hang)", async () => {
    const client = new DapClient(makeFakeAdapter({ neverStops: true }))
    const r = await inspectViaDap(client, {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [{ file: "/p/app.py", line: 999 }],
    })
    expect(r.outcome).toBe("exited")
  })

  test("a failed initialize ⇒ error outcome, no throw", async () => {
    // Transport whose adapter rejects initialize.
    const transport: DapTransport = {
      send: (data) => {
        const dec = new DapFrameDecoder()
        for (const m of dec.push(data)) {
          const req = m as { seq: number; command: string }
          if (req.command === "initialize") cb?.(encodeDapMessage({ type: "response", request_seq: req.seq, success: false, command: "initialize", message: "adapter boot failed" }))
        }
      },
      onData: (c) => {
        cb = c
      },
      close: () => {},
    }
    let cb: ((chunk: string | Buffer) => void) | undefined
    const client = new DapClient(transport)
    const r = await inspectViaDap(client, { adapterID: "python", launch: {}, breakpoints: [] })
    expect(r.outcome).toBe("error")
  })

  test("ABORT mid-inspect ⇒ error outcome promptly (no wait for the stop timeout)", async () => {
    // Adapter that initializes but NEVER stops (no breakpoint event) — without
    // abort the driver would block until stopTimeoutMs.
    const client = new DapClient(makeFakeAdapter({ neverStops: false, stallStopped: true }))
    const ac = new AbortController()
    const p = inspectViaDap(
      client,
      { adapterID: "python", launch: { program: "/p/app.py" }, breakpoints: [{ file: "/p/app.py", line: 10 }] },
      { stopTimeoutMs: 60_000, signal: ac.signal },
    )
    ac.abort()
    const r = await p
    expect(r.outcome).toBe("error")
    if (r.outcome === "error") expect(r.message).toMatch(/abort/i)
  })

  test("optional evaluate expression is included when provided and succeeds", async () => {
    const client = new DapClient(makeFakeAdapter())
    const r = await inspectViaDap(client, {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [{ file: "/p/app.py", line: 10 }],
      evaluate: "n * 2",
    })
    expect(r.outcome).toBe("stopped")
    if (r.outcome !== "stopped") return
    expect(r.evaluated).toEqual({ expression: "n * 2", result: "84" })
  })
})
