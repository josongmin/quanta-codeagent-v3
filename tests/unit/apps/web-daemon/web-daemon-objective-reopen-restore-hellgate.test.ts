/**
 * ★ HELLGATE — RFC-03 C2 (web parity, REOPEN leg): reopening a persisted web
 * thread RESTORES its durable objective into the LIVE, session-stable authority.
 *
 * THE GAP (pre-fix): the SAVE leg works — a completed web turn persists the goal
 * into `SavedSession.objective` (decoupled-persistence hellgate). But REOPEN did
 * NOT: `hydrateThreadIntoLiveSession` → `attachSessionToLive` `transcript.replace`d
 * the messages and DROPPED the loaded `SavedSession.objective`, so the reopened
 * session's authority (`runtime.objectiveAuthority`) was EMPTY even though the goal
 * sat on disk. The CLI restores at construction (`resolveGatedObjectiveAuthority
 * ({restoreFrom})`); web mints its ONE authority BEFORE any thread id is known, so
 * it must restore at HYDRATE time.
 *
 * THE FIX: `hydrateThreadIntoLiveSession` surfaces the loaded objective snapshot
 * and, ONLY on the `hydrated` success path, calls `restoreObjective` — wired in the
 * server to `restoreObjectiveSnapshotInto(runtime.objectiveAuthority, snapshot)`,
 * which decodes each persisted thread and plants it VERBATIM (exact revision) via
 * the authority's `restoreDomain` seam, skipping any thread already live.
 *
 * RED-on-injection (captured, [R]): run the identical reopen with `restoreObjective`
 * OMITTED (the pre-fix wiring) ⇒ the authority stays EMPTY (the goal is lost). The
 * fixed path ([P1]) restores it. The controls ([C*]) stay green either way.
 *
 * Invariants proven:
 *   [P1] reopen a thread that had a goal ⇒ `authority.get(threadId)` returns the
 *        goal with the RIGHT revision + criteria (RED on unfixed: null/empty).
 *   [R]  omit the restore call ⇒ reopen leaves the authority empty (captured RED).
 *   [C1] TOOLS off ⇒ no authority ⇒ restore is a byte-identical no-op (no throw).
 *   [C2] a thread that NEVER had an objective ⇒ nothing restored (no empty-goal
 *        fabrication; `SavedSession.objective` absent).
 *   [C3] mid-turn refusal ⇒ NO restore (the restore hook never fires — parity with
 *        the transcript guard).
 *   [C4] no-clobber: reopening a thread ALREADY live in the authority keeps the
 *        LIVE goal (the older disk snapshot never overwrites it).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hydrateThreadIntoLiveSession } from "@/apps/web-daemon/server/thread-hydrate"
import {
  resolveGatedObjectiveAuthority,
  restoreObjectiveSnapshotInto,
} from "@/host/runtime/objective-store-wire"
import type { Message } from "@/llm"
import { asObjectiveAuthority, type ObjectivePort } from "@/objective"
import { encodeObjectiveSnapshot } from "@/runner/assemble/session-authorities"
import {
  loadSessionById,
  type PersistedObjectiveSnapshot,
  type SessionMeta,
  type SessionRootProvider,
  saveSessionById,
} from "@/session"

const THREAD = "thread-1"
const GOAL = "restore the durable goal on reopen"
const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] } as never]

const meta = (id: string): SessionMeta => ({
  id,
  title: id,
  cwd: "/repo",
  createdAt: 0,
  lastTouched: 0,
  archived: false,
})

/** Mint the SAME session-stable authority the web factory does (no `onConfirm`). */
const mintAuthority = (env: Record<string, string | undefined>): ObjectivePort | undefined =>
  resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })

/** Persist a SavedSession under `THREAD` with (optionally) an objective snapshot,
 *  exactly as the transcript-persist save would. */
const persist = async (
  root: SessionRootProvider,
  objective: PersistedObjectiveSnapshot | undefined,
): Promise<void> => {
  await saveSessionById(
    meta(THREAD),
    {
      reason: "web-turn",
      turns: 1,
      messages: msgs,
      ...(objective !== undefined ? { objective } : {}),
    },
    root,
  )
}

/** Drive the REAL reopen path: load the persisted thread, replace the transcript,
 *  repoint persistence, and (when `restore` is true) wire the objective restore to
 *  the live authority — precisely the server's `onAttachThread` closure. */
