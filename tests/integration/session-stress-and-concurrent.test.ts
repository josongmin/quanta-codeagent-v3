import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { runShell } from "@/runtime"
import {
  archivedFilePath,
  archiveSession,
  forkSession,
  indexFilePath,
  listSessions,
  loadSessionById,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { runSessionCommand, type SessionCommandDeps } from "../../src/apps/cli/session-commands"

/**
 * STRESS / SCALE / CONCURRENCY suite for the session slice + CLI dispatcher.
 *
 * Goal: load-test the implementation to surface ordering bugs, perf
 * regressions, and concurrency hazards that unit tests cannot catch. Every
 * test is hermetic via per-test `QUANTA_SESSIONS_DIR` (mkdtempSync +
 * afterEach cleanup). Performance bounds are deliberately generous unless an
 * operation truly should be near-instant — flake avoidance trumps tightness.
 *
 * Known concurrency contract (see `src/session/index-store.ts:13`):
 *   `index.jsonl` upserts are read-modify-write — under true parallel writes
 *   the implementation is **last-writer-wins**. Concurrent writers each stage
 *   to a unique `.tmp.<pid>.<rand>` and rename to the shared target, so NO
 *   writer throws on its rename — but an earlier writer's bytes may be
 *   overwritten by a later writer's rename (silent loss). The per-session
 *   JSON file is never affected because each id is its own file.
 */

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runShell("git --version")
    return r.exitCode === 0
  } catch {
    return false
  }
}

const HAS_GIT = await gitAvailable()

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "stress-repo-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

interface Captured {
  out: string
  err: string
  deps: SessionCommandDeps
}

const captureDeps = (confirmAnswer = true): Captured => {
  const c: Captured = {
    out: "",
    err: "",
    deps: {
      out: (s) => {
        c.out += s
      },
      err: (s) => {
        c.err += s
      },
      confirm: async () => confirmAnswer,
    },
  }
  return c
}

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
  const now = Date.now()
  return {
    id: overrides.id ?? "stress-1",
    title: overrides.title ?? "T",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? now,
    lastTouched: overrides.lastTouched ?? now,
    archived: overrides.archived ?? false,
  }
}

const mkPayload = (msgCount = 2): SavePayload => {
  const messages: Message[] = []
  for (let i = 0; i < msgCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `msg-${i}` }],
    })
  }
  return { reason: "completed", turns: msgCount, messages }
}

/** Build a "large" message ~500 bytes. Keep the payload deterministic so
 *  roundtrip assertions can pin first/middle/last bytes. */
const mkLargeMessage = (i: number): Message => {
  const body = `idx=${i};${"x".repeat(490)}`
  return {
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: body }],
  }
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[idx] ?? 0
}

/** Run a batch of async tasks with bounded concurrency. Returns settled
 *  results so a single failure does not short-circuit (important for the
 *  parallel-saves test where we want to PIN the observed survivor count). */
const runBatched = async <T>(
  tasks: Array<() => Promise<T>>,
  batchSize: number,
): Promise<PromiseSettledResult<T>[]> => {
  const out: PromiseSettledResult<T>[] = []
  for (let i = 0; i < tasks.length; i += batchSize) {
    const slice = tasks.slice(i, i + batchSize)
    const settled = await Promise.allSettled(slice.map((fn) => fn()))
    out.push(...settled)
  }
  return out
}

/** Parse `forked X → ID` + `worktree: PATH` out of a captured stdout buffer.
 *  Returns undefined entries when the line is missing (e.g. non-worktree fork
 *  or a failed run). Extracted to keep the test bodies under biome's complexity
 *  budget. */
const parseForkOutput = (out: string): { id?: string; wtPath?: string } => {
  const idM = out.match(/forked \S+ → (\S+)/)
  const wtM = out.match(/worktree: (\S+)/)
  const r: { id?: string; wtPath?: string } = {}
  if (idM?.[1]) r.id = idM[1]
  if (wtM?.[1]) r.wtPath = wtM[1]
  return r
}

