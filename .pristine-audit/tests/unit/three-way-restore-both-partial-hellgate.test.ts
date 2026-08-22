/**
 * GAP-CLOSER (leaf audit, jul-18) — `defaultThreeWayRestore.restoreBoth`
 * REAL-COMPOSITION partial-failure + short-circuit paths.
 *
 * The existing `per-tool-checkpoint-hellgate` D-block proves each leg in
 * isolation and the happy `restoreBoth`; the `checkpoint-rollback-*` tests
 * exercise `restoreBoth` only through a HAND-MOCKED `ThreeWayRestorePort`
 * (they replace the whole port). NEITHER drives the REAL
 * `defaultThreeWayRestore.restoreBoth` composition through its two mixed-
 * outcome branches:
 *
 *   1. files leg SUCCEEDS, task leg FAILS  → the composed outcome is
 *      `ok:false` BUT keeps the file-leg `filesChanged` (partial success the
 *      surface renders) and the forward loop is NOT rolled back — the
 *      already-restored files stay restored, no task mutation is attempted.
 *   2. files leg FAILS                      → the task leg is NEVER attempted
 *      (short-circuit); the conversation store is never touched (forward-loop
 *      independence: a failed files rewind cannot silently mutate the task).
 *
 * These are the load-bearing "never mutates the forward loop on a partial
 * failure" invariants for `/rewind-tool both`. Hermetic fakes; no git/tmp.
 */

import { describe, expect, test } from "bun:test"
import { defaultThreeWayRestore } from "@/agent/per-tool-checkpoint"
import type {
  GranularCheckpointEntry,
  GranularRegistry,
  GranularRegistryStats,
} from "@/agent/per-tool-checkpoint/port"
import type { Message } from "@/llm"
import { type ShadowOdb, ShadowOdbError } from "@/storage/shadow-odb"

/* ------------------------------------------------------------------ */
/* hermetic fakes                                                       */
/* ------------------------------------------------------------------ */

/** A single-entry registry that resolves `TAG` → a fixed sha, else null. */
const makeRegistry = (tag: string, sha = "abc123"): GranularRegistry => {
  const entry: GranularCheckpointEntry = {
    tag,
    granularity: "tool",
    sha,
    takenAt: 0,
  }
  const stats: GranularRegistryStats = {
    entryCount: 1,
    entryCap: 200,
    counterCount: 0,
    counterCap: 200,
  }
  return {
    list: () => [entry],
    lookup: (t) => (t === tag ? entry : null),
    stats: () => stats,
    clear: () => {},
  }
}

const makeOdb = (over: Partial<ShadowOdb>): ShadowOdb => {
  const ni = (n: string) => async (): Promise<never> => {
    throw new Error(`fake odb: ${n} not implemented`)
  }
  return {
    init: ni("init") as ShadowOdb["init"],
    registerHead: ni("registerHead") as ShadowOdb["registerHead"],
    diffSinceLast: over.diffSinceLast ?? (ni("diffSinceLast") as ShadowOdb["diffSinceLast"]),
    diffWorkspaceSinceLast: ni("diffWorkspaceSinceLast") as ShadowOdb["diffWorkspaceSinceLast"],
    rewindToLast: over.rewindToLast ?? (ni("rewindToLast") as ShadowOdb["rewindToLast"]),
    restorePartial: ni("restorePartial") as ShadowOdb["restorePartial"],
    markVerified: ni("markVerified") as ShadowOdb["markVerified"],
    rewindToVerified: ni("rewindToVerified") as ShadowOdb["rewindToVerified"],
    listSnapshots: over.listSnapshots ?? (ni("listSnapshots") as ShadowOdb["listSnapshots"]),
    rewindToRef: over.rewindToRef ?? (ni("rewindToRef") as ShadowOdb["rewindToRef"]),
    restorePartialFromRef: ni("restorePartialFromRef") as ShadowOdb["restorePartialFromRef"],
    diffSinceRef: over.diffSinceRef ?? (ni("diffSinceRef") as ShadowOdb["diffSinceRef"]),
    cleanup: ni("cleanup") as ShadowOdb["cleanup"],
  }
}

/** A conversation store spy: records every `restore` call so we can prove the
 *  task leg was (or was NOT) consulted. `snapshot=null` ⇒ task leg fails with
 *  `task-snapshot-missing`. */
