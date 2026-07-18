/**
 * Ticket 05 CROWN HELLGATE — durable resume across a runtime RESTART
 * (docs/plans/jul-16-transport-unified-sdk/05-durable-resume-composition.md §4).
 *
 * The wire promise under test: after a process restart, `connect` with a
 * resumeFromSeq from the PREVIOUS instance is answered with an incremental
 * EVENT replay read from the on-disk JSONL log (W4-b substrate) — NOT the
 * full-snapshot fallback the memory-only bridge is forced into today — and the
 * client surfaces the outcome on its `onConnectionState` connected payload
 * (`resume: "replayed"`). Degradations must be LOUD: a log that cannot fill
 * the gap falls back to the snapshot AND surfaces `resume: "snapshot_fallback"`.
 *
 * Battery:
 *   (crown) restart → attach → live append (bridge tail) → client resume from a
 *           pre-restart seq ⇒ events-only replay [gap..tip] with the LOG↔TAIL
 *           seam merged (no dup / no hole), identity-proven against the
 *           instance-1 event (same eventId across the restart), then a LIVE
 *           event lands strictly AFTER the replayed segment. resume="replayed".
 *           RED-ON-INJECTION (i): removing the engine's durableLog injection
 *           into the bridge turns the replay into a snapshot fallback — the
 *           no-snapshot + "replayed" assertions here go red.
 *   (gap)   a hole punched into the on-disk log (middle line removed) ⇒ the
 *           bridge refuses a discontiguous replay, falls back to the snapshot,
 *           and the client says so: resume="snapshot_fallback" (silent
 *           demotion = red).
 *   (control) gate OFF (InMemory log, no port injected) ⇒ the wire is
 *           byte-identical to the historical behavior: restart resets seq, an
 *           old resume cursor is ahead-of-tip, full snapshot — pinned exactly.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import {
  createSessionTransportClient,
  type SessionTransport,
  type SessionTransportConnectionState,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionHost } from "@/kernel/session"
import { decodeSessionEvent } from "@/protocol/session"
import { createRuntime } from "@/sdk/runtime"
import { capabilitiesFor } from "../../support/session-fixtures"

const ENV_KEY = "QUANTA_SESSION_EVENT_LOG_DIR"

const CAPABILITIES = capabilitiesFor()

const makeHost = (sessionId: string): SessionHost => ({
  describe: () => ({
    sessionId,
    permissionMode: "default",
    capabilityManifest: CAPABILITIES,
  }),
  runTurn: async () => {
    throw new Error("not exercised")
  },
  close: async () => undefined,
})

/** Symmetric in-memory duplex (same shape as tests/unit/ipc/session-transport
 *  .test.ts) — `send` delivers synchronously to the remote handlers, so the
 *  bridge's replay answer completes within the client's `connect()` await. */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  let clientClosed = false
  let serverClosed = false

  const build = (
    local: Set<(message: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(message: SessionTransportMessage) => void | Promise<void>>,
    isLocalClosed: () => boolean,
    closeLocal: () => void,
  ): SessionTransport => ({
    async send(message) {
      if (isLocalClosed()) return
      for (const handler of [...remote]) {
        await handler(message)
      }
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      closeLocal()
      local.clear()
    },
  })

  return {
    client: build(
      clientHandlers,
      serverHandlers,
      () => clientClosed,
      () => {
        clientClosed = true
      },
    ),
    server: build(
      serverHandlers,
      clientHandlers,
      () => serverClosed,
      () => {
        serverClosed = true
      },
    ),
  }
}

const tmpDirs: string[] = []
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-t05-durable-resume-"))
  tmpDirs.push(dir)
  return dir
}

/** Save/restore the gate env var around every test (bun runs files in one
 *  process — a leaked env var would flip OTHER suites' composition). */
const savedEnv = process.env[ENV_KEY]
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const eventSeqs = (messages: readonly SessionTransportMessage[]): number[] =>
  messages.flatMap((message) => (message.kind === "event" ? [message.event.seq] : []))

const snapshotFrames = (messages: readonly SessionTransportMessage[]) =>
  messages.filter((message) => message.kind === "snapshot")

