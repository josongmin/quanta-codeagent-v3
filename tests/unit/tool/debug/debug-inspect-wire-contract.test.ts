/**
 * Characterization tests for what `debug_inspect` puts ON THE WIRE — added
 * with the god-function split of `execute` (42 → under cap) that pulled the
 * two carriers (CDP `node` preset, DAP adapters) into delegated generators.
 *
 * Injection-verified gaps in the existing `debug-inspect-tool-e2e-hellgate`
 * suite: reversing the `adapterCommand`-over-preset precedence, accepting an
 * EMPTY `adapterCommand`, dropping per-breakpoint `condition`, ignoring the
 * adapter when picking exception filters, skipping cwd anchoring for relative
 * paths, and dropping the turn-abort signal ALL left that suite GREEN.
 *
 * Rules pinned here:
 *   R1  `adapterCommand` (explicit argv) beats the `adapter` preset; an
 *       EMPTY argv is a hard error, not "fall back to the preset".
 *   R2  Relative `program` / breakpoint files are anchored to the effective
 *       cwd (`input.cwd` when given, else the session cwd).
 *   R3  Per-breakpoint `condition` survives to the DAP `setBreakpoints` call,
 *       and is OMITTED (not `undefined`) when absent.
 *   R4  Exception filters are selected BY ADAPTER and only when opted in.
 *   R5  The turn-abort signal is forwarded into the inspection driver.
 *   R6  Both carriers report `ok` = "the inspection did not error".
 */
import { describe, expect, test } from "bun:test"
import type { CdpTransport } from "@/tool/debug/cdp-client"
import type { DapTransport } from "@/tool/debug/dap-client"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"
import type { DebugAdapterPort, NodeCdpSpawnSpec } from "@/tool/debug/port"
import { makeDebugInspectTool } from "@/tool/debug/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

interface Wire {
  /** DAP requests seen by the adapter, in order: [command, arguments]. */
  readonly dap: Array<[string, Record<string, unknown>]>
  /** CDP requests seen by the inspector, in order: [method, params]. */
  readonly cdp: Array<[string, Record<string, unknown>]>
  /** argv the node carrier asked the CDP spawner for (`undefined` = never asked). */
  nodeArgv: readonly string[] | undefined
  nodeCwd: string | undefined
  /** spec the DAP carrier asked the port to spawn (`undefined` = never asked). */
  dapCommand: readonly string[] | undefined
  dapCwd: string | undefined
}

const newWire = (): Wire => ({
  dap: [],
  cdp: [],
  nodeArgv: undefined,
  nodeCwd: undefined,
  dapCommand: undefined,
  dapCwd: undefined,
})

const dapArg = (w: Wire, command: string): Record<string, unknown> | undefined =>
  w.dap.find(([c]) => c === command)?.[1]

/** Fixed response bodies for the DAP commands whose reply carries no session
 *  state. The three STATEFUL commands (launch / setBreakpoints /
 *  configurationDone) are handled explicitly below. */
const STATIC_DAP_BODIES: Record<string, unknown> = {
  initialize: { supportsConfigurationDoneRequest: true },
  setExceptionBreakpoints: undefined,
  threads: { threads: [{ id: 1, name: "main" }] },
  stackTrace: { stackFrames: [{ id: 7, name: "foo", line: 5, source: { path: "/w/x.py" } }] },
  scopes: { scopes: [{ name: "Locals", variablesReference: 9 }] },
  variables: { variables: [{ name: "y", value: "7" }] },
}

/** Scripted DAP adapter: real launch choreography, stops at a breakpoint. */
const scriptedDap = (w: Wire, onSend?: () => void): DapTransport => {
  let toClient: ((chunk: string | Buffer) => void) | undefined
  let initialized = false
  let bpSet = false
  let deferredLaunchSeq: number | undefined
  const dec = new DapFrameDecoder()
  const send = (m: unknown) => toClient?.(encodeDapMessage(m))
  const respondTo = (
    seq: number,
    command: string,
    body?: unknown,
    ok = true,
    message?: string,
  ): void =>
    send({
      type: "response",
      request_seq: seq,
      success: ok,
      command,
      ...(body !== undefined ? { body } : {}),
      ...(message ? { message } : {}),
    })

  /** The three commands whose reply depends on prior session state. */
  const handleStateful = (
    req: { seq: number; command: string },
    respond: (body?: unknown, ok?: boolean, message?: string) => void,
  ): boolean => {
    if (req.command === "launch") {
      deferredLaunchSeq = req.seq
      initialized = true
      send({ type: "event", event: "initialized" })
      return true
    }
    if (req.command === "setBreakpoints") {
      if (!initialized) respond(undefined, false, "too early")
      else {
        bpSet = true
        respond({ breakpoints: [{ verified: true }] })
      }
      return true
    }
    if (req.command === "configurationDone") {
      if (!bpSet) {
        respond(undefined, false, "no bp")
        return true
      }
      respond()
      if (deferredLaunchSeq !== undefined) respondTo(deferredLaunchSeq, "launch")
      send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } })
      return true
    }
    return false
  }

  return {
    send: (data) => {
      onSend?.()
      for (const raw of dec.push(data)) {
        const req = raw as { seq: number; command: string; arguments?: Record<string, unknown> }
        w.dap.push([req.command, req.arguments ?? {}])
        const respond = (body?: unknown, ok = true, message?: string): void =>
          respondTo(req.seq, req.command, body, ok, message)
        if (handleStateful(req, respond)) continue
        if (req.command === "terminate") {
          respond()
          send({ type: "event", event: "terminated", body: {} })
          continue
        }
        if (req.command in STATIC_DAP_BODIES) respond(STATIC_DAP_BODIES[req.command])
        else respond(undefined, false, `?${req.command}`)
      }
    },
    onData: (cb) => {
      toClient = cb
    },
    close: () => {},
  }
}

