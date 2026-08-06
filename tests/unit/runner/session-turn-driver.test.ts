/**
 * Behavioral contract for the hoisted turn driver (`@/runner/orchestrate`).
 *
 * The thin-surface hellgate only checks the driver EXISTS and is terminal-free;
 * this proves it actually BEHAVES like the loop it replaced — driving a fake
 * `RuntimeSession` and pinning the load-bearing details the byte-identical claim
 * rests on: append signature, the approval-resolution loop, both verbatim error
 * strings, and the normalized result shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOutcome } from "@/agent"
import { driveSessionTurn, type WorktreeCwdPort } from "@/runner/orchestrate"
import type { RuntimeSession, SessionDispatchResult } from "@/sdk/runtime"
import {
  makeWorkspaceCreateIntent,
  type SessionMeta,
  saveSessionById,
  transitionWorkspaceState,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const OUTCOME: AgentOutcome = { reason: "completed" } as AgentOutcome

interface Recorder {
  appends: Array<{ text: string; opts: unknown }>
  responds: Array<{ id: string; decision: string }>
}

/** A scripted fake session: `turns` is the queue of dispatch results
 *  `session.turn.run` yields in order. Records appends + approval responses. */
const fakeSession = (turns: SessionDispatchResult[], rec: Recorder): RuntimeSession => {
  let i = 0
  return {
    input: {
      append: async (text: string, opts: unknown) => {
        rec.appends.push({ text, opts })
      },
    },
    turn: {
      run: async () => {
        const t = turns[i++]
        if (t === undefined) throw new Error("fake session: turn queue exhausted")
        return t
      },
    },
    approval: {
      respond: async (id: string, decision: string) => {
        rec.responds.push({ id, decision })
      },
    },
  } as unknown as RuntimeSession
}

const turnPayload = (approvalReq?: { approvalId: string; reason: string }): SessionDispatchResult =>
  ({
    turn: {
      messages: [],
      outcome: OUTCOME,
      ...(approvalReq !== undefined ? { approvalRequest: approvalReq } : {}),
    },
  }) as unknown as SessionDispatchResult

describe("driveSessionTurn — behavioral contract", () => {
  test("no-approval turn: appends once (no image opts) and returns normalized result", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const result = await driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session: fakeSession([turnPayload()], rec),
      resolveApproval: async () => "approve",
      text: "hello",
      turnSignal: new AbortController().signal,
    })
    expect(rec.appends).toHaveLength(1)
    expect(rec.appends[0]?.text).toBe("hello")
    // no images ⇒ the second arg is undefined (not an empty {images:[]})
    expect(rec.appends[0]?.opts).toBeUndefined()
    expect(rec.responds).toHaveLength(0)
    expect(result.messages).toEqual([])
    expect(result.outcome).toBe(OUTCOME)
    expect(result.outcomeReason).toBe("completed")
  })

  test("approval loop: resolves, responds, and re-runs until no approvalRequest", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    let asked = 0
    const result = await driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session: fakeSession(
        [turnPayload({ approvalId: "ap1", reason: "needs_it" }), turnPayload()],
        rec,
      ),
      resolveApproval: async () => {
        asked += 1
        return "approve"
      },
      text: "do it",
      turnSignal: new AbortController().signal,
    })
    expect(asked).toBe(1)
    expect(rec.responds).toEqual([{ id: "ap1", decision: "approve" }])
    expect(result.outcomeReason).toBe("completed")
  })

  test("deny throws the verbatim approval-denied error (fails closed)", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const run = driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session: fakeSession(
        [turnPayload({ approvalId: "ap1", reason: "terminal.x" }), turnPayload()],
        rec,
      ),
      resolveApproval: async () => "deny",
      text: "x",
      turnSignal: new AbortController().signal,
    })
    await expect(run).rejects.toThrow("runtime session approval denied (terminal.x)")
    // it DID respond deny before throwing
    expect(rec.responds).toEqual([{ id: "ap1", decision: "deny" }])
  })

  test("missing turn payload throws the verbatim error", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const run = driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session: fakeSession([{ revision: 1, seq: 1, events: [] }], rec),
      resolveApproval: async () => "approve",
      text: "x",
      turnSignal: new AbortController().signal,
    })
    await expect(run).rejects.toThrow("runtime session turn completed without a turn payload")
  })

  test("beforeTurn host hook fires BEFORE append", async () => {
    const order: string[] = []
    await driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session: {
        input: {
          append: async () => {
            order.push("append")
          },
        },
        turn: { run: async () => turnPayload() },
        approval: { respond: async () => undefined },
      } as unknown as RuntimeSession,
      resolveApproval: async () => "approve",
      text: "x",
      turnSignal: new AbortController().signal,
      beforeTurn: () => order.push("beforeTurn"),
    })
    expect(order).toEqual(["beforeTurn", "append"])
  })

  test("passes images through as { images } when present", async () => {
    const rec: Recorder = { appends: [], responds: [] }
    const img = { type: "image", source: {} } as never
    await driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session: fakeSession([turnPayload()], rec),
      resolveApproval: async () => "approve",
      text: "look",
      images: [img],
      turnSignal: new AbortController().signal,
    })
    expect(rec.appends[0]?.opts).toEqual({ images: [img] })
  })
})

