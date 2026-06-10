/**
 * W5 — `inspectViaCdp` (the NODE/CDP runtime driver), end-to-end through a FAKE
 * inspector that speaks the REAL CDP sequence: Runtime.enable → Debugger.enable
 * → setBreakpointByUrl → runIfWaitingForDebugger → (ENTRY pause, resumed past) →
 * Debugger.paused@bp → getProperties[*]. The hellgate: the driver must issue the
 * sequence, skip the --inspect-brk entry pause, capture top-K frames + nested
 * locals, and assemble the SAME Inspection shape as the DAP driver.
 *
 * red-on-injection: the fake emits `Debugger.paused` SYNCHRONOUSLY in response to
 * the trigger — so if the driver armed the waiter AFTER the trigger (the race),
 * the pause is missed and the test times out → red.
 */
import { describe, expect, spyOn, test } from "bun:test"
import { logger } from "@/shared"
import { CdpClient, type CdpTransport } from "@/tool/debug/cdp-client"
import { inspectViaCdp } from "@/tool/debug/cdp-inspect"

interface FakeOpts {
  /** Emit the real bp pause? false ⇒ program "completes" (no paused) ⇒ exited. */
  readonly stopsAtBp?: boolean
  /** setBreakpointByUrl returns no locations ⇒ unbound. */
  readonly unbound?: boolean
  /** Throw from `transport.send` on the TEARDOWN resume (the 2nd `Debugger.resume`,
   *  issued during best-effort cleanup) so `client.request` REJECTS — exercises
   *  the attributed-swallow path (jun-10 silent-failure audit mirror of
   *  inspect-driver's terminate swallow). */
  readonly throwOnTeardownResume?: boolean
}

const REAL_PAUSE = {
  reason: "other",
  hitBreakpoints: ["bp1"],
  callFrames: [
    {
      callFrameId: "0",
      functionName: "fails",
      url: "file:///t/m.test.mjs",
      location: { lineNumber: 6 }, // 0-based ⇒ reported as line 7
      scopeChain: [
        { type: "local", object: { objectId: "local-0" } },
        { type: "closure", object: { objectId: "clo-0" } },
        { type: "global", object: { objectId: "glob-0" } }, // must be IGNORED
      ],
    },
    {
      callFrameId: "1",
      functionName: "", // anonymous
      url: "file:///t/m.test.mjs",
      location: { lineNumber: 2 }, // ⇒ line 3
      scopeChain: [{ type: "local", object: { objectId: "local-1" } }],
    },
  ],
}

const PROPS: Record<string, unknown[]> = {
  "local-0": [
    { name: "result", value: { type: "number", value: 10 } },
    { name: "acc", value: { type: "object", subtype: "array", className: "Array", description: "Array(2)", objectId: "arr-0" } },
  ],
  "arr-0": [
    { name: "0", value: { type: "number", value: 1 } },
    { name: "1", value: { type: "number", value: 2 } },
    { name: "length", value: { type: "number", value: 2 } },
  ],
  "clo-0": [{ name: "helper", value: { type: "function", className: "Function", description: "function helper()", objectId: "fn-0" } }],
  "glob-0": [{ name: "process", value: { type: "object", className: "process", objectId: "p-0" } }],
  "local-1": [{ name: "x", value: { type: "number", value: 7 } }],
}