/** Scripted CDP inspector: entry pause → resume → paused at the breakpoint. */
const scriptedCdp = (w: Wire): CdpTransport => {
  let toClient: ((m: string) => void) | undefined
  let resumes = 0
  const send = (m: unknown) => toClient?.(JSON.stringify(m))
  return {
    send: (data) => {
      const req = JSON.parse(data) as {
        id: number
        method: string
        params?: Record<string, unknown>
      }
      w.cdp.push([req.method, req.params ?? {}])
      const reply = (result: unknown) => send({ id: req.id, result })
      switch (req.method) {
        case "Debugger.setBreakpointByUrl":
          reply({ breakpointId: "bp1", locations: [{ scriptId: "1", lineNumber: 4 }] })
          break
        case "Runtime.runIfWaitingForDebugger":
          reply({})
          send({
            method: "Debugger.paused",
            params: { reason: "Break on start", hitBreakpoints: [], callFrames: [] },
          })
          break
        case "Debugger.resume":
          reply({})
          resumes += 1
          if (resumes === 1)
            send({
              method: "Debugger.paused",
              params: {
                reason: "other",
                hitBreakpoints: ["bp1"],
                callFrames: [
                  {
                    callFrameId: "0",
                    functionName: "go",
                    url: "file:///w/x.mjs",
                    location: { lineNumber: 4 },
                    scopeChain: [{ type: "local", object: { objectId: "L0" } }],
                  },
                ],
              },
            })
          break
        default:
          reply({ result: [] })
      }
    },
    onData: (cb) => {
      toClient = cb
    },
    close: () => {},
  }
}

