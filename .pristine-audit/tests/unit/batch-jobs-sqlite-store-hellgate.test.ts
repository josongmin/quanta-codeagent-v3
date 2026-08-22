/**
 * Hellgate — sqlite JobStore adapter (GAP7-3, ADR-0463).
 *
 * Proves the durable store is a STRUCTURAL drop-in for InMemoryJobStore (a full
 * BatchJobRunner completes over it) + survives a restart (the InMemory store
 * cannot) + maps optional fields per exactOptionalPropertyTypes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type BatchJob,
  type BatchJobItem,
  BatchJobRunner,
  type RowDispatchPort,
  type RowDispatchResult,
} from "@/agent/batch-jobs"
import { SqliteJobStore } from "@/host/runtime/batch-jobs-sqlite-store"
import { ok } from "@/shared"

const okDispatch: RowDispatchPort = () =>
  Promise.resolve(ok<RowDispatchResult>({ value: { done: true }, threadId: "t" }))
let clock = 1000
const makeRunner = (store: SqliteJobStore) =>
  new BatchJobRunner({
    store,
    dispatch: okDispatch,
    clock: () => ++clock,
    newId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
  })

const job = (id: string): BatchJob => ({
  id,
  name: "j",
  status: "pending",
  instruction: "do",
  inputHeadersJson: "[]",
  poolSize: 2,
  maxAttempts: 1,
  createdAt: 1,
  updatedAt: 1,
})
const item = (jobId: string, itemId: string, rowIndex: number): BatchJobItem => ({
  jobId,
  itemId,
  rowIndex,
  rowJson: "{}",
  status: "pending",
  attemptCount: 0,
  createdAt: 1,
  updatedAt: 1,
})

describe("SqliteJobStore — port round-trip", () => {
  test("create/get/put/listItems/putItem round-trip", async () => {
    const s = new SqliteJobStore()
    expect((await s.createJob(job("j1"), [item("j1", "i1", 0), item("j1", "i2", 1)])).ok).toBe(true)
    expect((await s.getJob("j1")).ok).toBe(true)
    const items = await s.listItems("j1")
    expect(items.ok && items.value.map((i) => i.itemId)).toEqual(["i1", "i2"]) // rowIndex order
    const upd = { ...item("j1", "i1", 0), status: "done" as const, resultJson: '{"x":1}' }
    expect((await s.putItem(upd)).ok).toBe(true)
    const after = await s.listItems("j1")
    expect(after.ok && after.value[0]?.status).toBe("done")
    expect(after.ok && after.value[0]?.resultJson).toBe('{"x":1}')
    s.close()
  })

  test("duplicate job id ⇒ store-failed; unknown putJob ⇒ job-not-found; unknown putItem ⇒ store-failed", async () => {
    const s = new SqliteJobStore()
    await s.createJob(job("j1"), [])
    const dup = await s.createJob(job("j1"), [])
    expect(dup.ok === false && dup.error.kind).toBe("store-failed")
    const pj = await s.putJob(job("ghost"))
    expect(pj.ok === false && pj.error.kind).toBe("job-not-found")
    const pi = await s.putItem(item("j1", "ghost-item", 0))
    expect(pi.ok === false && pi.error.kind).toBe("store-failed")
    s.close()
  })

  test("optional fields OMITTED when absent (exactOptionalPropertyTypes)", async () => {
    const s = new SqliteJobStore()
    await s.createJob(job("j1"), [])
    const got = await s.getJob("j1")
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect("startedAt" in got.value).toBe(false)
      expect("lastError" in got.value).toBe(false)
      expect("outputSchemaJson" in got.value).toBe(false)
    }
    s.close()
  })

  test("a full BatchJobRunner completes over the sqlite store (drop-in)", async () => {
    const s = new SqliteJobStore()
    const runner = makeRunner(s)
    const submitted = await runner.submit({
      name: "j",
      instruction: "do",
      rows: [{ a: "1" }, { a: "2" }, { a: "3" }],
      headers: ["a"],
      poolSize: 2,
      maxAttempts: 1,
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    expect(snap.ok && snap.value.job.status).toBe("completed")
    expect(snap.ok && snap.value.items.every((i) => i.status === "done")).toBe(true)
    s.close()
  })
})

describe("SqliteJobStore — restart survival", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "quanta-batchdb-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("a job persisted to a file survives a close + reopen (InMemory cannot)", async () => {
    const file = path.join(dir, "jobs.db")
    const s1 = new SqliteJobStore(file)
    await s1.createJob(job("persist-1"), [item("persist-1", "i1", 0)])
    s1.close()
    // Fresh handle over the SAME file — the job + item must still be there.
    const s2 = new SqliteJobStore(file)
    const got = await s2.getJob("persist-1")
    expect(got.ok).toBe(true)
    const items = await s2.listItems("persist-1")
    expect(items.ok && items.value.length).toBe(1)
    s2.close()
  })
})