const connectedStates = (states: readonly SessionTransportConnectionState[]) =>
  states.flatMap((state) => (state.status === "connected" ? [state] : []))

/** Instance 1 of the restarted pair: appends "one"(seq1) + "two"(seq2), then a
 *  graceful close (seq3 `session.closed`). Returns the seq-2 eventId so the
 *  crown test can prove replay IDENTITY across the restart boundary. */
const runFirstInstance = async (sessionId: string): Promise<{ seq2EventId: string }> => {
  const runtime = await createRuntime({
    host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
  })
  const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
  const first = await session.input.append("one")
  expect(first.events.map((event) => event.seq)).toEqual([1])
  const second = await session.input.append("two")
  expect(second.events.map((event) => event.seq)).toEqual([2])
  const seq2EventId = second.events[0]?.eventId
  if (seq2EventId === undefined) throw new Error("instance-1 seq-2 event missing")
  await session.close()
  await runtime.close()
  return { seq2EventId }
}

describe("ticket 05 — durable resume across a runtime restart (crown hellgate)", () => {
  test("CROWN: restart → resume replays the disconnect window from the on-disk log (no snapshot), seam log↔tail merged, resume='replayed'", async () => {
    const dir = freshDir()
    process.env[ENV_KEY] = dir
    const sessionId = "t05-crown-resume"

    // ---- instance 1: on-disk seqs [1, 2, 3] then a full process-shape close --
    const { seq2EventId } = await runFirstInstance(sessionId)

    // ---- instance 2: NEW runtime, SAME dir+sessionId (seq resumes at tip 3) --
    const runtime2 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session2 = await runtime2.createSession({ cwd: "/tmp", permissionMode: "default" })

    // Attach FIRST (bridge snapshot pinned at the restart tip)…
    const pair = createTransportPair()
    const connected = await session2.attachSessionTransport(pair.server)
    // …then dispatch seq 4 — a POST-restart event. The engine folds published
    // events into the bridge snapshot immediately, so the replay below is
    // served from the LOG for the whole window [2..4]: pre-restart events
    // (2, 3) AND the post-restart one (4) must arrive as one dense, dedup'd
    // segment spanning the restart boundary. (The log↔live-tail OVERLAP seam
    // — reachable in raw-bridge composition and in the publish/updateSnapshot
    // race window — is pinned at wire level in
    // tests/unit/ipc/session-transport-durable-replay.test.ts.)
    const fourth = await session2.input.append("four")
    expect(fourth.events.map((event) => event.seq)).toEqual([4])

    const inbound: SessionTransportMessage[] = []
    const states: SessionTransportConnectionState[] = []
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId,
      resumeFromSeq: 1, // the previous instance's observed high-water mark
    })
    client.onMessage((message) => {
      inbound.push(message)
    })
    client.onConnectionState((state) => {
      states.push(state)
    })
    await client.connect()

    // THE crown assertion: an incremental EVENT replay — not a snapshot reset.
    expect(snapshotFrames(inbound)).toEqual([])
    expect(eventSeqs(inbound)).toEqual([2, 3, 4])
    expect(
      inbound.flatMap((message) => (message.kind === "event" ? [message.event.type] : [])),
    ).toEqual(["session.state.updated", "session.closed", "session.state.updated"])
    // Identity across the restart: seq 2 is the PERSISTED instance-1 event
    // (same eventId), not a re-synthesized stand-in.
    const replayedSeq2 = inbound.find(
      (message) => message.kind === "event" && message.event.seq === 2,
    )
    expect(replayedSeq2?.kind === "event" ? replayedSeq2.event.eventId : undefined).toBe(
      seq2EventId,
    )

    // Loud outcome surfacing: submission `connected` first, then the derived
    // `resume: "replayed"` enrichment — and never a snapshot_fallback.
    const connectedSeen = connectedStates(states)
    expect(connectedSeen[0]).toEqual({ status: "connected" })
    expect(connectedSeen.at(-1)).toEqual({ status: "connected", resume: "replayed" })
    expect(connectedSeen.some((state) => state.resume === "snapshot_fallback")).toBe(false)

    // Live ordering: a post-replay dispatch lands strictly AFTER the replayed
    // segment on the same wire (no interleave into the replay).
    const fifth = await session2.input.append("five")
    expect(fifth.events.map((event) => event.seq)).toEqual([5])
    expect(eventSeqs(inbound)).toEqual([2, 3, 4, 5])

    await client.close()
    await connected.close()
    await session2.close()
    await runtime2.close()
  })

  test("GAP: a hole punched into the on-disk log forces the snapshot fallback AND surfaces resume='snapshot_fallback' (silent demotion = red)", async () => {
    const dir = freshDir()
    process.env[ENV_KEY] = dir
    const sessionId = "t05-gap-resume"

    await runFirstInstance(sessionId)

    // Punch a hole: drop the seq-2 line from the closed log (lock released).
    const file = join(dir, `${sessionId}.jsonl`)
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
    const kept = lines.filter((line) => decodeSessionEvent(line).seq !== 2)
    expect(kept.length).toBe(lines.length - 1)
    writeFileSync(file, kept.map((line) => `${line}\n`).join(""))

    const runtime2 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session2 = await runtime2.createSession({ cwd: "/tmp", permissionMode: "default" })
    const pair = createTransportPair()
    const connected = await session2.attachSessionTransport(pair.server)

    const inbound: SessionTransportMessage[] = []
    const states: SessionTransportConnectionState[] = []
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId,
      resumeFromSeq: 1,
    })
    client.onMessage((message) => {
      inbound.push(message)
    })
    client.onConnectionState((state) => {
      states.push(state)
    })
    await client.connect()

    // The log cannot fill (2, 3] densely ⇒ snapshot fallback, snapshot FIRST.
    expect(inbound[0]?.kind).toBe("snapshot")
    // …and the demotion is SURFACED, not silent (05 acceptance line 2).
    const connectedSeen = connectedStates(states)
    expect(connectedSeen.at(-1)).toEqual({ status: "connected", resume: "snapshot_fallback" })
    expect(connectedSeen.some((state) => state.resume === "replayed")).toBe(false)

    await client.close()
    await connected.close()
    await session2.close()
    await runtime2.close()
  })

  test("CONTROL: gate OFF (InMemory, no port injected) keeps the historical wire byte-identical — restart resets seq, old cursor is ahead-of-tip, full snapshot", async () => {
    delete process.env[ENV_KEY]
    const sessionId = "t05-inmemory-control"

    // Instance 1 (nothing persists — the InMemory log dies with the runtime).
    const runtime1 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session1 = await runtime1.createSession({ cwd: "/tmp", permissionMode: "default" })
    await session1.input.append("one")
    const second = await session1.input.append("two")
    expect(second.events.map((event) => event.seq)).toEqual([2])
    await session1.close()
    await runtime1.close()

    // Instance 2: seq restarts at 0 (historical behavior — no durable tip).
    const runtime2 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session2 = await runtime2.createSession({ cwd: "/tmp", permissionMode: "default" })
    const pair = createTransportPair()
    const connected = await session2.attachSessionTransport(pair.server)
    const fresh = await session2.input.append("post-restart")
    expect(fresh.events.map((event) => event.seq)).toEqual([1])

    const inbound: SessionTransportMessage[] = []
    const client = createSessionTransportClient({
      transport: pair.client,
      sessionId,
      resumeFromSeq: 2, // instance-1 high-water mark — AHEAD of the reset tip
    })
    client.onMessage((message) => {
      inbound.push(message)
    })
    await client.connect()

    // Pinned pre-05 wire, exactly: one full snapshot (tail already folded into
    // it by the bridge's trim — seq 1 ≤ snapshot.seq), zero event frames.
    expect(inbound.map((message) => message.kind)).toEqual(["snapshot"])
    expect(inbound[0]?.kind === "snapshot" ? inbound[0].snapshot.seq : undefined).toBe(1)

    await client.close()
    await connected.close()
    await session2.close()
    await runtime2.close()
  })
})
