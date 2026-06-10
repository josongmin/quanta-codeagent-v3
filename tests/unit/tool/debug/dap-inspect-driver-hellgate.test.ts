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
const makeFakeAdapter = (opts: { neverStops?: boolean; failEvaluate?: boolean; stallStopped?: boolean; unverifiedBp?: boolean; failSetBreakpoints?: boolean } = {}) => {
  let toClient: ((chunk: string | Buffer) => void) | undefined
  let initialized = false
  let bpSet = false
  let deferredLaunchSeq: number | undefined // debugpy DEFERS the launch response
  const capturedVarRefs: number[] = [] // every variablesReference the driver queried
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
        // failSetBreakpoints models an adapter that ERRORS/times out on the
        // request (no `breakpoints` body) — distinct from a clean verified:false.
        if (opts.failSetBreakpoints) return respond(undefined, false, "setBreakpoints failed")
        // unverifiedBp models an adapter that can't bind the breakpoint (missing
        // debug info / source-path mismatch) → verified:false.
        respond({ breakpoints: [{ verified: opts.unverifiedBp !== true, line: 10 }] })
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
        // Two threads model a concurrency dump (dlv reports goroutines here).
        respond({ threads: [{ id: 1, name: "MainThread" }, { id: 2, name: "goroutine 2" }] })
        break
      case "stackTrace":
        // FOUR frames — real adapters give each frame DISTINCT scope/var refs.
        // The driver captures only the top MAX_FRAMES_WITH_LOCALS (3): the 4th
        // (<module>) must never have its scopes/vars queried.
        respond({
          stackFrames: [
            { id: 100, name: "compute", line: 10, source: { path: "/p/app.py" } },
            { id: 101, name: "helper", line: 20, source: { path: "/p/app.py" } },
            { id: 102, name: "caller", line: 30, source: { path: "/p/app.py" } },
            { id: 103, name: "<module>", line: 40 },
          ],
        })
        break
      case "scopes": {
        // Per-frame distinct refs (faithful to real adapters).
        const byFrame: Record<number, unknown[]> = {
          100: [{ name: "Locals", variablesReference: 1000 }, { name: "Globals", variablesReference: 9000 }],
          101: [{ name: "Locals", variablesReference: 2000 }],
          102: [{ name: "Locals", variablesReference: 3000 }],
          103: [{ name: "Locals", variablesReference: 4000 }], // never captured (frame cap)
        }
        respond({ scopes: byFrame[Number(req.arguments?.frameId)] ?? [] })
        break
      }
      case "variables": {
        // 1000 = compute Locals: `n` (scalar w/ type) + `acc` (aggregate w/ a
        // nested child ref → expansion). 1002 = acc's elements.
        const byRef: Record<number, unknown[]> = {
          1000: [
            { name: "n", value: "42", type: "int" },
            { name: "acc", value: "[1, 2]", type: "list", variablesReference: 1002 },
          ],
          1002: [{ name: "0", value: "1", type: "int" }, { name: "1", value: "2", type: "int" }],
          9000: [{ name: "__name__", value: "'__main__'" }],
          2000: [{ name: "x", value: "7", type: "int" }],
          3000: [{ name: "y", value: "3", type: "int" }],
          4000: [{ name: "z", value: "1" }], // never reached
        }
        capturedVarRefs.push(Number(req.arguments?.variablesReference))
        respond({ variables: byRef[Number(req.arguments?.variablesReference)] ?? [] })
        break
      }
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
  // Expose the queried-ref log for cap assertions (extra prop; harmless to
  // callers that just pass the transport to `new DapClient(...)`).
  return Object.assign(transport, { capturedVarRefs })
}