const makeFakeInspector = (opts: FakeOpts = {}): CdpTransport => {
  let toClient: ((m: string) => void) | undefined
  let resumesSeen = 0
  const send = (msg: unknown) => toClient?.(JSON.stringify(msg))
  const handle = (req: { id: number; method: string; params?: Record<string, unknown> }) => {
    const reply = (result: unknown) => send({ id: req.id, result })
    switch (req.method) {
      case "Runtime.enable":
      case "Debugger.enable":
        reply({})
        break
      case "Debugger.setBreakpointByUrl":
        reply({ breakpointId: "bp1", locations: opts.unbound ? [] : [{ scriptId: "7", lineNumber: 6, columnNumber: 0 }] })
        break
      case "Runtime.runIfWaitingForDebugger":
        reply({})
        // The --inspect-brk ENTRY pause (not our bp) — driver must resume past it.
        if (opts.stopsAtBp !== false) send({ method: "Debugger.paused", params: { reason: "Break on start", hitBreakpoints: [], callFrames: [] } })
        break
      case "Debugger.resume":
        // The 2nd resume is the best-effort TEARDOWN resume. Throwing here makes
        // `transport.send` (and thus `client.request`) reject, driving the
        // attributed-swallow path.
        if (opts.throwOnTeardownResume === true && resumesSeen >= 1) {
          throw new Error("cdp: socket closed during teardown resume")
        }
        reply({})
        resumesSeen++
        // First resume (past the entry pause) ⇒ emit the REAL bp pause.
        if (resumesSeen === 1 && opts.stopsAtBp !== false) send({ method: "Debugger.paused", params: REAL_PAUSE })
        break
      case "Runtime.getProperties":
        reply({ result: PROPS[String(req.params?.objectId)] ?? [] })
        break
      default:
        reply({})
    }
  }
  return {
    send: (data) => handle(JSON.parse(data)),
    onData: (cb) => {
      toClient = cb
    },
    close: () => {},
  }
}

describe("inspectViaCdp — full CDP launch+inspect handshake (node)", () => {
  test("skips the entry pause, stops at the bp, assembles multi-frame locals + types", async () => {
    const r = await inspectViaCdp(new CdpClient(makeFakeInspector()), { url: "file:///t/m.test.mjs", line: 7 })
    expect(r.outcome).toBe("stopped")
    if (r.outcome !== "stopped") return
    // Stack: CDP 0-based lines ⇒ 1-based; anonymous frame named.
    expect(r.stack.map((f) => f.name)).toEqual(["fails", "(anonymous)"])
    expect(r.stack[0]).toMatchObject({ name: "fails", line: 7 })
    // MULTI-FRAME: top 2 frames captured (only 2 in the stack).
    expect(r.frames.map((f) => f.frame)).toEqual(["fails", "(anonymous)"])
    // frame 0 Locals: result (number) + acc; global scope IGNORED.
    const locals0 = r.frames[0]?.scopes.find((s) => s.scope === "Locals")
    const result = locals0?.vars.find((v) => v.name === "result")
    expect(result).toMatchObject({ value: "10", type: "number" })
    expect(locals0?.vars.map((v) => v.name)).not.toContain("process") // global excluded
    // NESTED: the array's elements are expanded one level (type Array).
    const acc = locals0?.vars.find((v) => v.name === "acc")
    expect(acc?.type).toBe("Array")
    expect(acc?.children?.map((c) => ({ name: c.name, value: c.value }))).toEqual([
      { name: "0", value: "1" },
      { name: "1", value: "2" },
      { name: "length", value: "2" },
    ])
    // closure scope captured separately.
    expect(r.frames[0]?.scopes.find((s) => s.scope === "Closure")?.vars.map((v) => v.name)).toEqual(["helper"])
    // frame 1 (caller) locals.
    expect(r.frames[1]?.scopes.find((s) => s.scope === "Locals")?.vars).toEqual([{ name: "x", value: "7", type: "number" }])
  })

  test("rejecting teardown resume ⇒ inspection still completes AND a labelled debug line fires (not swallowed)", async () => {
    // jun-10 silent-failure audit: the best-effort teardown `Debugger.resume`
    // used to `.catch(() => {})` — a rejection (e.g. socket closed mid-teardown)
    // vanished. It now attributes via logger.debug. red-on-injection: revert the
    // src to `.catch(() => {})` and the debug-line assertion goes red while the
    // outcome assertion stays green.
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      const r = await inspectViaCdp(new CdpClient(makeFakeInspector({ throwOnTeardownResume: true })), {
        url: "file:///t/m.test.mjs",
        line: 7,
      })
      // Cleanup completed despite the rejecting resume — the result still lands.
      expect(r.outcome).toBe("stopped")
      // The swallow is now VISIBLE: a stable-labelled debug line fired.
      const fired = debugSpy.mock.calls.some((c) =>
        String(c[0]).includes("cdp-inspect: best-effort Debugger.resume failed"),
      )
      expect(fired).toBe(true)
    } finally {
      debugSpy.mockRestore()
    }
  })

  test("breakpoint never hit (program completes) ⇒ exited, not a hang", async () => {
    const r = await inspectViaCdp(new CdpClient(makeFakeInspector({ stopsAtBp: false })), { url: "file:///t/m.test.mjs", line: 7 }, { stopTimeoutMs: 300 })
    expect(r.outcome).toBe("exited")
  })

  test("unbound breakpoint + completes ⇒ exited with breakpointsBound:false", async () => {
    const r = await inspectViaCdp(new CdpClient(makeFakeInspector({ stopsAtBp: false, unbound: true })), { url: "file:///t/m.test.mjs", line: 7 }, { stopTimeoutMs: 300 })
    expect(r.outcome).toBe("exited")
    if (r.outcome === "exited") expect(r.breakpointsBound).toBe(false)
  })

  test("ABORT mid-inspect ⇒ error outcome promptly", async () => {
    const ac = new AbortController()
    const p = inspectViaCdp(new CdpClient(makeFakeInspector({ stopsAtBp: false })), { url: "file:///t/m.test.mjs", line: 7 }, { stopTimeoutMs: 60_000, signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.outcome).toBe("error")
    if (r.outcome === "error") expect(r.message).toMatch(/abort/i)
  })
})