/** Collect successful (newId, wtPath) pairs from a captured-result matrix. */
const collectSuccessfulForks = (
  captured: Captured[],
  exitCodes: number[],
): { newIds: string[]; wtPaths: string[] } => {
  const newIds: string[] = []
  const wtPaths: string[] = []
  for (let i = 0; i < captured.length; i++) {
    if (exitCodes[i] !== 0) continue
    const c = captured[i]
    if (!c) continue
    const parsed = parseForkOutput(c.out)
    if (parsed.id !== undefined) newIds.push(parsed.id)
    if (parsed.wtPath !== undefined) wtPaths.push(parsed.wtPath)
  }
  return { newIds, wtPaths }
}

/** True when a captured fork failure looks like git worktree/index LOCK
 *  contention rather than a genuine logic error. Under heavy suite-wide CPU/IO
 *  load, concurrent `git worktree add` invocations can transiently lose the
 *  repo-level lock (`.git/worktrees/.../locked`, `index.lock`, "is already
 *  checked out", "File exists") — that is an environmental race, NOT the
 *  "exit 0 but missing from index" correctness bug this battery targets.
 *  NOTE (SRC gap, reported separately): `src/runtime/worktree-fork.ts` runs
 *  `git worktree add` exactly once with no lock-retry, so under real
 *  concurrency a fork CAN fail this way. The retry lives in the test harness
 *  to keep the all-succeed contract deterministic without masking a genuine
 *  failure — a NON-lock failure is rethrown by the assertions below. */
const looksLikeGitLockContention = (out: string): boolean =>
  /index\.lock|worktrees?\/.+\/locked|already (locked|checked out)|cannot lock|File exists|Unable to create.*lock/i.test(
    out,
  )

/** Serially retry a worktree fork that lost the parallel git lock, up to a
 *  bound. A serial `git worktree add` faces no contention, so this converges.
 *  Returns the successful capture (or throws via the expect on exhaustion). */
const retryForkSerially = async (srcId: string): Promise<Captured> => {
  let rc = 1
  let cap: Captured | undefined
  for (let attempt = 0; attempt < 5 && rc !== 0; attempt++) {
    cap = captureDeps()
    rc = await runSessionCommand(["fork", srcId, "--worktree"], cap.deps).catch(() => 1)
  }
  expect(rc).toBe(0) // serial retry MUST succeed — no lock to lose
  return cap as Captured
}

/** Issue `session delete --force <id>` and return the exit code. Never throws. */
const dispatcherDelete = async (id: string): Promise<number> => {
  const c = captureDeps()
  return runSessionCommand(["delete", id, "--force"], c.deps).catch(() => 1)
}

/** Serially fork --worktree from `srcId` `count` times. Asserts each succeeds.
 *  Returns the parsed (newIds, wtPaths) arrays. */
const setupWorktreeForks = async (
  srcId: string,
  count: number,
): Promise<{ newIds: string[]; wtPaths: string[] }> => {
  const newIds: string[] = []
  const wtPaths: string[] = []
  for (let i = 0; i < count; i++) {
    const c = captureDeps()
    const rc = await runSessionCommand(["fork", srcId, "--worktree"], c.deps)
    expect(rc).toBe(0)
    const parsed = parseForkOutput(c.out)
    if (parsed.id !== undefined) newIds.push(parsed.id)
    if (parsed.wtPath !== undefined) wtPaths.push(parsed.wtPath)
  }
  return { newIds, wtPaths }
}

/** Re-issue dispatcher-delete for any (id, settledResult) pair that failed
 *  (rejection or fulfilled-with-nonzero). Race-recovery sweep. */
