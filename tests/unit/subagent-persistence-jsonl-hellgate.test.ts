/**
 * JSONL store hellgate — ADR-0158 Phase 1 + ADR-0159 Phase 2.
 *
 * Seals the on-disk semantics of `defaultJsonlSchedulerStore`:
 *
 *   A. save + load (5)
 *   B. list (4)
 *   C. delete + prune (4)
 *   D. Crash safety (3)
 *   E. "resumed" status disk roundtrip (1)  ← ADR-0159 guard
 *
 * Total = 17 cases. All on tmpdir under `os.tmpdir()` — no global state.
 */

import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultJsonlSchedulerStore,
  type PersistedHandle,
  PersistenceError,
} from "@/agent/subagent-persistence-store"

const newTmp = async (): Promise<string> => await mkdtemp(join(tmpdir(), "scheduler-hg-"))

/** Build a baseline handle; overrides merge over the default. */
const mkHandle = (id: string, over: Partial<PersistedHandle> = {}): PersistedHandle => ({
  id,
  spec: { task: `task-${id}` },
  status: "completed",
  startedAt: 1_000,
  endedAt: 2_000,
  turns: 1,
  outputSummary: "(ok)",
  hostPid: 12345,
  workspace: "/ws/A",
  ...over,
})

/* ====================================================================== */
/* A. save + load                                                          */
/* ====================================================================== */

describe("A. save + load", () => {
  test("HG-1: save then load returns the saved handle", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const h = mkHandle("bg-aaaa1111")
    await store.save(h)
    const got = await store.load(h.id)
    expect(got).not.toBeNull()
    expect(got?.id).toBe(h.id)
    expect(got?.spec.task).toBe("task-bg-aaaa1111")
    expect(got?.outputSummary).toBe("(ok)")
  })

  test("HG-2: load unknown id returns null", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const got = await store.load("bg-doesnotexist")
    expect(got).toBeNull()
  })

  test("HG-3: save twice — load returns the LATEST line", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const first = mkHandle("bg-update1", { status: "running", outputSummary: "(running)" })
    await store.save(first)
    const updated: PersistedHandle = {
      ...first,
      status: "completed",
      outputSummary: "(done)",
      endedAt: 3_000,
      outputDetail: "final answer",
    }
    await store.save(updated)
    const got = await store.load(first.id)
    expect(got?.status).toBe("completed")
    expect(got?.outputSummary).toBe("(done)")
    expect(got?.outputDetail).toBe("final answer")
  })

  test("HG-4: save with optional fields omitted — load has those keys OMITTED", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    // No endedAt/outputDetail/errorMessage/hostPid; status stays running.
    const h: PersistedHandle = {
      id: "bg-omitted1",
      spec: { task: "no-extras" },
      status: "running",
      startedAt: 50,
      turns: 0,
      outputSummary: "(running)",
      workspace: "/ws/A",
    }
    await store.save(h)
    const got = await store.load(h.id)
    expect(got).not.toBeNull()
    if (got === null) throw new Error("unreachable")
    // The KEYS themselves must be absent — exactOptionalPropertyTypes strict.
    expect("endedAt" in got).toBe(false)
    expect("outputDetail" in got).toBe(false)
    expect("errorMessage" in got).toBe(false)
    expect("hostPid" in got).toBe(false)
  })

  test("HG-5: save with deeply-nested SubagentSpec — faithful round-trip", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const h = mkHandle("bg-deep1", {
      spec: {
        task: 'deep task with newline\nand quote"chars',
        modelOverride: "gpt-5",
        maxTurns: 7,
        workspace: "/ws/X",
        metadata: { origin: "ci", priority: "high" },
      },
      workspace: "/ws/X",
    })
    await store.save(h)
    const got = await store.load(h.id)
    expect(got?.spec.task).toBe('deep task with newline\nand quote"chars')
    expect(got?.spec.modelOverride).toBe("gpt-5")
    expect(got?.spec.maxTurns).toBe(7)
    expect(got?.spec.metadata).toEqual({ origin: "ci", priority: "high" })
  })
})

/* ====================================================================== */
/* B. list                                                                 */
/* ====================================================================== */

