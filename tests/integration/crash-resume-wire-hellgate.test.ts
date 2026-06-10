import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeSession } from "@/sdk/runtime"
import type { CrashResumeOffer } from "@/session"
import {
  CRASH_RESUME_GATE,
  CRASH_RESUME_PARTIAL_GATE,
  clearSessionInterrupted,
  listSessions,
  loadSessionById,
  markSessionInterrupted,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
// ADR-0528 — the runner-level wiring module under test.
// ADR-0528 L2 auto-reinject + L3 partial seams.
import {
  attachCrashResumePartial,
  bootstrapCrashResumeOffers,
  selectCrashResumeReinject,
  withCrashResumeMarker,
} from "../../src/runner/orchestrate/crash-resume-wire"
import { ExternalPromptQueue } from "../../src/runner/orchestrate/external-prompt-queue"
// The LIVE turn chokepoint every surface funnels through (the wiring site).
import { runSessionTurn } from "../../src/runner/orchestrate/session-turn-driver"
// AUDIT #13 test-only drain — settles fire-and-forget marker writes so the
// fresh-readback below is deterministic (no timing sleeps).
import { __drainCrashResumeMarkerWrites } from "../../src/session/crash-resume"

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
      {
        userText: "the interrupted task",
        partialAssistantText: "started",
        reason: "crash",
        interruptedAt: 9,
      },
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

  test("L2 auto-reinject: ONLY the current session's interrupt is a reinject candidate (no stranger-task injection)", () => {
    const mk = (id: string): CrashResumeOffer => ({
      sessionId: id,
      title: `T-${id}`,
      summary: `s-${id}`,
      resumeMessage: `resume ${id}`,
    })
    const offers = [mk("cur"), mk("other1"), mk("other2")]
    const r = selectCrashResumeReinject(offers, "cur")
    expect(r.own?.sessionId).toBe("cur")
    expect(r.own?.resumeMessage).toBe("resume cur")
    expect(r.others.map((o) => o.sessionId)).toEqual(["other1", "other2"])
    // FENCE: a fresh/new session (id not among offers) auto-reinjects NOTHING —
    // a stranger session's task must never be seeded into the current session.
    expect(selectCrashResumeReinject(offers, "fresh-id").own).toBeUndefined()
    expect(selectCrashResumeReinject(offers, "fresh-id").others.length).toBe(3)
    expect(selectCrashResumeReinject(offers, undefined).own).toBeUndefined()
  })

  test("L2 auto-reinject: a seeded prompt is delivered IMMEDIATELY (wins the loop's prompt-source race ⇒ runs as turn-1)", async () => {
    const q = new ExternalPromptQueue<string>()
    q.push("resume the interrupted task")
    // `next()` resolves without any stdin — the seed is already queued, so in the
    // loop's `Promise.race([rawLineReader, queue.next()])` the seed wins.
    expect(await q.next()).toBe("resume the interrupted task")
  })

  test("L3 partial: accumulates turn.output.delta, flushes the partial on EACH tool.invoked (event-driven, no per-token churn)", () => {
    type Ev = { type: string; delta?: string }
    let listener: ((ev: Ev) => void) | undefined
    const session = {
      subscribe: (l: (ev: Ev) => void) => {
        listener = l
        return () => {
          listener = undefined
        }
      },
    }
    const flushed: string[] = []
    const dispose = attachCrashResumePartial(
      session,
      {
        sessionId: "p1",
        userText: "task",
        env: { [CRASH_RESUME_GATE]: "1", [CRASH_RESUME_PARTIAL_GATE]: "1" },
      },
      async (p) => {
        flushed.push(p)
      },
    )
    expect(listener).toBeDefined() // subscribed (both gates on)
    listener?.({ type: "turn.output.delta", delta: "I will " })
    listener?.({ type: "turn.output.delta", delta: "edit foo" })
    expect(flushed).toEqual([]) // no flush mid-text (no tool boundary yet ⇒ no churn)
    listener?.({ type: "tool.invoked" }) // BEFORE the risky tool ⇒ flush the partial so far
    expect(flushed).toEqual(["I will edit foo"])
    listener?.({ type: "turn.output.delta", delta: " then test" })
    listener?.({ type: "tool.invoked" })
    expect(flushed).toEqual(["I will edit foo", "I will edit foo then test"]) // cumulative
    dispose()
    expect(listener).toBeUndefined()
  })

  test("L3 partial default-OFF: base gate on but PARTIAL gate absent ⇒ NEVER subscribes (no-op)", () => {
    let subscribed = false
    const session = {
      subscribe: () => {
        subscribed = true
        return () => undefined
      },
    }
    const dispose = attachCrashResumePartial(
      session,
      { sessionId: "p2", userText: "x", env: { [CRASH_RESUME_GATE]: "1" } }, // partial gate OFF
      async () => undefined,
    )
    expect(subscribed).toBe(false)
    dispose()
  })

  test("AUDIT #13 hellgate: an in-flight partial flush landing AFTER turn resolve is DISCARDED — final on-disk state is the post-resolve state (fresh readback)", async () => {
    // The audited race (jun-10 silent-failure #13): `void flush(partial)` is an
    // unserialized whole-session read-modify-write. A flush that STARTED before
    // the turn resolved (slow storage) must NOT land after the resolve path's
    // clear — that would re-instate the interrupted marker on a session that
    // completed cleanly (ghost resume offer on next restart).
    process.env[CRASH_RESUME_PARTIAL_GATE] = "1"
    __resetRuntimeConfig()
    await seed("race1")
    type Ev = { type: string; delta?: string }
    let listener: ((ev: Ev) => void) | undefined
    const session = {
      subscribe: (l: (ev: Ev) => void) => {
        listener = l
        return () => {
          listener = undefined
        }
      },
    }
    let releaseFlush!: () => void
    const slowStorage = new Promise<void>((r) => {
      releaseFlush = r
    })
    let flushLanded!: () => void
    const landed = new Promise<void>((r) => {
      flushLanded = r
    })
    const markerArgs = {
      sessionId: "race1",
      userText: "long task",
      env: process.env,
      now: () => 7_000,
    }
    // Injected SLOW storage seam: the flush's write is IN FLIGHT (started, not
    // yet landed) when the turn resolves — exactly the audited window. It
    // performs the REAL persistence op (real observable effect on disk), and
    // forwards the staleness probe the wire hands it.
    const detach = attachCrashResumePartial(
      session,
      markerArgs,
      async (partial: string, ctx?: { readonly isStale: () => boolean }) => {
        await slowStorage
        await markSessionInterrupted(
          "race1",
          {
            userText: "long task",
            partialAssistantText: partial,
            reason: "in-progress",
            interruptedAt: 7_001,
          },
          { env: process.env, ...(ctx !== undefined ? { staleIf: ctx.isStale } : {}) },
        )
        flushLanded()
      },
    )
    const turnP = withCrashResumeMarker(markerArgs, async () => {
      listener?.({ type: "turn.output.delta", delta: "half-done work" })
      listener?.({ type: "tool.invoked" }) // flush A starts — blocked inside slow storage
      return "ok"
    })
    expect(await turnP).toBe("ok")
    // Post-resolve fresh readback: the resolve path cleared the marker.
    expect((await loadSessionById("race1"))?.meta.interruptedTurn).toBeUndefined()
    releaseFlush() // NOW let the in-flight flush try to land — AFTER the resolve path
    await landed
    detach()
    // FRESH READBACK: the stale in-flight flush must have been DISCARDED — the
    // last state written is the NEWEST (post-resolve) state, not flush A's.
    const after = await loadSessionById("race1")
    expect(after?.meta.interruptedTurn).toBeUndefined()
    expect(JSON.stringify(after)).not.toContain("half-done work")
  })

  test("AUDIT #13 hellgate: dispose() fences an in-flight flush — a flush landing after detach is a stale no-op", async () => {
    // Same race through the OTHER fence: the disposer (the driver calls it at
    // turn teardown). A flush already in flight when dispose() runs must be
    // discarded, not land afterwards and resurrect a marker the resolve path
    // (here: an explicit clear) already removed.
    process.env[CRASH_RESUME_PARTIAL_GATE] = "1"
    __resetRuntimeConfig()
    await seed("race2")
    type Ev = { type: string; delta?: string }
    let listener: ((ev: Ev) => void) | undefined
    const session = {
      subscribe: (l: (ev: Ev) => void) => {
        listener = l
        return () => {
          listener = undefined
        }
      },
    }
    let releaseFlush!: () => void
    const slowStorage = new Promise<void>((r) => {
      releaseFlush = r
    })
    let flushLanded!: () => void
    const landed = new Promise<void>((r) => {
      flushLanded = r
    })
    const markerArgs = { sessionId: "race2", userText: "task", env: process.env, now: () => 1_000 }
    const detach = attachCrashResumePartial(
      session,
      markerArgs,
      async (partial: string, ctx?: { readonly isStale: () => boolean }) => {
        await slowStorage
        await markSessionInterrupted(
          "race2",
          {
            userText: "task",
            partialAssistantText: partial,
            reason: "in-progress",
            interruptedAt: 1_001,
          },
          { env: process.env, ...(ctx !== undefined ? { staleIf: ctx.isStale } : {}) },
        )
        flushLanded()
      },
    )
    // Simulate the turn: mark, stream a partial, start the (slow) flush.
    await markSessionInterrupted(
      "race2",
      { userText: "task", partialAssistantText: "", reason: "in-progress", interruptedAt: 1_000 },
      { env: process.env },
    )
    listener?.({ type: "turn.output.delta", delta: "stale partial" })
    listener?.({ type: "tool.invoked" }) // flush A in flight, blocked
    detach() // teardown fence — everything still in flight is now stale
    await clearSessionInterrupted("race2", { env: process.env })
    expect((await loadSessionById("race2"))?.meta.interruptedTurn).toBeUndefined()
    releaseFlush()
    await landed
    // Fresh readback: the detached flush must NOT have re-instated the marker.
    expect((await loadSessionById("race2"))?.meta.interruptedTurn).toBeUndefined()
  })

  test("AUDIT #13 wiring proof: the PROD default flush (no injected impl) honors the dispose fence — in-flight write discarded", async () => {
    // No flushImpl ⇒ the wire's REAL default (markSessionInterrupted) runs. The
    // dispose fence is raised in the same sync frame the flush dispatched in,
    // i.e. while its async RMW is in flight — the probe must trip inside the
    // store and discard the write.
    process.env[CRASH_RESUME_PARTIAL_GATE] = "1"
    __resetRuntimeConfig()
    await seed("dflt1")
    type Ev = { type: string; delta?: string }
    let listener: ((ev: Ev) => void) | undefined
    const session = {
      subscribe: (l: (ev: Ev) => void) => {
        listener = l
        return () => {
          listener = undefined
        }
      },
    }
    const detach = attachCrashResumePartial(session, {
      sessionId: "dflt1",
      userText: "task",
      env: process.env,
      now: () => 3_000,
    })
    listener?.({ type: "turn.output.delta", delta: "doomed partial" })
    listener?.({ type: "tool.invoked" }) // default flush in flight (async RMW just started)
    detach() // fence raised while the write is in flight
    await __drainCrashResumeMarkerWrites("dflt1")
    const after = await loadSessionById("dflt1")
    expect(after?.meta.interruptedTurn).toBeUndefined()
    expect(JSON.stringify(after)).not.toContain("doomed partial")
  })

  test("AUDIT #13 paired control: with NO fence the PROD default flush LANDS the partial (discard is not unconditional)", async () => {
    process.env[CRASH_RESUME_PARTIAL_GATE] = "1"
    __resetRuntimeConfig()
    await seed("dflt2")
    type Ev = { type: string; delta?: string }
    let listener: ((ev: Ev) => void) | undefined
    const session = {
      subscribe: (l: (ev: Ev) => void) => {
        listener = l
        return () => {
          listener = undefined
        }
      },
    }
    const detach = attachCrashResumePartial(session, {
      sessionId: "dflt2",
      userText: "live task",
      env: process.env,
      now: () => 4_000,
    })
    listener?.({ type: "turn.output.delta", delta: "real progress" })
    listener?.({ type: "tool.invoked" })
    await __drainCrashResumeMarkerWrites("dflt2")
    // Fresh readback: the un-fenced flush wrote the marker through the real path.
    const marker = (await loadSessionById("dflt2"))?.meta.interruptedTurn
    expect(marker?.partialAssistantText).toBe("real progress")
    expect(marker?.userText).toBe("live task")
    expect(marker?.interruptedAt).toBe(4_000)
    detach()
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
