import { describe, expect, test } from "bun:test"
import {
  createSessionStdioSpawnTransport,
  createSessionTransportClient,
  encodeSessionTransportMessage,
  type SessionStdioSpawnTransport,
  type SessionTransportCloseInfo,
  type SessionTransportConnectionState,
  type SessionTransportMessage,
} from "@/ipc/session"

/**
 * S4 stdio-spawn lifecycle e2e — REAL child processes (jul-16 transport-unified
 * SDK, ticket 01 §2 S4).
 *
 * `createSessionStdioSpawnTransport` owns the child lifecycle; these tests
 * drive it against real `bun -e` children / `/bin/cat` (deterministic targets,
 * event-based waits — no polling sleeps) across the three death paths:
 *   A. clean self-exit (code 0)                 → onClose `child_exit code=0`
 *   B. owner close(): SIGTERM, and the SIGKILL escalation for a child that
 *      ignores SIGTERM                          → onClose `local_close`, no zombie
 *   C. immediate crash (non-zero exit + stderr) → onClose carries code + stderr tail
 * plus: framing round-trip through a real child, env verbatim (no injection),
 * bounded stderr tail, ENOENT fail-fast, idempotent close, late subscribers.
 */

const BUN = process.execPath

const HEARTBEAT_PONG: SessionTransportMessage = { kind: "heartbeat", phase: "pong" }
const PONG_WIRE = encodeSessionTransportMessage(HEARTBEAT_PONG)

const waitClose = (transport: SessionStdioSpawnTransport): Promise<SessionTransportCloseInfo> =>
  new Promise((resolve) => {
    transport.onClose((info) => resolve(info))
  })

const waitFirstMessage = (
  transport: SessionStdioSpawnTransport,
): Promise<SessionTransportMessage> =>
  new Promise((resolve) => {
    const unsubscribe = transport.onMessage((message) => {
      unsubscribe()
      resolve(message)
    })
  })

/** kill(pid, 0) succeeds for BOTH live processes and unreaped zombies, and
 *  throws ESRCH once the child is reaped and gone — so asserting the throw
 *  proves "no zombie left behind", not merely "not running". */
const isProcessGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