/**
 * Exception-aware capture (T-01, CDP): a fake that, when `pauseOnExceptions` is
 * requested, records the state and pauses with reason "exception" (NO
 * hitBreakpoints — so the driver must break on the REASON, not just our bp id)
 * carrying the thrown error's RemoteObject in `data`.
 */
const makeExceptionInspector = (): CdpTransport & { state: () => unknown } => {
  let toClient: ((m: string) => void) | undefined
  let resumes = 0
  let pauseState: unknown
  const send = (m: unknown) => toClient?.(JSON.stringify(m))
  const t: CdpTransport = {
    send: (data) => {
      const req = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
      const reply = (result: unknown) => send({ id: req.id, result })
      switch (req.method) {
        case "Debugger.setPauseOnExceptions": pauseState = req.params?.state; reply({}); break
        case "Debugger.setBreakpointByUrl": reply({ breakpointId: "bp1", locations: [{ scriptId: "1", lineNumber: 4 }] }); break
        case "Runtime.runIfWaitingForDebugger": reply({}); send({ method: "Debugger.paused", params: { reason: "Break on start", hitBreakpoints: [], callFrames: [] } }); break
        case "Debugger.resume":
          reply({}); resumes++
          if (resumes === 1)
            send({ method: "Debugger.paused", params: { reason: "exception", hitBreakpoints: [], data: { type: "object", subtype: "error", className: "TypeError", description: "TypeError: x is not a function\n    at boom (file:///t/m.mjs:5:3)" }, callFrames: [{ callFrameId: "0", functionName: "boom", url: "file:///t/m.mjs", location: { lineNumber: 4 }, scopeChain: [{ type: "local", object: { objectId: "L0" } }] }] } })
          break
        case "Runtime.getProperties": reply({ result: String(req.params?.objectId) === "L0" ? [{ name: "x", value: { type: "undefined" } }] : [] }); break
        default: reply({})
      }
    },
    onData: (cb) => { toClient = cb },
    close: () => {},
  }
  return Object.assign(t, { state: () => pauseState })
}

describe("inspectViaCdp — exception-aware capture (T-01)", () => {
  test("sets pauseOnExceptions, stops on the THROW (no bp hit), captures type+message", async () => {
    const adapter = makeExceptionInspector()
    const r = await inspectViaCdp(new CdpClient(adapter), { url: "file:///t/m.mjs", line: 99, pauseOnExceptions: "uncaught" })
    expect(adapter.state()).toBe("uncaught") // driver armed exception pausing
    expect(r.outcome).toBe("stopped")
    if (r.outcome !== "stopped") return
    expect(r.reason).toBe("exception")
    // type = className, description = first line of the error description.
    expect(r.exception).toEqual({ id: "TypeError", description: "TypeError: x is not a function" })
    expect(r.frames[0]?.frame).toBe("boom")
  })
})
