/**
 * W5 DAP — teardown `terminate` failure ATTRIBUTION hellgate.
 *
 * The driver fires a best-effort `terminate` during cleanup and must NEVER let
 * its rejection escape (teardown is fire-and-forget — `dispose()` already kills
 * the child). The structural requirement past "don't throw" is that the swallow
 * is NOT silent: a rejecting terminate must surface a debug-level telemetry line
 * with a STABLE label so a wedged adapter is diagnosable instead of vanishing.
 *
 * Setup: a fake adapter that drives the REAL happy-path handshake all the way to
 * a `stopped` inspection, but whose transport THROWS synchronously the moment it
 * sees the `terminate` request frame (modelling a write to a dead pipe). Because
 * `DapClient.request` calls `transport.send` inside its Promise executor, that
 * throw rejects the terminate promise — exactly the swallowed path.
 *
 * Asserts: (1) cleanup still completes — `outcome: "stopped"`, no throw escapes;
 * (2) the debug logger fired with the stable label. red-on-injection: revert the
 * fix to a bare `.catch(() => {})` and assertion (2) goes red (no log line).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { DapClient, type DapTransport } from "@/tool/debug/dap-client"
import { DapFrameDecoder, encodeDapMessage } from "@/tool/debug/dap-codec"
import { inspectViaDap } from "@/tool/debug/inspect-driver"
import { logger } from "@/shared"

/**
 * Faithful happy-path adapter (initialize → initialized → setBreakpoints →
 * configurationDone → stopped → threads → stackTrace → scopes → variables),
 * but its transport `send` THROWS when it observes the `terminate` command —
 * the realistic "write to a dead pipe during teardown" failure.
 */
const makeTerminateThrowingAdapter = () => {
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
        respond({ breakpoints: [{ verified: true, line: 10 }] })
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
        respond({ stackFrames: [{ id: 100, name: "f", line: 10, source: { path: "/p/app.py" } }] })
        break
      case "scopes":
        respond({ scopes: [{ name: "Locals", variablesReference: 1000 }] })
        break
      case "variables":
        respond({ variables: [{ name: "n", value: "1", type: "int" }] })
        break
      default:
        respond(undefined, false, `unknown ${req.command}`)
    }
  }

  const transport: DapTransport = {
    send: (data) => {
      // Peek the OUTGOING request frame: throw iff it is the teardown terminate
      // (write to a dead pipe). All other commands flow through the fake adapter.
      const peek = new DapFrameDecoder()
      for (const m of peek.push(data)) {
        if ((m as { command?: string }).command === "terminate") {
          throw new Error("EPIPE: write to terminated debug-adapter pipe")
        }
      }
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

describe("inspectViaDap — best-effort terminate failure is attributed, not swallowed", () => {
  afterEach(() => {
    // Restore any spies installed per-test.
  })

  test("a rejecting teardown terminate ⇒ cleanup completes AND a labelled debug line fires", async () => {
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      const client = new DapClient(makeTerminateThrowingAdapter())
      const r = await inspectViaDap(client, {
        adapterID: "python",
        launch: { program: "/p/app.py" },
        breakpoints: [{ file: "/p/app.py", line: 10 }],
      })

      // (1) The rejection did NOT escape — the inspection still resolved stopped.
      expect(r.outcome).toBe("stopped")

      // (2) The swallow was ATTRIBUTED: a debug line with the stable label that
      //     carries the underlying transport error fired.
      const labelled = debugSpy.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("debug-inspect: best-effort terminate request failed"),
      )
      expect(labelled).toBeDefined()
      // The cause is threaded through `errMessage`, not discarded.
      expect(labelled?.[0] as string).toContain("EPIPE")
    } finally {
      debugSpy.mockRestore()
    }
  })

  test("the happy path (terminate succeeds) emits NO terminate-failure debug line", async () => {
    // Paired control: prove the label fires ONLY on failure (not on every run),
    // so the assertion above is not vacuously satisfied by unrelated debug noise.
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      // A clean adapter whose transport answers terminate normally.
      const client = new DapClient(makeCleanAdapter())
      const r = await inspectViaDap(client, {
        adapterID: "python",
        launch: { program: "/p/app.py" },
        breakpoints: [{ file: "/p/app.py", line: 10 }],
      })
      expect(r.outcome).toBe("stopped")
      const labelled = debugSpy.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("best-effort terminate request failed"),
      )
      expect(labelled).toBeUndefined()
    } finally {
      debugSpy.mockRestore()
    }
  })
})

/** Clean happy-path adapter that answers `terminate` normally. */
const makeCleanAdapter = (): DapTransport => {
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
        respond({ breakpoints: [{ verified: true, line: 10 }] })
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
        respond({ stackFrames: [{ id: 100, name: "f", line: 10, source: { path: "/p/app.py" } }] })
        break
      case "scopes":
        respond({ scopes: [{ name: "Locals", variablesReference: 1000 }] })
        break
      case "variables":
        respond({ variables: [{ name: "n", value: "1", type: "int" }] })
        break
      case "terminate":
        respond()
        send({ type: "event", event: "terminated", body: {} })
        break
      default:
        respond(undefined, false, `unknown ${req.command}`)
    }
  }
  return {
    send: (data) => {
      for (const m of decoder.push(data)) handle(m as { seq: number; command: string; arguments?: Record<string, unknown> })
    },
    onData: (cb) => {
      toClient = cb
    },
    close: () => {},
  }
}