describe("B. list", () => {
  test("HG-6: empty workspace returns []", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const out = await store.list("/ws/empty")
    expect(out).toEqual([])
  })

  test("HG-7: 3 handles same workspace — list sorted by startedAt DESC", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    await store.save(mkHandle("bg-a", { startedAt: 100, workspace: "/ws/A" }))
    await store.save(mkHandle("bg-b", { startedAt: 300, workspace: "/ws/A" }))
    await store.save(mkHandle("bg-c", { startedAt: 200, workspace: "/ws/A" }))
    const out = await store.list("/ws/A")
    expect(out.length).toBe(3)
    expect(out.map((h) => h.id)).toEqual(["bg-b", "bg-c", "bg-a"])
  })

  test("HG-8: list filters by workspace", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    await store.save(mkHandle("bg-ws1a", { workspace: "/ws/1" }))
    await store.save(mkHandle("bg-ws1b", { workspace: "/ws/1" }))
    await store.save(mkHandle("bg-ws2a", { workspace: "/ws/2" }))
    const ws1 = await store.list("/ws/1")
    const ws2 = await store.list("/ws/2")
    expect(ws1.map((h) => h.id).sort()).toEqual(["bg-ws1a", "bg-ws1b"])
    expect(ws2.map((h) => h.id)).toEqual(["bg-ws2a"])
  })

  test("HG-9: corrupt last line in one file — that file skipped, others still surface", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    await store.save(mkHandle("bg-good1", { workspace: "/ws/C" }))
    await store.save(mkHandle("bg-good2", { workspace: "/ws/C" }))
    // Inject a corrupt per-handle file directly into the workspace dir.
    // We need to know the workspace hash; rather than reimplementing it,
    // list the dir under baseDir.
    const wsHashes = await readdir(baseDir)
    expect(wsHashes.length).toBe(1)
    const wsDir = join(baseDir, wsHashes[0] ?? "")
    await writeFile(join(wsDir, "bg-corrupt.jsonl"), "{this is not json\n", "utf8")
    const out = await store.list("/ws/C")
    // bg-corrupt is skipped silently; bg-good1 + bg-good2 surface.
    const ids = out.map((h) => h.id).sort()
    expect(ids).toEqual(["bg-good1", "bg-good2"])
  })
})

/* ====================================================================== */
/* C. delete + prune                                                       */
/* ====================================================================== */

describe("C. delete + prune", () => {
  test("HG-10: delete known id — file gone; subsequent load returns null", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const h = mkHandle("bg-del1")
    await store.save(h)
    expect(await store.load(h.id)).not.toBeNull()
    await store.delete(h.id)
    expect(await store.load(h.id)).toBeNull()
  })

  test("HG-11: delete unknown id — no error (idempotent)", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    // Just confirm no throw.
    await store.delete("bg-never-existed")
    await store.delete("bg-never-existed") // second call also fine
    expect(true).toBe(true)
  })

  test("HG-12: prune drops terminal-state old handles, keeps fresh ones", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const dayMs = 24 * 60 * 60 * 1000
    const tNow = Date.now()
    await store.save(
      mkHandle("bg-old1", {
        status: "completed",
        endedAt: tNow - 10 * dayMs,
        workspace: "/ws/P",
      }),
    )
    await store.save(
      mkHandle("bg-fresh1", {
        status: "completed",
        endedAt: tNow - 1000,
        workspace: "/ws/P",
      }),
    )
    const removed = await store.prune("/ws/P", 5 * dayMs)
    expect(removed).toBe(1)
    const remaining = await store.list("/ws/P")
    expect(remaining.map((h) => h.id)).toEqual(["bg-fresh1"])
  })

  test("HG-13: prune never deletes running handles regardless of age", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    // Build directly without mkHandle's default `endedAt` so the saved record
    // has the key OMITTED — running handles must never carry an endedAt
    // (exactOptionalPropertyTypes).
    const persisted: PersistedHandle = {
      id: "bg-runningold",
      spec: { task: "x" },
      status: "running",
      startedAt: 0, // very old
      turns: 0,
      outputSummary: "(running)",
      workspace: "/ws/R",
    }
    await store.save(persisted)
    const removed = await store.prune("/ws/R", 1)
    expect(removed).toBe(0)
    const remaining = await store.list("/ws/R")
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.status).toBe("running")
  })
})

/* ====================================================================== */
/* D. Crash safety                                                         */
/* ====================================================================== */

