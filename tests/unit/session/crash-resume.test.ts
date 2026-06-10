import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildCrashResumeMessage,
  buildCrashResumeOffer,
  CRASH_RESUME_GATE,
  clearSessionInterrupted,
  crashResumeEnabled,
  detectInterruptedSessions,
  type InterruptedSessionDetection,
  listSessions,
  loadSessionById,
  markSessionInterrupted,
  type PersistedInterruptedTurn,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * §13.2 (jun-08 long-tail) — PERSISTED interrupted-turn marker + crash resume.
 *
 * Discipline pinned here:
 *   - default-OFF BYTE-IDENTITY: with the gate ABSENT, mark/clear are no-ops and
 *     the on-disk session file is byte-for-byte the pre-marker form; detect
 *     returns [].
 *   - with the gate ON: mark persists the marker, clear drops it, detect finds
 *     it (most-recent first), and the pure offer/message builders reconstruct
 *     the resume continuation.
 *   - NEVER throws on a missing session.
 */

const ON = { [CRASH_RESUME_GATE]: "1" }
const OFF = {} as Record<string, string | undefined>

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

const mkTurn = (over: Partial<PersistedInterruptedTurn> = {}): PersistedInterruptedTurn => ({
  userText: over.userText ?? "refactor the parser",
  partialAssistantText: over.partialAssistantText ?? "I started by reading parser.ts",
  reason: over.reason ?? "crash",
  interruptedAt: over.interruptedAt ?? 5_000,
})

