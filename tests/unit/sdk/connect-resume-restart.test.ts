/**
 * Ticket 05 CROWN (door-level) — durable resume across a runtime RESTART via
 * the PUBLIC door: `connect({ resumeFromSeq })`.
 *
 * The raw-client twin (tests/unit/sdk/durable-resume-restart.test.ts) pins the
 * wire mechanics; THIS suite pins the door-level composition end-to-end on the
 * same W4-b substrate (`QUANTA_SESSION_EVENT_LOG_DIR` on-disk JSONL log):
 *
 *   instance 1 (events 1..2, graceful close ⇒ 3) → process-shape restart →
 *   instance 2 (seq continues at 4) → `connect({resumeFromSeq: 1})` ⇒
 *     · the disconnect window [2..4] arrives as an incremental EVENT replay
 *       spanning the restart boundary (identity-proven: instance-1 eventId),
 *       NOT a snapshot reset;
 *     · the outcome is surfaced as `resume: "replayed"` on the connected
 *       payload (silent demotion = red);
 *     · the handle is fully LIVE afterwards: verbs dispatch through the wire
 *       and `awaitTurnEnd()` resolves the turn's terminal event normally.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOutcome } from "@/agent"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionTransport, SessionTransportMessage } from "@/ipc/session"
import type { SessionHost } from "@/kernel/session"
import type { SessionEvent } from "@/protocol/session"
import { connect, transports } from "@/sdk"
import { createRuntime } from "@/sdk/runtime"
import { capabilitiesFor } from "../../support/session-fixtures"

const ENV_KEY = "QUANTA_SESSION_EVENT_LOG_DIR"

const CAPABILITIES = capabilitiesFor()

const makeOutcome = (): AgentOutcome =>
  ({
    reason: "completed",
    turns: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "ping" }] },
      { role: "assistant", content: [{ type: "text", text: "pong" }] },
    ],
  }) as AgentOutcome

const makeHost = (sessionId: string): SessionHost => ({
  describe: () => ({
    sessionId,
    permissionMode: "default",
    capabilityManifest: CAPABILITIES,
  }),
  runTurn: async () => ({ outcome: makeOutcome(), messages: makeOutcome().messages }),
  close: async () => undefined,
})

/** In-memory duplex pair — `send` awaits the remote handlers (the bridge's
 *  whole replay answer completes inside the handshake's send await). */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const build = (
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
  ): SessionTransport => ({
    async send(message) {
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      local.clear()
    },
  })
  return {
    client: build(clientHandlers, serverHandlers),
    server: build(serverHandlers, clientHandlers),
  }
}

const bounded = async <T>(p: Promise<T>, label: string, ms = 5_000): Promise<T> =>
  await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ])

const tmpDirs: string[] = []
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-t05-door-resume-"))
  tmpDirs.push(dir)
  return dir
}

const savedEnv = process.env[ENV_KEY]
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("ticket 05 — door-level durable resume across a runtime restart", () => {
  test("CROWN: restart → connect({resumeFromSeq}) replays the window from the on-disk log, resume:'replayed', and the handle turns normally (awaitTurnEnd)", async () => {
    const dir = freshDir()
    process.env[ENV_KEY] = dir
    const sessionId = "t05-door-crown"

    // ---- instance 1: events 1..2, graceful close (3 = session.closed) -------
    const runtime1 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session1 = await runtime1.createSession({ cwd: "/tmp", permissionMode: "default" })
    await session1.input.append("one")
    const second = await session1.input.append("two")
    expect(second.events.map((event) => event.seq)).toEqual([2])
    const seq2EventId = second.events[0]?.eventId
    if (seq2EventId === undefined) throw new Error("instance-1 seq-2 event missing")
    await session1.close()
    await runtime1.close()

    // ---- instance 2: same dir + sessionId (seq continues past the log tip) --
    const runtime2 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session2 = await runtime2.createSession({ cwd: "/tmp", permissionMode: "default" })
    const pair = createTransportPair()
    // Server-side wire tap: what the bridge actually sent to this peer.
    const serverSent: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      serverSent.push(message)
    })
    const connected = await session2.attachSessionTransport(pair.server)
    const fourth = await session2.input.append("four")
    expect(fourth.events.map((event) => event.seq)).toEqual([4])

    // ---- the door: connect with the PREVIOUS instance's cursor --------------
    const resumes: Array<string | undefined> = []
    const handle = await bounded(
      connect({
        transport: transports.stdio({ transport: pair.client }),
        resumeFromSeq: 1,
        onConnectionState: (state) => {
          if (state.status === "connected") resumes.push(state.resume)
        },
      }),
      "door connect() across the restart",
    )

    // Crown: incremental EVENT replay [2..4] — never a snapshot reset.
    expect(serverSent.filter((m) => m.kind === "snapshot")).toEqual([])
    const replayed: SessionEvent[] = []
    handle.subscribe((event) => {
      replayed.push(event)
    })
    expect(replayed.map((event) => event.seq)).toEqual([2, 3, 4])
    // Identity across the restart: seq 2 is the PERSISTED instance-1 event.
    expect(replayed[0]?.eventId).toBe(seq2EventId)
    // Loud outcome surfacing on the door channel.
    expect(resumes).toContain("replayed")
    expect(resumes).not.toContain("snapshot_fallback")
    expect(handle.lastSeq()).toBe(4)

    // ---- the handle is fully live: dispatch a real turn through the wire ----
    const appendReceipt = await handle.input.append("post-resume prompt")
    expect(appendReceipt.submitted).toBe(true)
    await handle.turn.run()
    const end = await bounded(handle.awaitTurnEnd(), "awaitTurnEnd after resume")
    expect(end.type).toBe("turn.completed")
    // The live events kept flowing on the same wire, past the replayed window.
    expect(replayed.some((event) => event.type === "turn.completed")).toBe(true)

    await handle.close()
    await connected.close()
    await session2.close()
    await runtime2.close()
  })
})
