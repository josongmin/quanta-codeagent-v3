/**
 * W4-b HELLGATE — on-disk KernelEventLogPort: restart seq CONTINUITY + gate.
 *
 * ADR-0540 Wave 2 item 0 (external requirement, witness = transport-unified-sdk
 * ticket 05): after a restart the kernel must RESUME seq issuance from the
 * on-disk log tip — without continuity, `connect({resume})` semantics cannot be
 * defined (a reconnecting client's resumeFromSeq high-water mark would collide
 * with re-issued low seqs; see the ahead-of-tip guard in ipc/session/bridge.ts).
 *
 * Battery here (composition level — the substrate battery lives in
 * tests/unit/kernel/event-log-jsonl.test.ts):
 *   (b) restart (NEW runtime instance, SAME dir) → events issued after restart
 *       continue from tip+1, proven by fresh-readback of the JSONL file through
 *       the @/protocol/session codec (not through the objects under test).
 *   (f) gate OFF (env unset/blank): persistence factory returns the plain
 *       InMemorySessionEventLog, ZERO disk contact (canary dir stays absent),
 *       and an explicitly-injected empty env is NOT bypassed via process.env.
 *   (g) permanent wiring-proof: createRuntimeSession CONSUMES eventLog.tip()
 *       for its initial seq (fake durable log tip=41 ⇒ first issued seq 42);
 *       paired control: the in-memory log (no tip) keeps the historical seq 1.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionPersistence, createSingleSessionRuntimeHost } from "@/host/runtime"
import type { SessionHost } from "@/kernel/session"
import { InMemorySessionEventLog, JsonlSessionEventLog, systemClock } from "@/kernel/session"
import { decodeSessionEvent, type SessionEvent } from "@/protocol/session"
import { createRuntime } from "@/sdk/runtime"
import { createRuntimeSession } from "@/sdk/runtime/session"
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

/** Fresh tmp dirs, cleaned up per test. */
const tmpDirs: string[] = []
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-w4b-resume-"))
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