describe("S4 stdio-spawn transport — real child lifecycle", () => {
  test("path A: clean self-exit — frames flow, then onClose fires once with child_exit code=0", async () => {
    const transport = createSessionStdioSpawnTransport({
      command: [BUN, "-e", `console.log(${JSON.stringify(PONG_WIRE)}); process.exit(0)`],
    })
    const closes: SessionTransportCloseInfo[] = []
    transport.onClose((info) => closes.push(info))
    const firstMessage = waitFirstMessage(transport)
    const closed = waitClose(transport)

    expect(transport.pid).toBeGreaterThan(0)
    // The child's stdout line decodes through the REAL framing stack.
    expect(await firstMessage).toEqual(HEARTBEAT_PONG)

    const info = await closed
    expect(info.reason).toContain("child_exit")
    expect(info.reason).toContain("code=0")
    expect(closes).toHaveLength(1)
    expect(isProcessGone(transport.pid)).toBe(true)

    // close() after a self-exit resolves and does NOT re-notify.
    await transport.close()
    expect(closes).toHaveLength(1)
  })

  test("framing round-trips through a real child: /bin/cat echoes a sent frame back", async () => {
    const transport = createSessionStdioSpawnTransport({ command: ["/bin/cat"] })
    const echoed = waitFirstMessage(transport)

    await transport.send(HEARTBEAT_PONG)
    expect(await echoed).toEqual(HEARTBEAT_PONG)

    await transport.close()
    expect(isProcessGone(transport.pid)).toBe(true)
  })

  test("path B: close() SIGTERMs a compliant child — local_close once, no zombie, idempotent + concurrent close", async () => {
    const transport = createSessionStdioSpawnTransport({
      // Never reads stdin, never exits on its own — dies to SIGTERM's default
      // disposition. Deterministic: no timers raced, we await close() itself.
      command: [BUN, "-e", "setInterval(() => {}, 1000)"],
    })
    const closes: SessionTransportCloseInfo[] = []
    transport.onClose((info) => closes.push(info))

    expect(isProcessGone(transport.pid)).toBe(false) // alive before close

    await Promise.all([transport.close(), transport.close()])
    await transport.close()

    expect(closes).toEqual([{ reason: "local_close" }])
    expect(isProcessGone(transport.pid)).toBe(true) // reaped — not even a zombie
  })

  test("path B2: a SIGTERM-ignoring child is SIGKILL-escalated after the grace window — close() still resolves, no zombie", async () => {
    const transport = createSessionStdioSpawnTransport({
      // Installs the SIGTERM ignore FIRST, then prints the readiness frame —
      // once we see the frame, SIGTERM is provably ignored, so close() can
      // only complete via the SIGKILL escalation.
      command: [
        BUN,
        "-e",
        `process.on("SIGTERM", () => {}); console.log(${JSON.stringify(PONG_WIRE)}); setInterval(() => {}, 1000)`,
      ],
      sigkillGraceMs: 80,
    })
    const closes: SessionTransportCloseInfo[] = []
    transport.onClose((info) => closes.push(info))

    expect(await waitFirstMessage(transport)).toEqual(HEARTBEAT_PONG)

    await transport.close()

    expect(closes).toEqual([{ reason: "local_close" }])
    expect(isProcessGone(transport.pid)).toBe(true)
  })

  test("path C: immediate crash — onClose carries the exit code AND the stderr tail (fail-fast raw material)", async () => {
    const transport = createSessionStdioSpawnTransport({
      command: [BUN, "-e", `console.error("S4-CRASH-MARKER gate is OFF"); process.exit(7)`],
    })
    const closes: SessionTransportCloseInfo[] = []
    transport.onClose((info) => closes.push(info))

    const info = await waitClose(transport)
    expect(info.reason).toContain("child_exit")
    expect(info.reason).toContain("code=7")
    expect(info.reason).toContain("S4-CRASH-MARKER gate is OFF")
    expect(closes).toHaveLength(1)
    expect(isProcessGone(transport.pid)).toBe(true)

    // The dead transport is inert but safe: send() is a no-op, close() resolves.
    await transport.send(HEARTBEAT_PONG)
    await transport.close()
    expect(closes).toHaveLength(1)
  })

  test("a late onClose subscriber (after the child already died) is invoked immediately", async () => {
    const transport = createSessionStdioSpawnTransport({
      command: [BUN, "-e", "process.exit(3)"],
    })
    await waitClose(transport)

    const late: SessionTransportCloseInfo[] = []
    transport.onClose((info) => late.push(info))
    expect(late).toHaveLength(1)
    expect(late[0]?.reason).toContain("code=3")
  })

  test("stderr tail is BOUNDED: the retained tail keeps the child's last words, drops the flood", async () => {
    const transport = createSessionStdioSpawnTransport({
      command: [
        BUN,
        "-e",
        `process.stderr.write("BEGIN-MARK-" + "A".repeat(64 * 1024) + "-END-MARK\\n"); process.exit(3)`,
      ],
      stderrTailChars: 512,
    })

    const info = await waitClose(transport)
    expect(info.reason).toContain("code=3")
    expect(info.reason).toContain("-END-MARK") // the tail survived …
    expect(info.reason).not.toContain("BEGIN-MARK") // … the flood did not
    expect(info.reason.length).toBeLessThan(1024) // cap + reason overhead, far under 64KiB
  })

  test("env is passed VERBATIM — a parent-env canary does NOT leak in, the explicit env is the child's ENTIRE env", async () => {
    process.env.QUANTA_S4_ENV_CANARY = "leak-me"
    try {
      const transport = createSessionStdioSpawnTransport({
        command: [
          BUN,
          "-e",
          `console.error("canary=" + (process.env.QUANTA_S4_ENV_CANARY ?? "ABSENT") + " explicit=" + (process.env.QUANTA_S4_EXPLICIT ?? "ABSENT")); process.exit(5)`,
        ],
        env: { QUANTA_S4_EXPLICIT: "yes" },
      })

      const info = await waitClose(transport)
      expect(info.reason).toContain("canary=ABSENT") // no injection / no merge
      expect(info.reason).toContain("explicit=yes") // the caller's env, verbatim
    } finally {
      delete process.env.QUANTA_S4_ENV_CANARY
    }
  })

  test("an unresolvable command fails FAST: the factory throws synchronously (no half-built transport)", () => {
    expect(() =>
      createSessionStdioSpawnTransport({ command: ["/nonexistent/s4-no-such-binary"] }),
    ).toThrow()
  })

  test("composes with the raw client: a sidecar crash surfaces as onConnectionState('closed') with the exit evidence", async () => {
    // The ticket-02 sidecar story end to end: connect() over a spawn-owned
    // child, child dies → the SDK consumer's liveness callback carries the
    // exit code + stderr tail. Child echoes stdin (so the connect frame is
    // accepted by a live pipe), then crashes on its first line.
    const transport = createSessionStdioSpawnTransport({
      command: [
        BUN,
        "-e",
        `process.stdin.on("data", () => { console.error("sidecar refused: gate off"); process.exit(41) })`,
      ],
    })
    const client = createSessionTransportClient({ transport, sessionId: "session-1" })
    const states: SessionTransportConnectionState[] = []
    const terminal = new Promise<SessionTransportConnectionState>((resolve) => {
      client.onConnectionState((state) => {
        states.push(state)
        if (state.status === "closed") resolve(state)
      })
    })

    await client.connect()
    expect(states[0]).toEqual({ status: "connected" })

    const closed = await terminal
    if (closed.status !== "closed") throw new Error("expected closed state")
    expect(closed.reason).toContain("child_exit")
    expect(closed.reason).toContain("code=41")
    expect(closed.reason).toContain("sidecar refused: gate off")
    expect(isProcessGone(transport.pid)).toBe(true)

    await client.close() // resolves cleanly after the fact, no double notification
    expect(states.filter((s) => s.status === "closed")).toHaveLength(1)
  })
})
