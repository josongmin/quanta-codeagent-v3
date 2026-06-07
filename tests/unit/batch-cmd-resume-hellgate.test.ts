/**
 * Hellgate — `quanta batch` durable store + resume (GAP7-3/7-5 LIVE wiring).
 *
 * Proves the human-CLI surface for the sqlite store + resume: `--db` persists a
 * job (survives the process), `--resume <jobId>` re-drives an interrupted job
 * from that db to completion, and the resume arg contract is enforced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BatchJob, BatchJobItem } from "@/agent/batch-jobs"
import { parseBatchArgs, runBatchCmd } from "@/apps/cli/batch-cmd"
import { SqliteJobStore } from "@/host/runtime/batch-jobs-sqlite-store"
import type { SubagentRunner } from "@/subagent"

const echo: SubagentRunner = () => Promise.resolve({ ok: true, finalText: "done" } as never)
const CSV = "name\nAlice\nBob"

const makeIo = (files: Record<string, string>) => {
  const written: Record<string, string> = {}
  return {
    written,
    io: {
      readFile: (p: string) => {
        const f = files[p]
        if (f === undefined) throw new Error(`ENOENT ${p}`)
        return f
      },
      writeFile: (p: string, d: string) => {
        written[p] = d
      },
      out: () => {},
      err: () => {},
    },
  }
}

describe("quanta batch — --resume arg contract", () => {
  test("--resume without --db ⇒ usage error", () => {
    const r = parseBatchArgs(["--resume", "j1", "--out", "out.csv"])
    expect(r.ok).toBe(false)
  })
  test("--resume with --db + --out (no --in/--instruction) ⇒ accepted", () => {
    const r = parseBatchArgs(["--resume", "j1", "--db", "x.db", "--out", "out.csv"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resume).toBe("j1")
  })
})

describe("quanta batch — durable --db + restart resume", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "quanta-batchcli-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("--db persists the completed job (survives the process)", async () => {
    const dbPath = path.join(dir, "run.db")
    const { io } = makeIo({ "in.csv": CSV })
    const code = await runBatchCmd(
      ["--in", "in.csv", "--instruction", "greet", "--out", "out.csv", "--db", dbPath],
      { runner: echo, io, now: () => 1, newId: counterId() },
    )
    expect(code).toBe(0)
    // Reopen the db in a FRESH handle — the job + items must be there + completed.
    const store = new SqliteJobStore(dbPath)
    const job = await store.getJob("job-1")
    expect(job.ok && job.value.status).toBe("completed")
    const items = await store.listItems("job-1")
    expect(items.ok && items.value.every((i) => i.status === "done")).toBe(true)
    store.close()
  })

  test("--resume re-drives an interrupted job to completion", async () => {
    const dbPath = path.join(dir, "resume.db")
    // Seed a CRASHED job directly: status running, 2 items stranded `running`.
    const seed = new SqliteJobStore(dbPath)
    const job: BatchJob = {
      id: "crashed",
      name: "j",
      status: "running",
      instruction: "greet",
      inputHeadersJson: '["name"]',
      poolSize: 2,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 1,
      startedAt: 1,
    }
    const item = (id: string, idx: number, status: BatchJobItem["status"]): BatchJobItem => ({
      jobId: "crashed",
      itemId: id,
      rowIndex: idx,
      rowJson: JSON.stringify({ name: id }),
      status,
      attemptCount: status === "running" ? 1 : 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await seed.createJob(job, [item("Alice", 0, "running"), item("Bob", 1, "running")])
    seed.close()

    const { io, written } = makeIo({})
    const code = await runBatchCmd(["--resume", "crashed", "--db", dbPath, "--out", "out.csv"], {
      runner: echo,
      io,
      now: () => 2,
      newId: counterId(),
    })
    expect(code).toBe(0)
    const store = new SqliteJobStore(dbPath)
    const done = await store.getJob("crashed")
    expect(done.ok && done.value.status).toBe("completed")
    store.close()
    expect(written["out.csv"]).toContain("_status") // results exported
  })

  test("--resume a nonexistent job ⇒ usage error (no crash)", async () => {
    const dbPath = path.join(dir, "empty.db")
    new SqliteJobStore(dbPath).close() // create empty db
    const { io } = makeIo({})
    const code = await runBatchCmd(["--resume", "ghost", "--db", dbPath, "--out", "out.csv"], {
      runner: echo,
      io,
    })
    expect(code).toBe(64)
  })
})

const counterId = (): (() => string) => {
  let n = 0
  return () => `job-${++n}`
}