describe("D. Crash safety", () => {
  test("HG-14: save writes a single complete line terminated with \\n (atomic append)", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const h = mkHandle("bg-atomic")
    await store.save(h)
    // Locate the file under the workspace dir.
    const wsHashes = await readdir(baseDir)
    const wsDir = join(baseDir, wsHashes[0] ?? "")
    const file = join(wsDir, "bg-atomic.jsonl")
    const body = await readFile(file, "utf8")
    expect(body.endsWith("\n")).toBe(true)
    // Exactly ONE line: the single save call produced a single record.
    const lines = body.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    // The line parses back to the saved handle.
    expect(lines[0]).toBeDefined()
    const parsed = JSON.parse(lines[0] ?? "{}") as PersistedHandle
    expect(parsed.id).toBe(h.id)
  })

  test("HG-15: ENOENT on load returns null — no throw", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })
    const got = await store.load("bg-nothing")
    expect(got).toBeNull()
  })

  test("HG-16: disk write failure surfaces as PersistenceError('io-failed')", async () => {
    const baseDir = await newTmp()
    // Pre-create the per-workspace dir and chmod it 0444 so mkdir-of-the-same
    // path succeeds (recursive: true is idempotent) but the appendFile fails
    // with EACCES.
    const store = defaultJsonlSchedulerStore({ baseDir })
    const h = mkHandle("bg-failed1", { workspace: "/ws/F" })
    // Compute the directory the store would write into by saving once first
    // to materialize it, then chmod, then save again with a fresh id.
    await store.save(h)
    const wsHashes = await readdir(baseDir)
    expect(wsHashes.length).toBe(1)
    const wsDir = join(baseDir, wsHashes[0] ?? "")
    try {
      await chmod(wsDir, 0o000)
      const h2 = mkHandle("bg-failed2", { workspace: "/ws/F" })
      let caught: unknown = null
      try {
        await store.save(h2)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(PersistenceError)
      const pe = caught as PersistenceError
      expect(pe.code).toBe("io-failed")
    } finally {
      // Restore so the temp cleanup can succeed.
      await chmod(wsDir, 0o755).catch(() => undefined)
    }
  })
})

/* ====================================================================== */
/* E. "resumed" status disk roundtrip (ADR-0159 Phase 2 guard)            */
/* ====================================================================== */

describe("E. 'resumed' status disk roundtrip", () => {
  test("HG-17: save handle with status 'resumed' — load parses correctly, no PersistenceError", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })

    // Write a handle that the resumer would produce via markResumed().
    const h: PersistedHandle = {
      id: "bg-resumed-e2e1",
      spec: { task: "original task", metadata: { idempotent: "true" } },
      status: "resumed",
      startedAt: 1_000,
      endedAt: 2_000,
      turns: 3,
      outputSummary: "resumed as bg-newhandle",
      workspace: "/ws/resume-roundtrip",
    }
    // Must NOT throw (isPersistedStatus must include "resumed").
    await store.save(h)

    const got = await store.load(h.id)
    expect(got).not.toBeNull()
    if (got === null) throw new Error("unreachable")

    expect(got.id).toBe("bg-resumed-e2e1")
    expect(got.status).toBe("resumed")
    expect(got.outputSummary).toBe("resumed as bg-newhandle")
    expect(got.endedAt).toBe(2_000)
    expect(got.turns).toBe(3)
    // Optional fields preserved.
    expect(got.workspace).toBe("/ws/resume-roundtrip")
    expect(got.spec.metadata).toEqual({ idempotent: "true" })
  })

  test("HG-18: 'resumed' handle surfaces in list() with correct status", async () => {
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })

    // Save the original interrupted handle first.
    const interrupted: PersistedHandle = {
      id: "bg-resumed-list1",
      spec: { task: "task for list test" },
      status: "interrupted",
      startedAt: 500,
      endedAt: 1_000,
      turns: 1,
      outputSummary: "(interrupted)",
      workspace: "/ws/resume-list",
    }
    await store.save(interrupted)

    // Now overwrite with "resumed" (JSONL append — latest line wins).
    const resumed: PersistedHandle = {
      ...interrupted,
      status: "resumed",
      outputSummary: "resumed as bg-newid-123",
      endedAt: 1_500,
    }
    await store.save(resumed)

    const listed = await store.list("/ws/resume-list")
    expect(listed.length).toBe(1)
    expect(listed[0]?.status).toBe("resumed")
    expect(listed[0]?.outputSummary).toBe("resumed as bg-newid-123")
  })

  test("HG-19: 'queued' handle roundtrips through save+list without silent loss", async () => {
    // RED guard: if isPersistedStatus omits "queued", parseHandle returns
    // undefined for any queued snapshot → store.list silently drops it →
    // handles enqueued while the process runs vanish on next hydration.
    // This test fires RED against the unfixed validator and GREEN once
    // s === "queued" is added to isPersistedStatus.
    const baseDir = await newTmp()
    const store = defaultJsonlSchedulerStore({ baseDir })

    const queued: PersistedHandle = {
      id: "bg-queued-hg19",
      spec: { task: "admission-queued task" },
      status: "queued",
      startedAt: Date.now() - 1_000,
      turns: 0,
      outputSummary: "(queued — not yet started)",
      workspace: "/ws/queued-hg19",
    }
    await store.save(queued)

    const listed = await store.list("/ws/queued-hg19")
    expect(listed.length).toBe(1)
    expect(listed[0]?.status).toBe("queued")
    expect(listed[0]?.id).toBe("bg-queued-hg19")
  })
})