const reopen = async (
  root: SessionRootProvider,
  liveAuthority: ObjectivePort | undefined,
  opts: { restore: boolean; midTurn?: boolean },
) =>
  hydrateThreadIntoLiveSession(THREAD, {
    loadThread: async (id) => await loadSessionById(id, root),
    replaceTranscript: async () => {
      if (opts.midTurn === true) throw new Error("transcript_replace_unavailable")
    },
    setActiveThreadId: () => undefined,
    ...(opts.restore
      ? { restoreObjective: (snap) => restoreObjectiveSnapshotInto(liveAuthority, snap) }
      : {}),
  })

describe("HELLGATE RFC-03 C2 (web parity) — reopen restores the durable objective", () => {
  test("[P1] reopen a thread that had a goal ⇒ live authority.get(threadId) returns the goal + right revision/criteria", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      // SAVE leg: a session set a goal + criterion + a status bump (revision 2).
      const saver = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      expect(saver).toBeDefined()
      saver?.set(THREAD, { goal: GOAL, successCriteria: ["tests pass"] }) // rev 1
      saver?.updateStatus(THREAD, "paused") // rev 2
      const snapshot = encodeObjectiveSnapshot(saver as ObjectivePort)
      expect(snapshot.threads[0]?.revision).toBe(2)
      await persist(root, snapshot)

      // REOPEN leg: a FRESH session-stable authority that has never seen THREAD.
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      expect(live?.get(THREAD)).toBeNull() // RED baseline: empty before restore

      const outcome = await reopen(root, live, { restore: true })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })

      // THE FIX — goal, criteria, AND exact revision are back on the live authority.
      const restored = live?.get(THREAD)
      expect(restored?.goal).toBe(GOAL)
      expect(restored?.successCriteria.map((c) => c.text)).toEqual(["tests pass"])
      expect(asObjectiveAuthority(live as ObjectivePort).readDomain(THREAD).revision).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[R] RED-on-injection: omit the restore call ⇒ reopen leaves the authority EMPTY (captured pre-fix behavior)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-red-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      const saver = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      saver?.set(THREAD, { goal: GOAL })
      await persist(root, encodeObjectiveSnapshot(saver as ObjectivePort))

      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      // The pre-fix wiring: hydrate WITHOUT the restore hook. Transcript still swaps.
      const outcome = await reopen(root, live, { restore: false })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })
      // The goal is on disk but the live authority is still empty — the exact gap.
      expect(live?.get(THREAD)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C1] TOOLS off ⇒ no authority ⇒ restore is a byte-identical no-op (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-off-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      // Persist a snapshot (a session that ran with TOOLS on earlier).
      const saver = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      saver?.set(THREAD, { goal: GOAL })
      await persist(root, encodeObjectiveSnapshot(saver as ObjectivePort))

      // Reopen under TOOLS OFF ⇒ no live authority at all.
      const live = mintAuthority({})
      expect(live).toBeUndefined()
      const outcome = await reopen(root, live, { restore: true })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })
      // Nothing to restore into; the direct call is a no-op too.
      expect(() =>
        restoreObjectiveSnapshotInto(undefined, encodeObjectiveSnapshot(saver as ObjectivePort)),
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C2] a thread that never had an objective ⇒ nothing restored (no empty-goal fabrication)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-none-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      await persist(root, undefined) // SavedSession with NO objective
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      const outcome = await reopen(root, live, { restore: true })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })
      expect(live?.get(THREAD)).toBeNull() // no fabricated empty goal
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C3] mid-turn refusal ⇒ NO restore (the restore hook never fires)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-mid-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      const saver = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      saver?.set(THREAD, { goal: GOAL })
      await persist(root, encodeObjectiveSnapshot(saver as ObjectivePort))

      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      const outcome = await reopen(root, live, { restore: true, midTurn: true })
      expect(outcome).toEqual({ kind: "refused-mid-turn", threadId: THREAD })
      expect(live?.get(THREAD)).toBeNull() // parity with the transcript guard
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C4] no-clobber: reopening a thread ALREADY live keeps the live goal (older disk snapshot ignored)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-clobber-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      // On disk: an OLD goal.
      const saver = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      saver?.set(THREAD, { goal: "OLD disk goal" })
      await persist(root, encodeObjectiveSnapshot(saver as ObjectivePort))

      // Live: the SAME thread already carries a NEWER goal.
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      live?.set(THREAD, { goal: "NEW live goal" })

      await reopen(root, live, { restore: true })
      // The live goal is untouched — the older snapshot never clobbered it.
      expect(live?.get(THREAD)?.goal).toBe("NEW live goal")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