describe("§13.2 crash resume — persisted interrupted-turn marker", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "crash-resume-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  const seed = async (id: string) =>
    saveSessionById(mkMeta(id), {
      reason: "completed",
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })

  test("crashResumeEnabled reflects the gate (default OFF, opt-in ON)", () => {
    expect(crashResumeEnabled(OFF)).toBe(false)
    expect(crashResumeEnabled(ON)).toBe(true)
    expect(crashResumeEnabled({ [CRASH_RESUME_GATE]: "on" })).toBe(true)
  })

  test("BYTE-IDENTITY: gate OFF ⇒ mark is a no-op, the file is unchanged", async () => {
    await seed("s1")
    const before = readFileSync(sessionFilePath("s1"), "utf8")
    await markSessionInterrupted("s1", mkTurn(), { env: OFF })
    const after = readFileSync(sessionFilePath("s1"), "utf8")
    expect(after).toBe(before)
    // And no marker is present on load.
    const loaded = await loadSessionById("s1")
    expect(loaded?.meta.interruptedTurn).toBeUndefined()
  })

  test("BYTE-IDENTITY: gate OFF ⇒ detect returns [] even when a marker is on disk", async () => {
    // Force a marker on disk via the gate-ON path, then verify the gate-OFF
    // detect refuses to surface it (default-OFF behavior).
    await seed("s1")
    await markSessionInterrupted("s1", mkTurn(), { env: ON })
    const list = await listSessions({ includeArchived: true })
    expect(await detectInterruptedSessions(list, { env: OFF })).toEqual([])
  })

  test("gate ON ⇒ mark persists the marker onto the snapshot", async () => {
    await seed("s1")
    await markSessionInterrupted("s1", mkTurn({ reason: "SIGKILL" }), { env: ON })
    const loaded = await loadSessionById("s1")
    expect(loaded?.meta.interruptedTurn).toBeDefined()
    expect(loaded?.meta.interruptedTurn?.reason).toBe("SIGKILL")
    expect(loaded?.meta.interruptedTurn?.userText).toBe("refactor the parser")
  })

  test("gate ON ⇒ clear drops the marker", async () => {
    await seed("s1")
    await markSessionInterrupted("s1", mkTurn(), { env: ON })
    expect((await loadSessionById("s1"))?.meta.interruptedTurn).toBeDefined()
    await clearSessionInterrupted("s1", { env: ON })
    expect((await loadSessionById("s1"))?.meta.interruptedTurn).toBeUndefined()
  })

  test("detect returns markers most-recent-first", async () => {
    await seed("old")
    await seed("new")
    await markSessionInterrupted("old", mkTurn({ interruptedAt: 1_000 }), { env: ON })
    await markSessionInterrupted("new", mkTurn({ interruptedAt: 9_000 }), { env: ON })
    const list = await listSessions({ includeArchived: true })
    const found = await detectInterruptedSessions(list, { env: ON })
    expect(found.map((f) => f.sessionId)).toEqual(["new", "old"])
  })

  test("NEVER throws: mark/clear on a missing session are silent no-ops", async () => {
    await expect(markSessionInterrupted("ghost", mkTurn(), { env: ON })).resolves.toBeUndefined()
    await expect(clearSessionInterrupted("ghost", { env: ON })).resolves.toBeUndefined()
  })

  test("AUDIT #13: `staleIf` discards an in-flight mark (no write — file byte-identical, prior marker survives)", async () => {
    // jun-10 silent-failure #13: a partial-flush write that became STALE while
    // its read-modify-write was in flight must be DISCARDED at the store, not
    // land and roll the snapshot back. `staleIf` is the wire's epoch probe,
    // evaluated inside the RMW (between load and save).
    await seed("s1")
    await markSessionInterrupted("s1", mkTurn({ userText: "fresh state" }), { env: ON })
    const before = readFileSync(sessionFilePath("s1"), "utf8")
    await markSessionInterrupted("s1", mkTurn({ userText: "stale flush" }), {
      env: ON,
      staleIf: () => true,
    })
    // Fresh readback: the stale write never landed.
    expect(readFileSync(sessionFilePath("s1"), "utf8")).toBe(before)
    expect((await loadSessionById("s1"))?.meta.interruptedTurn?.userText).toBe("fresh state")
    // Paired control: a NON-stale probe writes normally (the discard is not an
    // unconditional drop).
    await markSessionInterrupted("s1", mkTurn({ userText: "newer state" }), {
      env: ON,
      staleIf: () => false,
    })
    expect((await loadSessionById("s1"))?.meta.interruptedTurn?.userText).toBe("newer state")
  })

  test("clear is a no-op (no snapshot churn) when there is no marker", async () => {
    await seed("s1")
    const before = readFileSync(sessionFilePath("s1"), "utf8")
    await clearSessionInterrupted("s1", { env: ON })
    expect(readFileSync(sessionFilePath("s1"), "utf8")).toBe(before)
  })

  describe("pure offer/message builders", () => {
    const det: InterruptedSessionDetection = {
      sessionId: "s1",
      title: "Parser work",
      interruptedTurn: mkTurn(),
    }

    test("buildCrashResumeMessage frames the task + partial progress", () => {
      const msg = buildCrashResumeMessage(det.interruptedTurn)
      expect(msg).toContain("Resume the previously interrupted task")
      expect(msg).toContain("crash")
      expect(msg).toContain("refactor the parser")
      expect(msg).toContain("partial progress")
      expect(msg).toContain("I started by reading parser.ts")
    })

    test("buildCrashResumeMessage omits the progress section when there is none", () => {
      const msg = buildCrashResumeMessage(mkTurn({ partialAssistantText: "   " }))
      expect(msg).not.toContain("partial progress")
    })

    test("buildCrashResumeOffer produces a clipped one-line summary + resume message", () => {
      const offer = buildCrashResumeOffer(det)
      expect(offer.sessionId).toBe("s1")
      expect(offer.summary).toContain("Parser work")
      expect(offer.summary).toContain("refactor the parser")
      expect(offer.resumeMessage).toBe(buildCrashResumeMessage(det.interruptedTurn))
    })

    test("offer summary clips an overlong prompt to a single line with an ellipsis", () => {
      const long = "x".repeat(200)
      const offer = buildCrashResumeOffer({
        sessionId: "s2",
        title: "T",
        interruptedTurn: mkTurn({ userText: `${long}\nsecond line` }),
      })
      expect(offer.summary).toContain("…")
      expect(offer.summary.includes("second line")).toBe(false)
    })
  })
})
