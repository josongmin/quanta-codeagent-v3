/**
 * ★ HELLGATE — RFC-03 C2 (web parity, REOPEN leg): reopening a persisted web
 * thread RESTORES its durable objective into the LIVE, session-stable authority,
 * RE-KEYED onto the reopening boot's read key.
 *
 * THE GAP (pre-fix): the SAVE leg works — a completed web turn persists the goal
 * into `SavedSession.objective`. But REOPEN did NOT restore it. Worse, a first
 * "fix" that planted the snapshot VERBATIM under its persisted threadId was INERT:
 * the web daemon reads its objective under `config.sessionId` === `base.sessionId`,
 * a FRESH `crypto.randomUUID()` minted EACH daemon boot (one session, no id). The
 * snapshot is keyed by the SAVING boot's id, which can NEVER equal the reopening
 * boot's read key — so a verbatim plant lands under a key no live turn ever reads
 * (goal orphaned; the reopened thread still shows empty). This is the exact
 * per-boot-random-key mismatch two adversarial audits caught.
 *
 * THE FIX: `restoreObjectiveSnapshotInto(authority, snapshot, liveKey)` RE-KEYS the
 * (single) persisted web domain onto `liveKey` — the reopening session's live
 * objective read key (`sharedSession.sessionId` === base.sessionId === the tools'
 * ctx.ownerId), wired in the server's `onAttachThread`. So a goal saved under the
 * OLD boot id becomes readable under the NEW boot id. No-clobber still guards a
 * goal already live on `liveKey`; mid-turn refusal restores nothing.
 *
 * KEY DISCIPLINE (what the pre-fix test masked by using ONE literal for all roles):
 *   SAVING_KEY  — the objective domain key at SAVE time (saving boot's session id).
 *   LIVE_KEY    — the objective domain key at REOPEN time (a DIFFERENT boot's id).
 *   THREAD      — the persisted THREAD id being reopened (stable across boots).
 * In production SAVING_KEY ≠ LIVE_KEY ≠ THREAD; the tests below keep them distinct
 * so a verbatim (non-re-keyed) plant is provably invisible under LIVE_KEY.
 *
 * Invariants proven:
 *   [P1] reopen ⇒ the goal (+ right revision/criteria) is readable under LIVE_KEY,
 *        NOT under the persisted SAVING_KEY (RED on unfixed: null under LIVE_KEY).
 *   [R1] omit the restore call ⇒ authority empty (the original drop).
 *   [R2] restore WITHOUT the re-key (verbatim plant) ⇒ goal lands under SAVING_KEY,
 *        invisible under LIVE_KEY — the exact inert-seam the audits caught.
 *   [C1] TOOLS off ⇒ no authority ⇒ no-op (no throw).
 *   [C2] a thread that NEVER had an objective ⇒ nothing restored.
 *   [C3] mid-turn refusal ⇒ NO restore.
 *   [C4] no-clobber: a goal already live on LIVE_KEY is kept (older disk ignored).
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

// THREE distinct keys — see KEY DISCIPLINE above. The saving/reopening objective
// domain keys are per-boot random UUIDs in production (base.sessionId); the thread
// id is the stable persisted identity being reopened.
const SAVING_KEY = "saving-boot-session-id"
const LIVE_KEY = "reopening-boot-session-id"
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

/**
 * Drive the REAL reopen path exactly as the server's `onAttachThread` closure does:
 * load the persisted thread, replace the transcript, repoint persistence, and
 * (when `restore`) restore the objective — RE-KEYED onto `liveKey` (the value the
 * server passes as `sharedSession.sessionId`). `rekey:false` reproduces the inert
 * pre-fix verbatim plant.
 */
const reopen = async (
  root: SessionRootProvider,
  liveAuthority: ObjectivePort | undefined,
  opts: { restore: boolean; rekey?: boolean; midTurn?: boolean },
) =>
  hydrateThreadIntoLiveSession(THREAD, {
    loadThread: async (id) => await loadSessionById(id, root),
    replaceTranscript: async () => {
      if (opts.midTurn === true) throw new Error("transcript_replace_unavailable")
    },
    setActiveThreadId: () => undefined,
    ...(opts.restore
      ? {
          prepareObjectiveAttach: (snap) => ({
            commit: () => {
              restoreObjectiveSnapshotInto(
                liveAuthority,
                snap,
                opts.rekey === false ? undefined : LIVE_KEY,
              )
              return true
            },
          }),
        }
      : {}),
  })