/* RFC-06 §RFC06-2 — FRONT-DOOR proof: a REAL `driveSessionTurn` (the SSOT turn
 * chokepoint every surface funnels through) pins the working cwd to a session's
 * owned worktree AT the next turn boundary, driven off the PERSISTED
 * `workspaceOwnership` a prior transition wrote — and a turn in flight is NEVER
 * disturbed (the chdir lands strictly BEFORE `input.append`, once). */
describe("driveSessionTurn — RFC06-2 worktree cwd pin (front door)", () => {
  const PIN = "QUANTA_WORKTREE_CWD_PIN"
  const REPO = "/repo/root"
  const WT = "/repo/root/.quanta/worktrees/wt-42"
  let sessionsDir: string

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "std-wcp-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
    delete process.env[PIN]
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    delete process.env.QUANTA_SESSIONS_DIR
    delete process.env[PIN]
    __resetRuntimeConfig()
  })

  /** Persist a session whose thread already owns a `ready` worktree (the state a
   *  completed `transitionThreadToWorktree` leaves behind). */
  const persistReadyOwnership = async (id: string): Promise<void> => {
    const intent = makeWorkspaceCreateIntent({
      ownershipId: "own-42",
      ownerThreadId: id,
      repoRoot: REPO,
      repoId: REPO,
      path: WT,
      branch: "fork-42",
      baseSha: "HEAD",
      now: 1,
    })
    const ready = transitionWorkspaceState(intent, "ready", 2)
    if (!ready.ok) throw new Error("ready transition failed")
    const meta: SessionMeta = {
      id,
      title: "t",
      cwd: REPO,
      createdAt: 1,
      lastTouched: 1,
      archived: false,
      workspaceOwnership: ready.record,
    }
    await saveSessionById(meta, { reason: "t", turns: 0, messages: [] })
  }

  /** A recording session that logs an `append`/`turn.run` timeline AND lets a
   *  chdir port record ITS timeline, so we can prove ordering across both. */
  const timelineSession = (timeline: string[]): RuntimeSession =>
    ({
      input: {
        append: async () => {
          timeline.push("append")
        },
      },
      turn: {
        run: async () => {
          timeline.push("turn.run")
          return turnPayload()
        },
      },
      approval: { respond: async () => undefined },
    }) as unknown as RuntimeSession

  const recordingPort = (
    timeline: string[],
    startAt = REPO,
  ): WorktreeCwdPort & { here: string } => {
    const state = { here: startAt }
    return {
      get here() {
        return state.here
      },
      cwd: () => state.here,
      chdir: (t: string) => {
        timeline.push(`chdir:${t}`)
        state.here = t
        return t
      },
    }
  }

  test("gate ON + persisted `ready` ownership ⇒ next turn runs with cwd = the owned worktree", async () => {
    await persistReadyOwnership("s1")
    process.env[PIN] = "1"
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await driveSessionTurn({
      env: { ...process.env },
      session: timelineSession(timeline),
      resolveApproval: async () => "approve",
      text: "go",
      turnSignal: new AbortController().signal,
      sessionId: "s1",
      cwdPin: port,
    })
    // The cwd is now the owned worktree, and the swap landed at the boundary —
    // strictly BEFORE the turn's first append and turn.run (mid-turn untouched).
    expect(port.here).toBe(WT)
    expect(timeline).toEqual([`chdir:${WT}`, "append", "turn.run"])
  })

  test("mid-turn is NOT disturbed: chdir fires exactly ONCE, before the body", async () => {
    await persistReadyOwnership("s1")
    process.env[PIN] = "1"
    const timeline: string[] = []
    const port = recordingPort(timeline)
    await driveSessionTurn({
      env: { ...process.env },
      // Two-round turn (approval then completion): the pin must NOT re-fire on
      // the internal approval re-run — it is a turn-BOUNDARY op, not per-round.
      session: (() => {
        const rec: Recorder = { appends: [], responds: [] }
        const s = fakeSession([turnPayload({ approvalId: "ap1", reason: "x" }), turnPayload()], rec)
        return s
      })(),
      resolveApproval: async () => "approve",
      text: "go",
      turnSignal: new AbortController().signal,
      sessionId: "s1",
      cwdPin: port,
    })
    // Exactly one chdir for the whole turn (both internal rounds), at the top.
    expect(timeline).toEqual([`chdir:${WT}`])
  })

  test("gate OFF ⇒ NO chdir, cwd unchanged (turn loop byte-identical)", async () => {
    await persistReadyOwnership("s1")
    // gate unset (default-OFF)
    const timeline: string[] = []
    const port = recordingPort(timeline)
    const rec: Recorder = { appends: [], responds: [] }
    await driveSessionTurn({
      env: { ...process.env },
      session: fakeSession([turnPayload()], rec),
      resolveApproval: async () => "approve",
      text: "go",
      turnSignal: new AbortController().signal,
      sessionId: "s1",
      cwdPin: port,
    })
    expect(timeline).toEqual([])
    expect(port.here).toBe(REPO)
  })

  test("no cwdPin port ⇒ turn runs unchanged (the pre-follower path)", async () => {
    await persistReadyOwnership("s1")
    process.env[PIN] = "1" // even armed: absent port ⇒ no consumer.
    const rec: Recorder = { appends: [], responds: [] }
    const result = await driveSessionTurn({
      env: { ...process.env },
      session: fakeSession([turnPayload()], rec),
      resolveApproval: async () => "approve",
      text: "go",
      turnSignal: new AbortController().signal,
      sessionId: "s1",
    })
    expect(result.outcomeReason).toBe("completed")
    expect(rec.appends).toHaveLength(1)
  })
})
