/**
 * E-stdio silent-failure hellgate (audit jun-10 finding #8) — StdioMcpTransport
 * stdout pump death WITHOUT process death must not leave the client half-dead.
 *
 * Before the fix: the pump swallowed its end at debug level and nothing else
 * happened — the server process stayed alive, `fireExit` only ran from the
 * `proc.exited` watcher, so every pending request degraded to a generic 30s
 * timeout and the ADR-0435 restart supervisor stayed blind ("healthy").
 * A clean early EOF (server closed stdout but lives) is the same defect from
 * the caller's point of view as a stream error, so both arms are injected.
 *
 * Real-effect assertions: exit fan-out observed via `onExit` (the SAME channel
 * the supervisor subscribes), pending client requests racing a wedge window far
 * below the request timeout, and paired controls proving a REAL process exit /
 * a deliberate `close()` are NOT misreported as pump death.
 */
import { describe, expect, spyOn, test } from "bun:test"
import { McpClient, type McpServerConfig, StdioMcpTransport } from "@/mcp"
import { logger } from "@/shared"

/** Fail-fast bound: far under the 30s request timeout the old code burned. */
const WEDGE_WINDOW_MS = 2_000
/** Single event-loop settle hop for fan-outs that must have already fired. */
const SETTLE_TICK_MS = 25
const POLL_MS = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const waitFor = async (pred: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + WEDGE_WINDOW_MS
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`)
    await sleep(POLL_MS)
  }
}

const cfg = (): McpServerConfig => ({ name: "pumpdeath", command: ["/bin/false"] })

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A pushable async-iterable stdout double: the test drives chunks, a clean
 *  end, or a thrown stream error — the two pump-death arms. */
const pushableStdout = (): {
  stream: AsyncGenerator<Uint8Array>
  push: (b: Uint8Array) => void
  end: () => void
  fail: (e: Error) => void
} => {
  const queue: Uint8Array[] = []
  let notify: (() => void) | null = null
  let ended = false
  let error: Error | null = null
  const wake = (): void => {
    notify?.()
    notify = null
  }
  const stream = (async function* (): AsyncGenerator<Uint8Array> {
    for (;;) {
      while (queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length-guarded shift.
        yield queue.shift()!
      }
      if (error !== null) throw error
      if (ended) return
      await new Promise<void>((r) => {
        notify = r
      })
    }
  })()
  return {
    stream,
    push: (b) => {
      queue.push(b)
      wake()
    },
    end: () => {
      ended = true
      wake()
    },
    fail: (e) => {
      error = e
      wake()
    },
  }
}

interface FakeProcOver {
  stdin?: { write: (b: Uint8Array) => number }
  exited?: Promise<number>
  kill?: () => void
}

/** Minimal live-child fake: `exited` never settles, `exitCode` stays null. */
const liveFakeProc = (stdout: AsyncGenerator<Uint8Array>, over: FakeProcOver = {}) => ({
  stdin: { write: (b: Uint8Array) => b.byteLength },
  stdout,
  exitCode: null as number | null,
  killed: false,
  exited: new Promise<number>(() => {}),
  kill: () => {},
  ...over,
})

describe("StdioMcpTransport — stdout pump death while the server process lives (#8)", () => {
  test("(a) throwing pump with a LIVE child fires exit promptly and WARNS (supervisor observes)", async () => {
    const ps = pushableStdout()
    const fakeProc = liveFakeProc(ps.stream)
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    const reasons: Array<string | undefined> = []
    let fireFired: () => void = () => {}
    const fired = new Promise<void>((r) => {
      fireFired = r
    })
    transport.onExit((reason) => {
      reasons.push(reason)
      fireFired()
    })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      await transport.start()
      // Control-before-injection: the pump is alive and decoding.
      const received: unknown[] = []
      transport.onMessage((m) => received.push(m))
      ps.push(enc('{"jsonrpc":"2.0","id":99,"result":{}}\n'))
      await waitFor(() => received.length === 1, "pump decodes before injection")
      // Injection: the stream throws while `exited` never settles (live child).
      ps.fail(new Error("EIO pump exploded"))
      const outcome = await Promise.race([
        fired.then(() => "exit-fired" as const),
        sleep(WEDGE_WINDOW_MS).then(() => "silent" as const),
      ])
      expect(outcome).toBe("exit-fired")
      expect(reasons).toHaveLength(1)
      expect(String(reasons[0])).toMatch(/stdout pump died/)
      expect(String(reasons[0])).toContain("EIO pump exploded")
      // The death is warned, not swallowed at debug.
      expect(warn.mock.calls.some((c) => String(c[0]).includes("pump"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  test("(b) clean early stdout end with a LIVE child fires exit promptly", async () => {
    const ps = pushableStdout()
    const fakeProc = liveFakeProc(ps.stream)
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    const reasons: Array<string | undefined> = []
    let fireFired: () => void = () => {}
    const fired = new Promise<void>((r) => {
      fireFired = r
    })
    transport.onExit((reason) => {
      reasons.push(reason)
      fireFired()
    })
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      await transport.start()
      ps.end()
      const outcome = await Promise.race([
        fired.then(() => "exit-fired" as const),
        sleep(WEDGE_WINDOW_MS).then(() => "silent" as const),
      ])
      expect(outcome).toBe("exit-fired")
      expect(reasons).toHaveLength(1)
      expect(String(reasons[0])).toMatch(/stdout pump died/)
      expect(warn.mock.calls.some((c) => String(c[0]).includes("pump"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  test("pending client request rejects promptly on pump death (no 30s timeout burn)", async () => {
    const ps = pushableStdout()
    const stdinWrites: Array<Record<string, unknown>> = []
    // `exited` only settles on kill so the child is LIVE at injection time but
    // the trailing `client.stop()` teardown can still complete.
    let resolveExit: (n: number) => void = () => {}
    const fakeProc = liveFakeProc(ps.stream, {
      stdin: {
        write: (b: Uint8Array) => {
          stdinWrites.push(JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>)
          return b.byteLength
        },
      },
      exited: new Promise<number>((res) => {
        resolveExit = res
      }),
      kill: () => resolveExit(0),
    })
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    const client = new McpClient(cfg(), { transport })
    const startP = client.start()
    await waitFor(() => stdinWrites.some((w) => w.method === "initialize"), "initialize sent")
    const init = stdinWrites.find((w) => w.method === "initialize") as { id: number }
    ps.push(enc(`{"jsonrpc":"2.0","id":${init.id},"result":{"capabilities":{}}}\n`))
    await startP
    const pending = client.listTools()
    await waitFor(() => stdinWrites.some((w) => w.method === "tools/list"), "tools/list sent")
    // Injection: pump dies, child stays alive — old code wedged to timeout.
    ps.fail(new Error("EIO pump exploded"))
    const outcome = await Promise.race([
      pending.then(
        () => "resolved" as const,
        (e: unknown) => `rejected: ${String(e)}`,
      ),
      sleep(WEDGE_WINDOW_MS).then(() => "wedged" as const),
    ])
    expect(String(outcome)).toMatch(/^rejected: /)
    expect(String(outcome)).toMatch(/exited|pump died/)
    await client.stop().catch(() => undefined)
  })

  test("paired control: a REAL process exit is reported as 'exited', never as pump death (REAL Bun ordering: EOF FIRST, exit a macrotask later)", async () => {
    const ps = pushableStdout()
    let resolveExit: (n: number) => void = () => {}
    const fakeProc = liveFakeProc(ps.stream, {
      exited: new Promise<number>((res) => {
        resolveExit = res
      }),
    })
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    const reasons: Array<string | undefined> = []
    transport.onExit((reason) => reasons.push(reason))
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      await transport.start()
      // Child dies for real, modelling the REAL Bun fan-out ordering that the
      // old single-`await Promise.resolve()` MASKED: stdout EOF settles the
      // pump FIRST, while `proc.exitCode` is still null and `proc.exited` is
      // still pending; Bun only sets the exit code and fans out `proc.exited`
      // a full macrotask LATER. The bounded settlement race must absorb that
      // gap before judging liveness — a single microtask yield does not.
      ps.end()
      const exitSettled = new Promise<void>((r) => {
        setTimeout(() => {
          fakeProc.exitCode = 0
          resolveExit(0)
          r()
        }, 1)
      })
      await exitSettled
      await sleep(SETTLE_TICK_MS)
      expect(reasons).toHaveLength(1)
      expect(String(reasons[0])).toMatch(/exited/)
      expect(String(reasons[0])).not.toMatch(/pump died/)
      expect(warn.mock.calls.some((c) => String(c[0]).includes("pump"))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  test("paired control: deliberate close() never fires/warns pump death", async () => {
    const ps = pushableStdout()
    let resolveExit: (n: number) => void = () => {}
    const fakeProc = liveFakeProc(ps.stream, {
      exited: new Promise<number>((res) => {
        resolveExit = res
      }),
      kill: () => resolveExit(0),
    })
    const transport = new StdioMcpTransport(cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake proc.
      spawn: () => fakeProc as any,
    })
    const reasons: Array<string | undefined> = []
    transport.onExit((reason) => reasons.push(reason))
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      await transport.start()
      const closing = transport.close()
      // The fake stream only ends when told — mirror the real pipe closing
      // after the kill.
      ps.end()
      await closing
      await sleep(SETTLE_TICK_MS)
      expect(reasons).toHaveLength(1)
      expect(String(reasons[0])).toMatch(/exited/)
      expect(String(reasons[0])).not.toMatch(/pump died/)
      expect(warn.mock.calls.some((c) => String(c[0]).includes("pump"))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  // META-LESSON #1: any liveness/exit-ordering guard over Bun.spawn needs at
  // least one REAL-SUBPROCESS test. A fake's event ordering is a free parameter
  // that can be (and was) tuned to pass; only a real child exercises Bun's true
  // fan-out timing (stdout EOF settles BEFORE `proc.exitCode` / `proc.exited`).
  test("REAL subprocess: a child that prints then exits 0 reports 'exited', NEVER 'pump died', and emits NO pump-death warn", async () => {
    // Real child: emit one JSON-RPC line on stdout, then exit cleanly. On real
    // Bun the stdout EOF reaches our pump a macrotask before `proc.exited`
    // fans out — the exact race the old `await Promise.resolve()` lost.
    const realCfg: McpServerConfig = {
      name: "realexit",
      command: ["/bin/sh", "-c", `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'; exit 0`],
    }
    const transport = new StdioMcpTransport(realCfg)
    const reasons: Array<string | undefined> = []
    let fireFired: () => void = () => {}
    const fired = new Promise<void>((r) => {
      fireFired = r
    })
    transport.onExit((reason) => {
      reasons.push(reason)
      fireFired()
    })
    const messages: unknown[] = []
    transport.onMessage((m) => messages.push(m))
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      await transport.start()
      // The exit MUST fire (the child really exited) — bounded so a regression
      // that hangs the settlement race fails loudly instead of timing out the
      // whole suite.
      const outcome = await Promise.race([
        fired.then(() => "exit-fired" as const),
        sleep(WEDGE_WINDOW_MS).then(() => "silent" as const),
      ])
      expect(outcome).toBe("exit-fired")
      // The line really decoded — proves the pump ran against a real pipe.
      await waitFor(() => messages.length === 1, "real child line decoded")
      expect(reasons).toHaveLength(1)
      // The normal-shutdown reason — NOT the misfire the un-backported code
      // produced on EVERY clean exit.
      expect(String(reasons[0])).toMatch(/exited/)
      expect(String(reasons[0])).not.toMatch(/pump died/)
      // And NO spurious "stdout pump died" warn on a normal shutdown.
      expect(warn.mock.calls.some((c) => String(c[0]).includes("pump"))).toBe(false)
    } finally {
      warn.mockRestore()
      await transport.close().catch(() => undefined)
    }
  })
})
