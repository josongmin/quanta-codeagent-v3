import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CRASH_RESUME_GATE,
  listSessions,
  loadSessionById,
  markSessionInterrupted,
  type SavePayload,
  saveSessionById,
  type SessionMeta,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
// ADR-0528 — the runner-level wiring module under test.
import {
  bootstrapCrashResumeOffers,
  withCrashResumeMarker,
} from "../../src/runner/orchestrate/crash-resume-wire"
// The LIVE turn chokepoint every surface funnels through (the wiring site).
import { runSessionTurn } from "../../src/runner/orchestrate/session-turn-driver"
import type { RuntimeSession } from "@/sdk/runtime"

/**
 * ADR-0528 CROWN JEWEL (live wiring) — the §13.2 module (ADR-0525) is built but
 * UNWIRED. ADR-0525's own hellgate calls `markSessionInterrupted`/`detect`
 * MANUALLY (simulating the host). This proves the AUTOMATIC wiring the runner
 * must add:
 *
 *   - `withCrashResumeMarker(args, fn)` persists an in-progress marker BEFORE
 *     `fn` (the turn) runs — so a process death ANYWHERE inside the turn is
 *     recoverable — and clears it after the turn resolves (process survived).
 *   - `bootstrapCrashResumeOffers` turns the restart-detection into operator
 *     offers (the host bootstrap calls this).
 *
 * Fails against pre-0528 code: the module does not exist, so the turn never
 * auto-marks and a restart never auto-detects.
 */

const ON = { [CRASH_RESUME_GATE]: "1" }

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})
const seed = (id: string): Promise<unknown> =>
  saveSessionById(mkMeta(id), {
    reason: "in_progress",
    turns: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "prior" }] }],
  } as SavePayload)

describe("ADR-0528 crash-resume LIVE wiring", () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    env = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "crash-resume-wire-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    Object.assign(process.env, ON)
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
    Object.assign(process.env, env)
    __resetRuntimeConfig()
  })

  test("marks the turn IN-PROGRESS before the turn body, clears after a clean turn", async () => {
    await seed("s1")
    let markerDuringTurn: unknown
    const result = await withCrashResumeMarker(
      { sessionId: "s1", userText: "refactor the parser", env: process.env, now: () => 5_000 },
      async () => {
        // Mid-turn: a crash RIGHT NOW must be recoverable ⇒ marker already on disk.
        const snap = await loadSessionById("s1")
        markerDuringTurn = snap?.meta.interruptedTurn
        return "turn-result"
      },
    )
    expect(result).toBe("turn-result")
    // mark-at-start contract:
    expect((markerDuringTurn as { userText?: string })?.userText).toBe("refactor the parser")
    expect((markerDuringTurn as { reason?: string })?.reason).toBe("in-progress")
    expect((markerDuringTurn as { interruptedAt?: number })?.interruptedAt).toBe(5_000)
    // cleared after the turn resolved (process survived ⇒ not a crash):
    const after = await loadSessionById("s1")
    expect(after?.meta.interruptedTurn).toBeUndefined()
  })

  test("a THROW inside the turn still clears in finally, but the marker WAS live mid-turn", async () => {
    await seed("s2")
    let markerDuringTurn: unknown
    await expect(
      withCrashResumeMarker(
        { sessionId: "s2", userText: "do X", env: process.env, now: () => 1 },
        async () => {
          const snap = await loadSessionById("s2")
          markerDuringTurn = snap?.meta.interruptedTurn
          throw new Error("boom")
        },
      ),
    ).rejects.toThrow("boom")
    expect((markerDuringTurn as { userText?: string })?.userText).toBe("do X") // recoverable window existed
    const after = await loadSessionById("s2")
    expect(after?.meta.interruptedTurn).toBeUndefined() // finally cleared (process survived the throw)
  })

  test("bootstrapCrashResumeOffers turns a persisted marker into an operator offer", async () => {
    await seed("s3")
    await markSessionInterrupted(
      "s3",
      { userText: "the interrupted task", partialAssistantText: "started", reason: "crash", interruptedAt: 9 },
      { env: process.env },
    )
    const offers = await bootstrapCrashResumeOffers(await listSessions({ includeArchived: true }), {
      env: process.env,
    })
    expect(offers.length).toBe(1)
    expect(offers[0]?.summary).toContain("interrupted mid-turn")
    expect(offers[0]?.resumeMessage).toContain("the interrupted task")
  })

  test("LIVE PATH: runSessionTurn (the real chokepoint) auto-marks mid-turn + clears after — severing the bracket goes RED", async () => {
    await seed("live1")
    let markerDuringTurn: unknown
    // Minimal fake RuntimeSession exercising the exact methods runSessionTurn
    // touches: input.append → turn.run (one clean turn, no approval).
    const fakeSession = {
      input: { append: async () => undefined },
      turn: {
        run: async () => {
          // Mid-turn: a SIGKILL right now must be recoverable ⇒ marker on disk.
          markerDuringTurn = (await loadSessionById("live1"))?.meta.interruptedTurn
          return { turn: { messages: [], outcome: { reason: "completed" } } }
        },
      },
      approval: { respond: async () => undefined },
    } as unknown as RuntimeSession

    const res = await runSessionTurn({
      session: fakeSession,
      resolveApproval: async () => "approve",
      text: "live crash-resume task",
      turnSignal: new AbortController().signal,
      sessionId: "live1",
    })
    expect(res.outcome.reason).toBe("completed")
    // The marker was LIVE during the turn (mark-at-start through the real driver):
    expect((markerDuringTurn as { userText?: string })?.userText).toBe("live crash-resume task")
    expect((markerDuringTurn as { reason?: string })?.reason).toBe("in-progress")
    // ...and cleared once the turn resolved (process survived):
    expect((await loadSessionById("live1"))?.meta.interruptedTurn).toBeUndefined()
  })

  test("LIVE PATH default-OFF: gate absent ⇒ runSessionTurn writes no marker", async () => {
    delete process.env[CRASH_RESUME_GATE]
    __resetRuntimeConfig()
    await seed("live2")
    let markerDuringTurn: unknown = "sentinel"
    const fakeSession = {
      input: { append: async () => undefined },
      turn: {
        run: async () => {
          markerDuringTurn = (await loadSessionById("live2"))?.meta.interruptedTurn
          return { turn: { messages: [], outcome: { reason: "completed" } } }
        },
      },
      approval: { respond: async () => undefined },
    } as unknown as RuntimeSession
    await runSessionTurn({
      session: fakeSession,
      resolveApproval: async () => "approve",
      text: "x",
      turnSignal: new AbortController().signal,
      sessionId: "live2",
    })
    expect(markerDuringTurn).toBeUndefined()
  })

  test("DEFAULT-OFF: gate absent ⇒ withCrashResumeMarker writes NO marker (byte-identical)", async () => {
    delete process.env[CRASH_RESUME_GATE]
    __resetRuntimeConfig()
    await seed("s4")
    let markerDuringTurn: unknown = "sentinel"
    await withCrashResumeMarker(
      { sessionId: "s4", userText: "x", env: process.env, now: () => 1 },
      async () => {
        markerDuringTurn = (await loadSessionById("s4"))?.meta.interruptedTurn
      },
    )
    expect(markerDuringTurn).toBeUndefined() // never written
    const offers = await bootstrapCrashResumeOffers(await listSessions({ includeArchived: true }), {
      env: process.env,
    })
    expect(offers).toEqual([])
  })
})