describe("inspectViaDap — full DAP launch+inspect handshake", () => {
  test("stops at a breakpoint and assembles stack + top-frame locals (w/ type)", async () => {
    const client = new DapClient(makeFakeAdapter())
    const r = await inspectViaDap(client, {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [{ file: "/p/app.py", line: 10 }],
    })
    expect(r.outcome).toBe("stopped")
    if (r.outcome !== "stopped") return
    expect(r.reason).toBe("breakpoint")
    expect(r.stack.map((f) => f.name)).toEqual(["compute", "helper", "caller", "<module>"])
    expect(r.stack[0]).toMatchObject({ name: "compute", line: 10 })
    // frames[0] is the stop frame; its Locals carry DAP `type` now.
    const top = r.frames[0]
    expect(top?.frame).toBe("compute")
    const locals = top?.scopes.find((s) => s.scope === "Locals")
    expect(locals?.vars.map((v) => ({ name: v.name, value: v.value, type: v.type }))).toEqual([
      { name: "n", value: "42", type: "int" },
      { name: "acc", value: "[1, 2]", type: "list" },
    ])
    // T-03: the thread/goroutine dump is captured (dlv reports goroutines here).
    expect(r.threads).toEqual([{ id: 1, name: "MainThread" }, { id: 2, name: "goroutine 2" }])
  })

  test("MULTI-FRAME: captures locals for the top K frames, caps deeper ones", async () => {
    const adapter = makeFakeAdapter()
    const client = new DapClient(adapter)
    const r = await inspectViaDap(client, {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [{ file: "/p/app.py", line: 10 }],
    })
    if (r.outcome !== "stopped") throw new Error(`expected stopped, got ${r.outcome}`)
    // The stack has 4 frames but only the top 3 (MAX_FRAMES_WITH_LOCALS) are
    // captured with scopes — the 4th (<module>) is NOT.
    expect(r.frames.map((f) => f.frame)).toEqual(["compute", "helper", "caller"])
    expect(r.frames[1]?.scopes.find((s) => s.scope === "Locals")?.vars.map((v) => v.name)).toEqual(["x"])
    expect(r.frames[2]?.scopes.find((s) => s.scope === "Locals")?.vars.map((v) => v.name)).toEqual(["y"])
    // red-on-injection: the 4th frame's variables (ref 4000) must NEVER be queried.
    expect((adapter as unknown as { capturedVarRefs: number[] }).capturedVarRefs).not.toContain(4000)
  })

  test("NESTED: an aggregate local expands its children one+ level deep", async () => {
    const client = new DapClient(makeFakeAdapter())
    const r = await inspectViaDap(client, {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [{ file: "/p/app.py", line: 10 }],
    })
    if (r.outcome !== "stopped") throw new Error(`expected stopped, got ${r.outcome}`)
    const acc = r.frames[0]?.scopes.find((s) => s.scope === "Locals")?.vars.find((v) => v.name === "acc")
    expect(acc?.type).toBe("list")
    expect(acc?.children?.map((c) => ({ name: c.name, value: c.value }))).toEqual([
      { name: "0", value: "1" },
      { name: "1", value: "2" },
    ])
    // a scalar local has no children.
    const n = r.frames[0]?.scopes.find((s) => s.scope === "Locals")?.vars.find((v) => v.name === "n")
    expect(n?.children).toBeUndefined()
  })

  test("unbound breakpoint (verified:false) + program exits ⇒ exited with breakpointsBound:false", async () => {
    const client = new DapClient(makeFakeAdapter({ neverStops: true, unverifiedBp: true }))
    const r = await inspectViaDap(client, {
      adapterID: "lldb",
      launch: { program: "/p/bin" },
      breakpoints: [{ file: "/p/x.rs", line: 4 }],
    })
    expect(r.outcome).toBe("exited")
    if (r.outcome === "exited") expect(r.breakpointsBound).toBe(false)
  })

  test("setBreakpoints FAILS (timeout/error) + exit ⇒ exited WITHOUT a false 'unbound' claim", async () => {
    // Adversarial-audit fix: if the adapter never gave a real setBreakpoints
    // response, we must NOT report breakpointsBound:false (that would blame the
    // binary/source when the real cause is an adapter fault).
    const client = new DapClient(makeFakeAdapter({ neverStops: true, failSetBreakpoints: true }))
    const r = await inspectViaDap(client, {
      adapterID: "lldb",
      launch: { program: "/p/bin" },
      breakpoints: [{ file: "/p/x.rs", line: 4 }],
    })
    expect(r.outcome).toBe("exited")
    if (r.outcome === "exited") expect(r.breakpointsBound).toBeUndefined()
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

/**
 * The variable-tree expansion is RESOURCE-bounded (breadth + depth), exactly
 * like a real debugger's lazy tree. This fake returns a deliberately wide +
 * deep structure; the assertions pin the caps so a regression that drops the
 * bounding (and lets a huge/cyclic graph explode the packet) goes red.
 */
const makeWideDeepAdapter = () => {
  let toClient: ((chunk: string | Buffer) => void) | undefined
  let initialized = false
  let bpSet = false
  let deferredLaunchSeq: number | undefined
  const decoder = new DapFrameDecoder()
  const send = (msg: unknown) => toClient?.(encodeDapMessage(msg))
  const handle = (req: { seq: number; command: string; arguments?: Record<string, unknown> }) => {
    const respondTo = (seq: number, command: string, body?: unknown, ok = true, message?: string) =>
      send({ type: "response", request_seq: seq, success: ok, command, ...(body !== undefined ? { body } : {}), ...(message ? { message } : {}) })
    const respond = (body?: unknown, ok = true, message?: string) => respondTo(req.seq, req.command, body, ok, message)
    switch (req.command) {
      case "initialize":
        respond({ supportsConfigurationDoneRequest: true })
        break
      case "launch":
        deferredLaunchSeq = req.seq
        initialized = true
        send({ type: "event", event: "initialized" })
        break
      case "setBreakpoints":
        if (!initialized) return respond(undefined, false, "before initialized")
        bpSet = true
        respond({ breakpoints: [{ verified: true, line: 1 }] })
        break
      case "configurationDone":
        if (!bpSet) return respond(undefined, false, "before breakpoints")
        respond()
        if (deferredLaunchSeq !== undefined) respondTo(deferredLaunchSeq, "launch")
        send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } })
        break
      case "threads":
        respond({ threads: [{ id: 1, name: "main" }] })
        break
      case "stackTrace":
        respond({ stackFrames: [{ id: 1, name: "f", line: 1, source: { path: "/p/x.py" } }] })
        break
      case "scopes":
        respond({ scopes: [{ name: "Locals", variablesReference: 500 }] })
        break
      case "variables": {
        const ref = Number(req.arguments?.variablesReference)
        // 500: `deep` (a 3-level chain) FIRST, then 20 scalars (21 total > the
        // breadth cap of 16). 600→601→602 is the depth chain.
        if (ref === 500) {
          const wide = Array.from({ length: 20 }, (_, i) => ({ name: `v${i}`, value: String(i) }))
          return respond({ variables: [{ name: "deep", value: "<obj>", variablesReference: 600 }, ...wide] })
        }
        if (ref === 600) return respond({ variables: [{ name: "a", value: "A", variablesReference: 601 }] })
        if (ref === 601) return respond({ variables: [{ name: "b", value: "B", variablesReference: 602 }] })
        if (ref === 602) return respond({ variables: [{ name: "c", value: "C" }] })
        return respond({ variables: [] })
      }
      case "terminate":
      case "disconnect":
        respond()
        send({ type: "event", event: "terminated", body: {} })
        break
      default:
        respond(undefined, false, `unknown ${req.command}`)
    }
  }
  const transport: DapTransport = {
    send: (data) => {
      for (const m of decoder.push(data)) handle(m as { seq: number; command: string; arguments?: Record<string, unknown> })
    },
    onData: (cb) => {
      toClient = cb
    },
    close: () => {},
  }
  return transport
}

describe("inspectViaDap — bounded variable-tree expansion", () => {
  test("BREADTH cap: a node with 21 children surfaces at most MAX_CHILDREN_PER_VAR (16)", async () => {
    const client = new DapClient(makeWideDeepAdapter())
    const r = await inspectViaDap(client, { adapterID: "python", launch: { program: "/p/x.py" }, breakpoints: [{ file: "/p/x.py", line: 1 }] })
    if (r.outcome !== "stopped") throw new Error(`expected stopped, got ${r.outcome}`)
    const vars = r.frames[0]?.scopes.find((s) => s.scope === "Locals")?.vars ?? []
    expect(vars.length).toBe(16)
    // `deep` was first, so it's kept; the tail scalars (v15..v19) are dropped.
    expect(vars.map((v) => v.name)).toContain("deep")
    expect(vars.map((v) => v.name)).not.toContain("v19")
  })

  test("DEPTH cap: nesting expands to MAX_VAR_DEPTH (2) levels, then stops", async () => {
    const client = new DapClient(makeWideDeepAdapter())
    const r = await inspectViaDap(client, { adapterID: "python", launch: { program: "/p/x.py" }, breakpoints: [{ file: "/p/x.py", line: 1 }] })
    if (r.outcome !== "stopped") throw new Error(`expected stopped, got ${r.outcome}`)
    const deep = r.frames[0]?.scopes.find((s) => s.scope === "Locals")?.vars.find((v) => v.name === "deep")
    // Level 1: deep → [a]. Level 2 would be a → [b], but the depth cap stops it:
    // `a` is materialized as a leaf (no further children), and `c` never appears.
    const a = deep?.children?.find((c) => c.name === "a")
    expect(a).toBeDefined()
    expect(a?.children).toBeUndefined()
  })
})

/**
 * Exception-aware capture (T-01): a fake that, when `exceptionFilters` are
 * requested, records them, stops with reason "exception", and answers
 * `exceptionInfo` — so the driver must call setExceptionBreakpoints in the
 * config phase and fold the exception type/message into the Inspection.
 * red-on-injection: drop the setExceptionBreakpoints call ⇒ filters unseen.
 */
const makeExceptionAdapter = () => {
  let toClient: ((c: string | Buffer) => void) | undefined
  let initialized = false
  let deferredLaunchSeq: number | undefined
  let excFilters: unknown
  const dec = new DapFrameDecoder()
  const send = (m: unknown) => toClient?.(encodeDapMessage(m))
  const handle = (req: { seq: number; command: string; arguments?: Record<string, unknown> }) => {
    const respondTo = (seq: number, command: string, body?: unknown, ok = true) => send({ type: "response", request_seq: seq, success: ok, command, ...(body !== undefined ? { body } : {}) })
    const respond = (body?: unknown) => respondTo(req.seq, req.command, body)
    switch (req.command) {
      case "initialize": respond({ supportsConfigurationDoneRequest: true, supportsExceptionInfoRequest: true }); break
      case "launch": deferredLaunchSeq = req.seq; initialized = true; send({ type: "event", event: "initialized" }); break
      case "setExceptionBreakpoints": excFilters = req.arguments?.filters; respond({}); break
      case "setBreakpoints": initialized ? respond({ breakpoints: [{ verified: true, line: 10 }] }) : respondTo(req.seq, req.command, undefined, false); break
      case "configurationDone":
        respond()
        if (deferredLaunchSeq !== undefined) respondTo(deferredLaunchSeq, "launch")
        send({ type: "event", event: "stopped", body: { reason: "exception", threadId: 1, text: "RuntimeError" } })
        break
      case "threads": respond({ threads: [{ id: 1, name: "MainThread" }] }); break
      case "stackTrace": respond({ stackFrames: [{ id: 100, name: "boom", line: 12, source: { path: "/p/app.py" } }] }); break
      case "scopes": respond({ scopes: [{ name: "Locals", variablesReference: 1000 }] }); break
      case "variables": respond({ variables: [{ name: "n", value: "0", type: "int" }] }); break
      case "exceptionInfo": respond({ exceptionId: "RuntimeError", description: "boom: division by zero", breakMode: "unhandled" }); break
      case "terminate": case "disconnect": respond(); send({ type: "event", event: "terminated", body: {} }); break
      default: respondTo(req.seq, req.command, undefined, false)
    }
  }
  const transport: DapTransport = {
    send: (data) => { for (const m of dec.push(data)) handle(m as { seq: number; command: string; arguments?: Record<string, unknown> }) },
    onData: (cb) => { toClient = cb },
    close: () => {},
  }
  return Object.assign(transport, { getFilters: () => excFilters })
}

describe("inspectViaDap — exception-aware capture (T-01)", () => {
  test("requests setExceptionBreakpoints, stops on the throw, captures type+message", async () => {
    const adapter = makeExceptionAdapter()
    const r = await inspectViaDap(new DapClient(adapter), {
      adapterID: "python",
      launch: { program: "/p/app.py" },
      breakpoints: [],
      exceptionFilters: ["uncaught", "userUnhandled"],
    })
    // The driver MUST have set the exception filters in the config phase.
    expect((adapter as unknown as { getFilters(): unknown }).getFilters()).toEqual(["uncaught", "userUnhandled"])
    expect(r.outcome).toBe("stopped")
    if (r.outcome !== "stopped") return
    expect(r.reason).toBe("exception")
    // The exception type + message rode into the Inspection.
    expect(r.exception).toEqual({ id: "RuntimeError", description: "boom: division by zero" })
    expect(r.frames[0]?.frame).toBe("boom")
  })
})