const makeStoreSpy = (snapshot: Message[] | null) => {
  const restoreCalls: string[] = []
  const store = {
    record: () => {},
    restore: (tag: string): readonly Message[] | null => {
      restoreCalls.push(tag)
      return snapshot
    },
    list: () => [],
    clear: () => {},
    // biome-ignore lint/suspicious/noExplicitAny: only `restore` is exercised
  } as any
  return { store, restoreCalls }
}

const TAG = "tool:edit_file:call_42"

/* ================================================================== */
/* 1. files OK, task FAILS → partial outcome, forward loop untouched    */
/* ================================================================== */

describe("restoreBoth REAL composition — files OK / task FAILS (partial)", () => {
  test("PARTIAL-1: task snapshot missing ⇒ ok:false but filesChanged preserved (files stayed restored)", async () => {
    let rewinds = 0
    const odb = makeOdb({
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
      }),
      rewindToRef: async () => {
        rewinds += 1
        return { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 }
      },
    })
    const { store, restoreCalls } = makeStoreSpy(null) // task leg will fail
    const restore = defaultThreeWayRestore({
      registry: makeRegistry(TAG),
      workspace: "/ws",
      shadowOdb: odb,
      conversationStore: store,
    })

    const out = await restore.restoreBoth(TAG, {
      currentMessages: [{ role: "user", content: [{ type: "text", text: "live" }] }],
    })

    // Composed outcome is a FAILURE (task leg lost) ...
    expect(out.ok).toBe(false)
    // ... but the file leg genuinely ran (rewind happened once) and its metadata
    // is carried on the partial outcome so the surface can show what changed.
    expect(rewinds).toBe(1)
    expect(out.filesChanged).toEqual(["src/a.ts"])
    // The task leg WAS attempted (its failure is why we're here) exactly once.
    expect(restoreCalls).toEqual([TAG])
    // No task snapshot leaked into the outcome (the leg failed).
    expect(out.messagesAfter).toBeUndefined()
    expect(out.message).toContain("files restored OK but task leg failed")
  })
})

/* ================================================================== */
/* 2. files FAIL → task leg NEVER attempted (short-circuit)             */
/* ================================================================== */

describe("restoreBoth REAL composition — files FAIL short-circuits task", () => {
  test("SHORTCIRCUIT-1: files rewind throws ⇒ task leg NEVER consulted, outcome = files error", async () => {
    const odb = makeOdb({
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
        diff: "",
      }),
      rewindToRef: async () => {
        throw new ShadowOdbError("merge-in-progress", "MERGE_HEAD exists")
      },
    })
    const { store, restoreCalls } = makeStoreSpy([
      { role: "user", content: [{ type: "text", text: "snap" }] },
    ])
    const restore = defaultThreeWayRestore({
      registry: makeRegistry(TAG),
      workspace: "/ws",
      shadowOdb: odb,
      conversationStore: store,
    })

    const out = await restore.restoreBoth(TAG, {
      currentMessages: [{ role: "user", content: [{ type: "text", text: "live" }] }],
    })

    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("shadow-rewind-failed")
    expect(out.originalCode).toBe("merge-in-progress")
    // FORWARD-LOOP INDEPENDENCE: a failed file leg must NOT have touched the
    // conversation store at all. Zero restore calls = task leg short-circuited.
    expect(restoreCalls).toEqual([])
    expect(out.messagesAfter).toBeUndefined()
  })

  test("SHORTCIRCUIT-2 (red-on-injection guard): if the short-circuit regressed, restoreCalls would be non-empty", async () => {
    // Control: prove the spy actually observes calls (so SHORTCIRCUIT-1's
    // `[]` is a real observation, not a spy that never records). Here the file
    // leg SUCCEEDS so the task leg IS reached — the same spy records it.
    const odb = makeOdb({
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
        diff: "",
      }),
      rewindToRef: async () => ({
        ref: "refs/quanta/snapshots/last-registered",
        sha: "abc123",
        timestampSec: 1,
      }),
    })
    const { store, restoreCalls } = makeStoreSpy([
      { role: "user", content: [{ type: "text", text: "snap" }] },
    ])
    const restore = defaultThreeWayRestore({
      registry: makeRegistry(TAG),
      workspace: "/ws",
      shadowOdb: odb,
      conversationStore: store,
    })
    const out = await restore.restoreBoth(TAG, { currentMessages: [] })
    expect(out.ok).toBe(true)
    expect(restoreCalls).toEqual([TAG]) // spy DOES observe when the leg runs
  })
})