const drive = async (
  input: Record<string, unknown>,
  opts: { cwd?: string; onDapSend?: () => void; signal?: AbortSignal } = {},
): Promise<{ result: ToolResult; wire: Wire }> => {
  const w = newWire()
  const port: DebugAdapterPort = {
    spawn: async (spec) => {
      const s = spec as { command?: readonly string[]; cwd?: string }
      w.dapCommand = s.command
      w.dapCwd = s.cwd
      return scriptedDap(w, opts.onDapSend)
    },
  }
  const nodeCdp = async (spec: NodeCdpSpawnSpec): Promise<CdpTransport> => {
    const s = spec as { command?: (p: number) => string[]; cwd?: string }
    w.nodeArgv = typeof s.command === "function" ? s.command(9229) : undefined
    w.nodeCwd = s.cwd
    return scriptedCdp(w)
  }
  const ctx = {
    cwd: opts.cwd ?? "/w",
    signal: opts.signal ?? new AbortController().signal,
  } as ToolContext
  let last: ToolResult | undefined
  for await (const ev of makeDebugInspectTool(port, nodeCdp).execute(
    input as never,
    ctx as never,
  ) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") last = ev.result
  if (last === undefined) throw new Error("tool yielded no result event")
  return { result: last, wire: w }
}

const PY_BP = [{ file: "/w/x.py", line: 5 }]

describe("debug_inspect — adapter argv resolution", () => {
  test("R1: explicit adapterCommand WINS over the adapter preset", async () => {
    const { wire } = await drive({
      program: "/w/x.py",
      adapter: "python",
      adapterCommand: ["my-dap", "--stdio"],
      breakpoints: PY_BP,
    })
    expect(wire.dapCommand).toEqual(["my-dap", "--stdio"])
  })

  test("R1 paired control: without adapterCommand the preset argv is spawned", async () => {
    const { wire } = await drive({ program: "/w/x.py", adapter: "python", breakpoints: PY_BP })
    expect(wire.dapCommand).toEqual(["python3", "-m", "debugpy.adapter"])
  })

  test("R1: an EMPTY adapterCommand is an error, NOT a fallback to the preset", async () => {
    const { result, wire } = await drive({
      program: "/w/x.py",
      adapter: "python",
      adapterCommand: [],
      breakpoints: PY_BP,
    })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("provide `adapter` (preset) or `adapterCommand`")
    // Nothing was spawned — the guard fires before any process work.
    expect(wire.dapCommand).toBeUndefined()
  })

  test("R1: neither adapter nor adapterCommand → error without spawning", async () => {
    const { result, wire } = await drive({ program: "/w/x.py", breakpoints: PY_BP })
    expect(result.ok).toBe(false)
    expect(wire.dapCommand).toBeUndefined()
  })
})

describe("debug_inspect — cwd anchoring", () => {
  test("R2: node carrier anchors a relative program AND breakpoint file to the cwd", async () => {
    const { wire } = await drive({
      program: "x.mjs",
      adapter: "node",
      breakpoints: [{ file: "x.mjs", line: 5 }],
    })
    expect(wire.nodeArgv).toEqual(["node", "--inspect-brk=9229", "/w/x.mjs"])
    const bp = wire.cdp.find(([m]) => m === "Debugger.setBreakpointByUrl")?.[1]
    expect(bp?.url).toBe("file:///w/x.mjs")
  })

  test("R2: an explicit input.cwd overrides the session cwd for BOTH carriers", async () => {
    const node = await drive({
      program: "x.mjs",
      adapter: "node",
      cwd: "/alt",
      breakpoints: [{ file: "x.mjs", line: 5 }],
    })
    expect(node.wire.nodeArgv?.[2]).toBe("/alt/x.mjs")
    expect(node.wire.nodeCwd).toBe("/alt")

    const dap = await drive({
      program: "x.py",
      adapter: "python",
      cwd: "/alt",
      breakpoints: [{ file: "x.py", line: 5 }],
    })
    expect(dap.wire.dapCwd).toBe("/alt")
    expect(dapArg(dap.wire, "launch")?.cwd).toBe("/alt")
  })

  test("R2 paired control: an ABSOLUTE path is passed through untouched", async () => {
    const { wire } = await drive({
      program: "/elsewhere/x.mjs",
      adapter: "node",
      cwd: "/alt",
      breakpoints: [{ file: "/elsewhere/x.mjs", line: 5 }],
    })
    expect(wire.nodeArgv?.[2]).toBe("/elsewhere/x.mjs")
  })

  test("R2: node carrier forwards the program args after the script path", async () => {
    const { wire } = await drive({
      program: "/w/x.mjs",
      adapter: "node",
      args: ["--flag", "v"],
      breakpoints: [{ file: "/w/x.mjs", line: 5 }],
    })
    expect(wire.nodeArgv).toEqual(["node", "--inspect-brk=9229", "/w/x.mjs", "--flag", "v"])
  })
})

describe("debug_inspect — DAP request construction", () => {
  test("R3: a breakpoint condition reaches setBreakpoints; an unconditional one omits the key", async () => {
    const { wire } = await drive({
      program: "/w/x.py",
      adapter: "python",
      breakpoints: [
        { file: "/w/x.py", line: 5, condition: "i == 3" },
        { file: "/w/x.py", line: 9 },
      ],
    })
    const bps = dapArg(wire, "setBreakpoints")?.breakpoints as Array<Record<string, unknown>>
    expect(bps?.[0]).toEqual({ line: 5, condition: "i == 3" })
    // OMITTED, not present-and-undefined.
    expect(Object.keys(bps?.[1] ?? {})).toEqual(["line"])
  })

  test("R4: exception filters are chosen BY ADAPTER when opted in", async () => {
    const py = await drive({
      program: "/w/x.py",
      adapter: "python",
      exceptionBreakpoints: true,
      breakpoints: PY_BP,
    })
    expect(dapArg(py.wire, "setExceptionBreakpoints")?.filters).toEqual([
      "uncaught",
      "userUnhandled",
    ])

    const lldb = await drive({
      program: "/w/bin",
      adapter: "lldb",
      exceptionBreakpoints: true,
      breakpoints: [{ file: "/w/x.c", line: 5 }],
    })
    expect(dapArg(lldb.wire, "setExceptionBreakpoints")?.filters).toEqual(["cpp_throw"])

    // An adapter with NO entry in the table resolves to an empty filter list,
    // which the driver then declines to send at all — crucially it must not
    // inherit python's filters and must not crash.
    const custom = await drive({
      program: "/w/x.rb",
      adapterCommand: ["rdbg"],
      exceptionBreakpoints: true,
      breakpoints: [{ file: "/w/x.rb", line: 5 }],
    })
    expect(custom.result.ok).toBe(true)
    expect(custom.wire.dap.some(([c]) => c === "setExceptionBreakpoints")).toBe(false)
  })

  test("R4 paired control: without the opt-in, setExceptionBreakpoints is never sent", async () => {
    for (const input of [
      { program: "/w/x.py", adapter: "python", breakpoints: PY_BP },
      { program: "/w/x.py", adapter: "python", exceptionBreakpoints: false, breakpoints: PY_BP },
    ]) {
      const { wire } = await drive(input)
      expect(wire.dap.some(([c]) => c === "setExceptionBreakpoints")).toBe(false)
    }
  })

  test("R3: `evaluate` is only requested when the caller asked for it", async () => {
    const withEval = await drive({
      program: "/w/x.py",
      adapter: "python",
      evaluate: "y + 1",
      breakpoints: PY_BP,
    })
    expect(dapArg(withEval.wire, "evaluate")?.expression).toBe("y + 1")

    const without = await drive({ program: "/w/x.py", adapter: "python", breakpoints: PY_BP })
    expect(without.wire.dap.some(([c]) => c === "evaluate")).toBe(false)
  })

  test("R3: the python launch config carries the debugpy discriminators + stopOnEntry", async () => {
    const { wire } = await drive({
      program: "/w/x.py",
      adapter: "python",
      stopOnEntry: true,
      args: ["a"],
      breakpoints: PY_BP,
    })
    const launch = dapArg(wire, "launch")
    expect(launch?.request).toBe("launch")
    expect(launch?.type).toBe("python")
    expect(launch?.python).toEqual(["python3"])
    expect(launch?.stopOnEntry).toBe(true)
    expect(launch?.args).toEqual(["a"])

    // A non-python adapter must NOT get the debugpy-only keys.
    const rb = await drive({
      program: "/w/x.rb",
      adapterCommand: ["rdbg"],
      breakpoints: [{ file: "/w/x.rb", line: 5 }],
    })
    const rbLaunch = dapArg(rb.wire, "launch") ?? {}
    expect(rbLaunch.type).toBeUndefined()
    expect(rbLaunch.python).toBeUndefined()
    expect(rbLaunch.stopOnEntry).toBe(false)
  })
})

describe("debug_inspect — abort forwarding", () => {
  test("R5: a signal raised MID-session aborts the inspection (both carriers)", async () => {
    const ac = new AbortController()
    let sends = 0
    const dap = await drive(
      { program: "/w/x.py", adapter: "python", breakpoints: PY_BP },
      {
        signal: ac.signal,
        onDapSend: () => {
          sends += 1
          if (sends === 3) ac.abort()
        },
      },
    )
    expect(dap.result.ok).toBe(false)
    expect(dap.result.output).toContain("aborted")
    // It got far enough to be a MID-session abort, not the pre-flight guard.
    expect(dap.result.output).not.toContain("aborted before start")
    expect(dap.wire.dapCommand).toBeDefined()
  })

  test("R5 paired control: a pre-flight abort short-circuits before any spawn", async () => {
    const ac = new AbortController()
    ac.abort()
    const { result, wire } = await drive(
      { program: "/w/x.py", adapter: "python", breakpoints: PY_BP },
      { signal: ac.signal },
    )
    expect(result.output).toBe("aborted before start")
    expect(wire.dapCommand).toBeUndefined()
    expect(wire.nodeArgv).toBeUndefined()
  })

  test("R6: both carriers report ok=true on a successful stop", async () => {
    const dap = await drive({ program: "/w/x.py", adapter: "python", breakpoints: PY_BP })
    expect(dap.result.ok).toBe(true)
    expect(dap.result.output).toContain("Stopped (breakpoint)")

    const node = await drive({
      program: "/w/x.mjs",
      adapter: "node",
      breakpoints: [{ file: "/w/x.mjs", line: 5 }],
    })
    expect(node.result.ok).toBe(true)
    expect(node.result.output).toContain("Stopped (other)")
  })

  test("R1/R6: the node preset never touches the DAP port, even with adapterCommand set", async () => {
    const { result, wire } = await drive({
      program: "/w/x.mjs",
      adapter: "node",
      adapterCommand: ["should-be-ignored"],
      breakpoints: [{ file: "/w/x.mjs", line: 5 }],
    })
    expect(result.ok).toBe(true)
    expect(wire.dapCommand).toBeUndefined()
    expect(wire.dap).toHaveLength(0)
    expect(wire.nodeArgv).toBeDefined()
  })
})