describe("W4-b runtime event-log resume (seq continuity hellgate)", () => {
  test("(b) restart with the same dir resumes seq issuance at tip (no reset to 0)", async () => {
    const dir = freshDir()
    process.env[ENV_KEY] = dir
    const sessionId = "w4b-resume-e2e"

    // ---- instance 1: two appends + close ⇒ on-disk seqs [1, 2, 3] ----
    const runtime1 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session1 = await runtime1.createSession({ cwd: "/tmp", permissionMode: "default" })
    const first = await session1.input.append("one")
    expect(first.events.map((event) => event.seq)).toEqual([1])
    const second = await session1.input.append("two")
    expect(second.events.map((event) => event.seq)).toEqual([2])
    // Graceful close (releases the single-writer lock; also appends the
    // `session.closed` terminal at seq 3). Crash-shaped restarts (stale lock,
    // torn tail) are covered by the substrate battery.
    await session1.close()
    await runtime1.close()

    // ---- instance 2: NEW runtime, SAME dir + sessionId ⇒ continues at 4 ----
    const runtime2 = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost(sessionId)),
    })
    const session2 = await runtime2.createSession({ cwd: "/tmp", permissionMode: "default" })
    const resumed = await session2.input.append("three")
    // THE continuity assertion: issuance continues from the log tip, not 0.
    expect(resumed.events.map((event) => event.seq)).toEqual([4])
    expect(resumed.seq).toBe(4)
    await session2.close()
    await runtime2.close()

    // ---- fresh-readback: decode the raw JSONL through the protocol codec ----
    const file = join(dir, `${sessionId}.jsonl`)
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
    const events = lines.map((line) => decodeSessionEvent(line))
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(events.map((event) => event.type)).toEqual([
      "session.state.updated", // append "one"
      "session.state.updated", // append "two"
      "session.closed", // instance-1 close
      "session.state.updated", // append "three" (post-restart, CONTINUOUS)
      "session.closed", // instance-2 close
    ])
    // Strictly increasing across the restart boundary — the wire-resume invariant.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
    }
  })

  test("(g) wiring-proof: createRuntimeSession consumes eventLog.tip() for its initial seq", async () => {
    const appended: SessionEvent[] = []
    const fakeDurableLog = {
      append: (event: SessionEvent): void => {
        appended.push(event)
      },
      list: (): readonly SessionEvent[] => [...appended],
      tip: (): number => 41,
      readFrom: (afterSeq: number): SessionEvent[] =>
        appended.filter((event) => event.seq > afterSeq),
      close: (): void => undefined,
    }
    const session = createRuntimeSession({
      hostSession: makeHost("w4b-wiring"),
      kernel: { clock: systemClock, eventLog: fakeDurableLog },
    })
    const result = await session.input.append("after-resume")
    // Seam proof: initial kernel seq == tip(41) ⇒ the first issued event is 42.
    // Removing the tip-consumption seam in createRuntimeSession turns this 42
    // into 1 — this test IS the red-on-injection tripwire for the seam.
    expect(result.events.map((event) => event.seq)).toEqual([42])
    expect(appended.map((event) => event.seq)).toEqual([42])
    await session.close()
  })

  test("(g) durable log is released even when the host close throws (no lock leak)", async () => {
    let released = false
    const fakeDurableLog = {
      append: (): void => undefined,
      list: (): readonly SessionEvent[] => [],
      tip: (): number => 0,
      readFrom: (): SessionEvent[] => [],
      close: (): void => {
        released = true
      },
    }
    const throwingHost: SessionHost = {
      ...makeHost("w4b-close-throw"),
      close: async () => {
        throw new Error("host close exploded")
      },
    }
    const session = createRuntimeSession({
      hostSession: throwingHost,
      kernel: { clock: systemClock, eventLog: fakeDurableLog },
    })
    await expect(session.close()).rejects.toThrow("host close exploded")
    expect(released).toBe(true)
  })

  test("(g-control) in-memory log exposes no tip: fresh session still issues seq 1", async () => {
    const log = new InMemorySessionEventLog()
    const session = createRuntimeSession({
      hostSession: makeHost("w4b-wiring-control"),
      kernel: { clock: systemClock, eventLog: log },
    })
    const result = await session.input.append("first")
    expect(result.events.map((event) => event.seq)).toEqual([1])
    await session.close()
  })

  test("(f) gate OFF: factory returns InMemory and touches zero disk (incl. process.env bypass attack)", () => {
    const parent = freshDir()
    const canary = join(parent, "canary-event-logs")

    // Unset / blank / whitespace env values are all OFF.
    expect(createSessionPersistence({ sessionId: "s" }, {})).toBeInstanceOf(InMemorySessionEventLog)
    expect(createSessionPersistence({ sessionId: "s" }, { [ENV_KEY]: "" })).toBeInstanceOf(
      InMemorySessionEventLog,
    )
    expect(createSessionPersistence({ sessionId: "s" }, { [ENV_KEY]: "   " })).toBeInstanceOf(
      InMemorySessionEventLog,
    )

    // Bypass attack: the REAL process.env points at a canary dir, but the
    // caller injected an EMPTY env view — the factory must honor the injected
    // view (no secret process.env read) and must not create the canary.
    process.env[ENV_KEY] = canary
    const log = createSessionPersistence({ sessionId: "s" }, {})
    expect(log).toBeInstanceOf(InMemorySessionEventLog)
    expect(existsSync(canary)).toBe(false)
  })

  test("(f-on) gate ON: factory returns the JSONL log and creates <dir>/<sessionId>.jsonl", () => {
    const dir = join(freshDir(), "nested", "logs")
    const log = createSessionPersistence({ sessionId: "gate-on" }, { [ENV_KEY]: dir })
    expect(log).toBeInstanceOf(JsonlSessionEventLog)
    expect(existsSync(join(dir, "gate-on.jsonl"))).toBe(true)
    ;(log as JsonlSessionEventLog).close()
  })

  test("(f-e2e) gate OFF control: default composition starts issuance at seq 1", async () => {
    delete process.env[ENV_KEY]
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => makeHost("w4b-off-control")),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
    const result = await session.input.append("plain")
    expect(result.events.map((event) => event.seq)).toEqual([1])
    await session.close()
    await runtime.close()
  })
})