/** Save a goal under SAVING_KEY (≠ LIVE_KEY) and persist it under THREAD. */
const seedDisk = async (root: SessionRootProvider, goal: string, withStatusBump = false) => {
  const saver = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
  expect(saver).toBeDefined()
  saver?.create(SAVING_KEY, { goal, successCriteria: ["tests pass"] }) // rev 1
  if (withStatusBump) saver?.setExplicitStatus(SAVING_KEY, "paused") // rev 2
  const snapshot = encodeObjectiveSnapshot(saver as ObjectivePort)
  // The snapshot is keyed by SAVING_KEY — NOT the live key, NOT the thread id.
  expect(snapshot.threads[0]?.threadId).toBe(SAVING_KEY)
  await persist(root, snapshot)
  return snapshot
}

describe("HELLGATE RFC-03 C2 (web parity) — reopen re-keys the durable objective onto the live read key", () => {
  test("[P1] reopen ⇒ goal + revision/criteria readable under LIVE_KEY, not the persisted SAVING_KEY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      const snap = await seedDisk(root, GOAL, true)
      expect(snap.threads[0]?.revision).toBe(2)

      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      expect(live?.get(LIVE_KEY)).toBeNull() // RED baseline: empty before restore

      const outcome = await reopen(root, live, { restore: true, rekey: true })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })

      // THE FIX — the goal is re-keyed onto the LIVE read key the model reads under.
      const restored = live?.get(LIVE_KEY)
      expect(restored?.goal).toBe(GOAL)
      expect(restored?.successCriteria.map((c) => c.text)).toEqual(["tests pass"])
      expect(asObjectiveAuthority(live as ObjectivePort).readDomain(LIVE_KEY).revision).toBe(2)
      // And NOT orphaned under the persisted saving-boot key.
      expect(live?.get(SAVING_KEY)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[R1] RED-on-injection: omit the restore call ⇒ reopen leaves the authority EMPTY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-r1-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      await seedDisk(root, GOAL)
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      const outcome = await reopen(root, live, { restore: false })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })
      expect(live?.get(LIVE_KEY)).toBeNull()
      expect(live?.get(SAVING_KEY)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[R2] RED-on-injection: restore WITHOUT re-key (verbatim plant) ⇒ goal orphaned under SAVING_KEY, invisible under LIVE_KEY (the inert seam the audits caught)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-r2-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      await seedDisk(root, GOAL)
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      // The pre-fix verbatim behavior: plant under the snapshot's own key.
      await reopen(root, live, { restore: true, rekey: false })
      // The exact production bug: the model (reading LIVE_KEY) sees NOTHING …
      expect(live?.get(LIVE_KEY)).toBeNull()
      // … while the goal sits orphaned under the saving-boot key no turn reads.
      expect(live?.get(SAVING_KEY)?.goal).toBe(GOAL)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C1] TOOLS off ⇒ no authority ⇒ restore is a byte-identical no-op (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-off-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      const snap = await seedDisk(root, GOAL)
      const live = mintAuthority({}) // TOOLS off ⇒ undefined
      expect(live).toBeUndefined()
      const outcome = await reopen(root, live, { restore: true, rekey: true })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })
      expect(() => restoreObjectiveSnapshotInto(undefined, snap, LIVE_KEY)).not.toThrow()
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
      const outcome = await reopen(root, live, { restore: true, rekey: true })
      expect(outcome).toEqual({ kind: "hydrated", threadId: THREAD, count: 1 })
      expect(live?.get(LIVE_KEY)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C3] mid-turn refusal ⇒ NO restore (the restore hook never fires)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-mid-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      await seedDisk(root, GOAL)
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      const outcome = await reopen(root, live, { restore: true, rekey: true, midTurn: true })
      expect(outcome).toEqual({ kind: "refused-mid-turn", threadId: THREAD })
      expect(live?.get(LIVE_KEY)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("[C4] no-clobber: a goal already live on LIVE_KEY is kept (older disk snapshot ignored)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-obj-reopen-clobber-"))
    const root: SessionRootProvider = { resolve: async () => dir }
    try {
      await seedDisk(root, "OLD disk goal")
      const live = mintAuthority({ QUANTA_OBJECTIVE_TOOLS: "1" })
      live?.create(LIVE_KEY, { goal: "NEW live goal" }) // already live on the read key
      await reopen(root, live, { restore: true, rekey: true })
      expect(live?.get(LIVE_KEY)?.goal).toBe("NEW live goal")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