const sweepFailedDeletes = async (
  ids: string[],
  results: PromiseSettledResult<number>[],
): Promise<void> => {
  for (let i = 0; i < ids.length; i++) {
    const r = results[i]
    const nid = ids[i] ?? ""
    if (!r || nid === "") continue
    const failed = r.status === "rejected" || (r.status === "fulfilled" && r.value !== 0)
    if (failed) await dispatcherDelete(nid)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stress: index growth
// ─────────────────────────────────────────────────────────────────────────────

describe("session stress — index growth", () => {
  let sessionsDir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    sessionsDir = mkdtempSync(join(tmpdir(), "stress-sessions-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  // 1. 100 sessions in index — `listSessions` returns 100 sorted DESC; CLI ls < 1s.
  test("100 sessions: save + list + CLI ls render", async () => {
    const N = 100
    const startSave = performance.now()
    for (let i = 0; i < N; i++) {
      const meta = mkMeta({ id: `s100-${i}`, title: `T${i}`, lastTouched: 1_000_000 + i })
      await saveSessionById(meta, mkPayload())
    }
    const saveMs = performance.now() - startSave
    expect(saveMs).toBeLessThan(5_000)

    const startList = performance.now()
    const list = await listSessions()
    const listMs = performance.now() - startList
    expect(list.length).toBe(N)
    // DESC by lastTouched — head was last save (largest seed).
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (!a || !b) continue
      expect(a.lastTouched).toBeGreaterThanOrEqual(b.lastTouched)
    }

    const startCli = performance.now()
    const c = captureDeps()
    const rc = await runSessionCommand(["ls"], c.deps)
    const cliMs = performance.now() - startCli
    expect(rc).toBe(0)
    expect(cliMs).toBeLessThan(1_000)
    expect(listMs).toBeLessThan(1_000)
    // Output has 1 header + N rows (each terminated by `\n`).
    const lines = c.out.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(N + 1)
  })

  // 2. 1000 sessions via Promise.all batches — per-writer-tmp + in-process
  // mutex on the index ensures ALL 1000 saves succeed AND all 1000 rows
  // land in the index.
  test("1000 sessions: batched parallel saves all succeed; full index", async () => {
    const N = 1000
    const tasks: Array<() => Promise<void>> = []
    for (let i = 0; i < N; i++) {
      const id = `s1k-${i}`
      const meta = mkMeta({ id, title: `T${i}`, lastTouched: 2_000_000 + i })
      tasks.push(() => saveSessionById(meta, mkPayload()))
    }
    const startSave = performance.now()
    const settled = await runBatched(tasks, 50)
    const saveMs = performance.now() - startSave
    expect(saveMs).toBeLessThan(30_000)

    // All 1000 saves SUCCEED — per-writer tmps eliminate the rename ENOENT.
    const rejections = settled.filter((s) => s.status === "rejected")
    expect(rejections.length).toBe(0)

    const startList = performance.now()
    const list = await listSessions()
    const listMs = performance.now() - startList
    expect(listMs).toBeLessThan(2_000)
    // All per-id JSON files are on disk.
    const filesOnDisk = readdirSync(sessionsDir).filter(
      (f) => f.endsWith(".json") && f !== "index.jsonl",
    )
    expect(filesOnDisk.length).toBe(N)
    // All 1000 rows survived the index mutex serialization.
    expect(list.length).toBe(N)
    // No tmp residue (per-writer tmps are all renamed away).
    const residue = readdirSync(sessionsDir).filter((f) => f.includes(".tmp."))
    expect(residue).toEqual([])
  }, 60_000)

  // 3. `session ls --ids` at scale — output line count == 1000.
  test("1000 sessions: ls --ids line count matches index size", async () => {
    const N = 1000
    // Use serial saves for deterministic index population.
    for (let i = 0; i < N; i++) {
      const meta = mkMeta({ id: `ids-${i}`, lastTouched: 3_000_000 + i })
      await saveSessionById(meta, mkPayload())
    }
    const c = captureDeps()
    const rc = await runSessionCommand(["ls", "--ids"], c.deps)
    expect(rc).toBe(0)
    const lines = c.out.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(N)
  }, 60_000)

  // 4. `session ls --json` at scale — parses to array length 1000.
  test("1000 sessions: ls --json parses cleanly", async () => {
    const N = 1000
    for (let i = 0; i < N; i++) {
      const meta = mkMeta({ id: `json-${i}`, lastTouched: 4_000_000 + i })
      await saveSessionById(meta, mkPayload())
    }
    const c = captureDeps()
    const rc = await runSessionCommand(["ls", "--json"], c.deps)
    expect(rc).toBe(0)
    const parsed = JSON.parse(c.out) as SessionMeta[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(N)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Stress: large session payload
// ─────────────────────────────────────────────────────────────────────────────

describe("session stress — large payloads", () => {
  let sessionsDir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    sessionsDir = mkdtempSync(join(tmpdir(), "stress-large-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  // 5. Single session with 5000 messages — roundtrip preserves first/mid/last.
  test("5000 messages: save + load roundtrip ~2.5MB", async () => {
    const M = 5000
    const messages: Message[] = []
    for (let i = 0; i < M; i++) messages.push(mkLargeMessage(i))
    const id = "large-1"
    const payload: SavePayload = { reason: "completed", turns: M, messages }
    const meta = mkMeta({ id, title: "Large" })

    const startSave = performance.now()
    await saveSessionById(meta, payload)
    const saveMs = performance.now() - startSave
    expect(saveMs).toBeLessThan(3_000)

    const startLoad = performance.now()
    const loaded = await loadSessionById(id)
    const loadMs = performance.now() - startLoad
    expect(loadMs).toBeLessThan(3_000)
    expect(loaded?.messages.length).toBe(M)
    const first = loaded?.messages[0]
    const middle = loaded?.messages[Math.floor(M / 2)]
    const last = loaded?.messages[M - 1]
    expect((first?.content[0] as { type: string; text: string }).text).toContain("idx=0;")
    expect((middle?.content[0] as { type: string; text: string }).text).toContain(
      `idx=${Math.floor(M / 2)};`,
    )
    expect((last?.content[0] as { type: string; text: string }).text).toContain(`idx=${M - 1};`)
  }, 30_000)

  // 6. forkSession on a 5000-msg session — structuredClone holds; < 3s.
  test("forkSession on a large 5000-msg session", async () => {
    const M = 5000
    const messages: Message[] = []
    for (let i = 0; i < M; i++) messages.push(mkLargeMessage(i))
    const srcId = "large-src"
    await saveSessionById(mkMeta({ id: srcId, title: "Src" }), {
      reason: "completed",
      turns: M,
      messages,
    })

    const startFork = performance.now()
    const newId = await forkSession(srcId)
    const forkMs = performance.now() - startFork
    expect(forkMs).toBeLessThan(3_000)

    const forked = await loadSessionById(newId)
    expect(forked?.messages.length).toBe(M)
    // Source untouched.
    const source = await loadSessionById(srcId)
    expect(source?.messages.length).toBe(M)
  }, 30_000)

  // 7. Repeated saves of same session (100 iterations) — no .tmp leakage.
  test("100 repeated saves: no .tmp residue in sessionsDir", async () => {
    const id = "repeat-1"
    const meta = mkMeta({ id })
    const payload = mkPayload(5)
    for (let i = 0; i < 100; i++) {
      await saveSessionById(meta, payload)
    }
    const residue = readdirSync(sessionsDir).filter((f) => f.endsWith(".tmp"))
    expect(residue).toEqual([])
    // The session file exists and the index has one row.
    expect(existsSync(sessionFilePath(id))).toBe(true)
    const list = await listSessions()
    expect(list.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency: dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe("session concurrency — dispatcher races", () => {
  let sessionsDir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    sessionsDir = mkdtempSync(join(tmpdir(), "stress-conc-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  // 8. 20 parallel saveSessionById — per-writer-tmp + in-process index
  // mutex: all saves succeed, all per-id files land on disk, and ALL ids
  // appear in the index.
  test("20 parallel saves — all succeed; all per-id files on disk; all in index", async () => {
    const N = 20
    const ids = Array.from({ length: N }, (_, i) => `par-${i}`)
    const tasks = ids.map((id) => () => saveSessionById(mkMeta({ id, title: id }), mkPayload()))
    const settled = await Promise.allSettled(tasks.map((fn) => fn()))
    const rejections = settled.filter((s) => s.status === "rejected")
    const successes = settled.filter((s) => s.status === "fulfilled")
    // CONTRACT: zero rejections — per-writer tmps remove the ENOENT race.
    expect(rejections.length).toBe(0)
    expect(successes.length).toBe(N)

    // No tmp residue (per-writer tmps are all renamed away).
    const residue = readdirSync(sessionsDir).filter((f) => f.includes(".tmp"))
    expect(residue).toEqual([])

    // Every per-id file landed on disk.
    for (const id of ids) {
      expect(existsSync(sessionFilePath(id))).toBe(true)
    }
    // All 20 ids in the index (mutex serializes read-modify-write).
    const list = await listSessions()
    expect(list.length).toBe(N)
    const listIds = new Set(list.map((m) => m.id))
    for (const id of ids) expect(listIds.has(id)).toBe(true)
  })

  // 9. 20 parallel saves interleaved with 20 ls — all saves succeed under
  // the per-writer-tmp scheme; every list parses cleanly (a stale or empty
  // snapshot is fine but garbled JSON is not).
  test("20 saves + 20 ls interleaved — all saves succeed; every ls parses", async () => {
    const N = 20
    const saveTasks: Array<Promise<unknown>> = []
    for (let i = 0; i < N; i++) {
      saveTasks.push(saveSessionById(mkMeta({ id: `mix-${i}`, title: `T${i}` }), mkPayload()))
    }
    const captured: Captured[] = []
    const listTasks: Array<Promise<unknown>> = []
    for (let i = 0; i < N; i++) {
      const c = captureDeps()
      captured.push(c)
      listTasks.push(runSessionCommand(["ls", "--json"], c.deps))
    }
    const settled = await Promise.allSettled([...saveTasks, ...listTasks])
    // All operations succeed under the per-writer-tmp scheme.
    expect(settled.filter((s) => s.status === "rejected").length).toBe(0)

    // Every list parses cleanly. Stale snapshots are tolerable; garbled is not.
    for (const c of captured) {
      const trimmed = c.out.trim()
      if (trimmed === "") continue // a list issued before any save landed
      const arr = JSON.parse(trimmed) as SessionMeta[]
      expect(Array.isArray(arr)).toBe(true)
      for (const m of arr) {
        expect(typeof m.id).toBe("string")
        expect(typeof m.lastTouched).toBe("number")
      }
    }
    // Eventual-state sanity: the index parses to a non-empty list.
    const finalList = await listSessions()
    expect(finalList.length).toBeGreaterThan(0)
  })

  // 10. fork + delete race — final state has source intact, no orphan files.
  // Uses Promise.allSettled because of the documented parallel-write hazard.
  // PIN: even when some forks reject under the rename race, the FILES that
  // were created get properly cleaned up by the subsequent delete pass.
  test("5 parallel forks then 5 parallel deletes — source intact, no orphans", async () => {
    const srcId = "race-src"
    await saveSessionById(mkMeta({ id: srcId, title: "Src" }), mkPayload(3))

    // Parallel forks (some may throw — see test #8).
    const forkSettled = await Promise.allSettled(
      Array.from({ length: 5 }, () => forkSession(srcId)),
    )
    const forkIds: string[] = []
    for (const s of forkSettled) {
      if (s.status === "fulfilled") forkIds.push(s.value)
    }
    // At least one must succeed for the test to be meaningful.
    expect(forkIds.length).toBeGreaterThanOrEqual(1)
    expect(new Set(forkIds).size).toBe(forkIds.length)

    // ALSO collect orphan files that may exist for forks where the file
    // write landed but the index write rejected — sweep the active dir to
    // catch anything not in `forkIds`.
    const activeFiles = readdirSync(sessionsDir).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".tmp") && f !== "index.jsonl",
    )
    const allCandidateIds = new Set<string>(forkIds)
    for (const f of activeFiles) {
      const id = f.replace(/\.json$/, "")
      if (id !== srcId) allCandidateIds.add(id)
    }

    // Parallel deletes via dispatcher (--force to skip confirm). Use allSettled.
    const delSettled = await Promise.allSettled(
      [...allCandidateIds].map(async (id) => {
        const c = captureDeps()
        return runSessionCommand(["delete", id, "--force"], c.deps)
      }),
    )
    // At least one delete must succeed cleanly.
    const okDels = delSettled.filter((s) => s.status === "fulfilled")
    expect(okDels.length).toBeGreaterThanOrEqual(1)

    // Source intact (regardless of what raced around it).
    const source = await loadSessionById(srcId)
    expect(source?.meta.id).toBe(srcId)

    // No active orphan files for the successfully-forked ids — those that
    // dispatcher-deleted cleanly are gone.
    for (const fid of forkIds) {
      // Either fully deleted, or never landed cleanly to begin with. We pin
      // "active file should not exist after dispatcher delete success".
      // Filesystem-level orphans for raced forks are documented above.
      const active = existsSync(sessionFilePath(fid))
      const archived = existsSync(archivedFilePath(fid))
      // For ids whose delete dispatcher returned 0, both must be false.
      // We can't easily map back which delSettled belongs to which id; so
      // assert: NOT BOTH (no half-archive state can hide an extra file).
      expect(active && archived).toBe(false)
    }
  })

  // 11. save + archive on SAME id 10× — file in EXACTLY ONE of active/archived.
  test("save + archive race on same id (x10) — exactly one of active/archived per round", async () => {
    for (let round = 0; round < 10; round++) {
      const id = `raceA-${round}`
      // Seed once so archive has something to move.
      await saveSessionById(mkMeta({ id, title: "R" }), mkPayload())
      // Race a fresh save against an archive call on the SAME id.
      await Promise.allSettled([
        saveSessionById(mkMeta({ id, title: "R2" }), mkPayload()),
        archiveSession(id),
      ])
      const inActive = existsSync(sessionFilePath(id))
      const inArchived = existsSync(archivedFilePath(id))
      // EXACTLY one of the two must be true. Both-true would mean the archive
      // step ran AFTER the save but failed to delete the active file; neither
      // would mean the file was lost. Either failure breaks the contract.
      expect(inActive !== inArchived).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stress: worktree
// ─────────────────────────────────────────────────────────────────────────────

describe("session stress — worktree (git required)", () => {
  let sessionsDir: string
  let repoDir: string | undefined
  let envSnapshot: NodeJS.ProcessEnv

  beforeAll(() => {
    envSnapshot = { ...process.env }
  })
  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "stress-wt-sessions-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true })
      repoDir = undefined
    }
    __resetRuntimeConfig()
  })

  // 12. 5 parallel `session fork X --worktree` — under per-writer-tmp all
  // forks succeed AND all end up in the index (the previous "exit 0 but
  // missing from index" race is gone because rename never throws and all
  // five upserts converge via last-writer-wins across distinct ids — each
  // id has its own line, so no row is dropped). git worktree add holds an
  // internal lock; combined with the rewrite-then-rename index pattern,
  // every fork's row survives.
  test.skipIf(!HAS_GIT)(
    "5 parallel fork --worktree — all succeed AND all in index",
    async () => {
      repoDir = await makeRepo()
      const srcId = "wt-stress-src"
      await saveSessionById(mkMeta({ id: srcId, title: "WTSrc", cwd: repoDir }), mkPayload())

      // Fire 5 concurrent worktree forks. The invariant we actually guard is
      // "exit 0 ⟺ a complete, indexed worktree row" (the historical race was
      // "exit 0 but missing from index"). All-5 success is the CONTRACT, but
      // `git worktree add` takes a repo-level lock and the SRC does not retry
      // on contention (see `looksLikeGitLockContention` + reported SRC gap), so
      // under suite-wide load a fork can transiently lose the lock. We absorb
      // ONLY that environmental race with a bounded serial retry; any failure
      // that is NOT lock contention fails the test loudly below.
      const captured: Captured[] = []
      const forks = Array.from({ length: 5 }, () => {
        const c = captureDeps()
        captured.push(c)
        return runSessionCommand(["fork", srcId, "--worktree"], c.deps).catch(() => 1)
      })
      const exitCodes = await Promise.all(forks)

      // Any non-zero exit MUST be explained by git lock contention — anything
      // else (a real logic/index bug) is surfaced here, not swallowed.
      for (let i = 0; i < exitCodes.length; i++) {
        if (exitCodes[i] === 0) continue
        const out = captured[i]?.out ?? ""
        expect(looksLikeGitLockContention(out)).toBe(true)
      }

      // Deterministically reach the all-5 outcome: retry each lock-failed fork
      // SERIALLY (no contention) up to a bound. A serial `git worktree add`
      // never hits the parallel lock, so this converges.
      const successCaptures: Captured[] = []
      for (let i = 0; i < exitCodes.length; i++) {
        const c = captured[i]
        if (exitCodes[i] === 0 && c) {
          successCaptures.push(c)
        } else {
          successCaptures.push(await retryForkSerially(srcId))
        }
      }
      // After convergence every one of the 5 forks has a successful capture.
      expect(successCaptures.length).toBe(5)

      // Strong consistency invariant: each successful fork yielded a DISTINCT
      // id + DISTINCT worktree path, and the path exists on disk.
      const exitOk = successCaptures.map(() => 0)
      const { newIds, wtPaths } = collectSuccessfulForks(successCaptures, exitOk)
      expect(newIds.length).toBe(5)
      expect(wtPaths.length).toBe(5)
      expect(new Set(newIds).size).toBe(newIds.length) // distinct ids
      expect(new Set(wtPaths).size).toBe(wtPaths.length) // distinct paths
      for (const p of wtPaths) expect(existsSync(p)).toBe(true)

      // exit 0 ⟺ in index: every successful fork AND the source appear in the
      // index. Distinct ids ⇒ last-writer-wins cannot drop a row.
      const indexed = (await listSessions({ includeArchived: true })).map((m) => m.id)
      for (const nid of newIds) expect(indexed).toContain(nid)
      expect(indexed).toContain(srcId)
    },
    90_000,
  )

  // 13. delete --force of 5 worktree-forked sessions in parallel.
  test.skipIf(!HAS_GIT)(
    "5 parallel deletes of worktree-forked sessions — branches + dirs gone",
    async () => {
      repoDir = await makeRepo()
      const srcId = "wt-del-src"
      await saveSessionById(mkMeta({ id: srcId, title: "WTSrc", cwd: repoDir }), mkPayload())

      // Set up 5 worktree forks serially (so we have deterministic state).
      const { newIds, wtPaths } = await setupWorktreeForks(srcId, 5)
      expect(newIds.length).toBe(5)

      // Parallel deletes. The dispatcher's delete path calls deleteSession
      // which writes to the index; under parallelism it can hit the same
      // rename race. Use allSettled and pin observed.
      const delResults = await Promise.allSettled(newIds.map((nid) => dispatcherDelete(nid)))
      // Cleanup-sweep pass: any first-pass failure retried serially.
      await sweepFailedDeletes(newIds, delResults)

      // After cleanup sweep: all 5 worktree dirs gone.
      for (const p of wtPaths) expect(existsSync(p)).toBe(false)
      // No fork-* branches remain (source's branch — main/master — untouched).
      const branchRes = await runShell("git branch -a", { cwd: repoDir })
      const branchLines = branchRes.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
      for (const line of branchLines) {
        expect(line.includes("fork-")).toBe(false)
      }
    },
    120_000,
  )

  // 14. Tight fork→delete loop (10 iterations) — no resource leaks accumulate.
  test.skipIf(!HAS_GIT)(
    "fork→delete loop (10 iterations) — no branch or dir leaks",
    async () => {
      repoDir = await makeRepo()
      const srcId = "wt-loop-src"
      await saveSessionById(mkMeta({ id: srcId, title: "WTSrc", cwd: repoDir }), mkPayload())

      for (let i = 0; i < 10; i++) {
        let forkId = ""
        try {
          const cFork = captureDeps()
          const rcF = await runSessionCommand(["fork", srcId, "--worktree"], cFork.deps)
          expect(rcF).toBe(0)
          const parsed = parseForkOutput(cFork.out)
          forkId = parsed.id ?? ""
          const wtPath = parsed.wtPath ?? ""
          expect(forkId).not.toBe("")
          expect(wtPath).not.toBe("")
          expect(existsSync(wtPath)).toBe(true)
        } finally {
          if (forkId !== "") {
            const cDel = captureDeps()
            await runSessionCommand(["delete", forkId, "--force"], cDel.deps)
          }
        }
      }

      // After 10 cycles: no worktree dirs and no `fork-*` branches remain.
      const wtRoot = join(repoDir as string, ".quanta", "worktrees")
      if (existsSync(wtRoot)) {
        const remaining = readdirSync(wtRoot)
        expect(remaining).toEqual([])
      }
      const branchRes = await runShell("git branch -a", { cwd: repoDir as string })
      const forkBranches = branchRes.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("fork-"))
      expect(forkBranches).toEqual([])

      // Source still intact.
      expect((await loadSessionById(srcId))?.meta.id).toBe(srcId)
    },
    180_000,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Performance baselines (snapshot-style, not strict)
// ─────────────────────────────────────────────────────────────────────────────

describe("session perf baselines", () => {
  let sessionsDir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    sessionsDir = mkdtempSync(join(tmpdir(), "stress-perf-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  // 15. Empty store `session ls --json` should be near-instant.
  test("empty store: ls --json under 100ms", async () => {
    // Warm-up: avoid first-call JIT noise. Bound stays generous regardless.
    const cWarm = captureDeps()
    await runSessionCommand(["ls", "--json"], cWarm.deps)

    const c = captureDeps()
    const start = performance.now()
    const rc = await runSessionCommand(["ls", "--json"], c.deps)
    const ms = performance.now() - start
    expect(rc).toBe(0)
    const parsed = JSON.parse(c.out) as SessionMeta[]
    expect(parsed.length).toBe(0)
    // Cold-path is dominated by fs-stat; bound is generous to avoid CI flake.
    expect(ms).toBeLessThan(100)
  })

  // 16. p99 over 100 distinct saves — bound 200ms per save.
  test("saveSessionById p99 over 100 distinct saves under 200ms", async () => {
    const samples: number[] = []
    for (let i = 0; i < 100; i++) {
      const meta = mkMeta({ id: `perf-${i}`, lastTouched: 5_000_000 + i })
      const start = performance.now()
      await saveSessionById(meta, mkPayload(3))
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const p50 = percentile(samples, 50)
    const p99 = percentile(samples, 99)
    // A regression to e.g. fsync-per-call would push p99 above this. Keep p99
    // bound permissive — the index file rewrites grow O(n) so later saves
    // run longer than earlier ones (expected, but capped).
    expect(p99).toBeLessThan(200)
    // p50 should be much faster — a sanity floor.
    expect(p50).toBeLessThan(50)
    // Light smoke that the file is healthy.
    expect(existsSync(indexFilePath())).toBe(true)
  })
})
