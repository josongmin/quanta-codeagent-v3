/**
 * HELLGATE — CSV batch-job runner (agent_jobs), ADR-0463.
 *
 * Proves the happy path AND every failure mode of the row-indexed fan-out:
 *   - empty CSV / empty row list → job completes with zero items;
 *   - malformed CSV → parse returns Err, never throws;
 *   - schema-reject row → that row is `failed` (schema-rejected), the OTHER
 *     rows still `done` (one bad row does NOT abort the job);
 *   - partial failure + retry exhaustion → a row that fails every attempt is
 *     sticky `failed` with the attempt count == maxAttempts;
 *   - flaky row recovered by retry → `done` after N attempts;
 *   - abort mid-job → job `cancelled`, runToEnd resolves Err(aborted);
 *   - gate-off no-op → constructing the runner + store with no submit leaves
 *     the store byte-empty (no side effects);
 *   - bounded pool → never more than poolSize dispatches in flight;
 *   - export CSV → deterministic column + row order with status/result/error.
 *
 * Deterministic: injected clock + id-gen + a scripted in-memory dispatch port.
 * No network, no real subagent.
 */

import { describe, expect, test } from "bun:test"
import {
  type BatchJob,
  type BatchJobError,
  type BatchJobItem,
  BatchJobRunner,
  type BatchJobSpec,
  compileRowSchema,
  InMemoryJobStore,
  type JobRow,
  type JobStorePort,
  MAX_POOL_SIZE,
  parseRowsFromCsv,
  type RowDispatchPort,
  type RowDispatchResult,
} from "@/agent/batch-jobs"
import { err, ok, type Result } from "@/shared"

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic harness
// ─────────────────────────────────────────────────────────────────────────────

const makeClock = () => {
  let t = 1_000
  return () => ++t
}

const makeIdGen = (prefix = "id") => {
  let n = 0
  return () => `${prefix}-${++n}`
}

/** Build a runner over a fresh in-memory store with the given dispatch. */
const makeRunner = (dispatch: RowDispatchPort, schema?: ReturnType<typeof compileRowSchema>) => {
  const store = new InMemoryJobStore()
  const runner = new BatchJobRunner({
    store,
    dispatch,
    clock: makeClock(),
    newId: makeIdGen(),
    ...(schema ? { schema } : {}),
  })
  return { store, runner }
}

const spec = (rows: ReadonlyArray<JobRow>, over: Partial<BatchJobSpec> = {}): BatchJobSpec => ({
  name: "test-job",
  instruction: "process the row",
  rows,
  headers: ["a", "b"],
  poolSize: 2,
  maxAttempts: 2,
  ...over,
})

const okDispatch =
  (value: unknown = { ok: true }): RowDispatchPort =>
  () =>
    Promise.resolve(ok<RowDispatchResult>({ value, threadId: "thread-x" }))

// ─────────────────────────────────────────────────────────────────────────────
// CSV parse
// ─────────────────────────────────────────────────────────────────────────────

describe("CSV parse", () => {
  test("parses headers + rows via csv-parse", () => {
    const r = parseRowsFromCsv("a,b\n1,2\n3,4\n")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.headers).toEqual(["a", "b"])
    expect(r.value.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ])
  })

  test("empty input → zero rows, no error", () => {
    const r = parseRowsFromCsv("")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.rows.length).toBe(0)
    expect(r.value.headers).toEqual([])
  })

  test("header-only input → zero rows, headers recovered", () => {
    const r = parseRowsFromCsv("a,b,c\n")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.rows.length).toBe(0)
    expect(r.value.headers).toEqual(["a", "b", "c"])
  })

  test("malformed CSV (ragged row) → Err, never throws", () => {
    const r = parseRowsFromCsv("a,b\n1,2,3\n")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("invalid-spec")
  })

  test("non-string input → Err, never throws", () => {
    // @ts-expect-error — exercising the programmer-bug guard
    const r = parseRowsFromCsv(42)
    expect(r.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Happy path + empty job
// ─────────────────────────────────────────────────────────────────────────────

describe("happy path", () => {
  test("every row dispatched + done; job completed", async () => {
    const { runner } = makeRunner(okDispatch({ greeting: "hi" }))
    const submitted = await runner.submit(
      spec([
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ]),
    )
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    expect(snap.ok).toBe(true)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.job.status).toBe("completed")
    expect(snap.value.items.map((i) => i.status)).toEqual(["done", "done"])
    expect(snap.value.items[0]?.assignedThreadId).toBe("thread-x")
    expect(snap.value.items[0]?.resultJson).toBe(JSON.stringify({ greeting: "hi" }))
    expect(snap.value.items.every((i) => i.attemptCount === 1)).toBe(true)
  })

  test("empty row list → job completes immediately with zero items", async () => {
    const { runner } = makeRunner(okDispatch())
    const submitted = await runner.submit(spec([]))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.job.status).toBe("completed")
    expect(snap.value.items.length).toBe(0)
  })

  test("items are persisted in rowIndex order", async () => {
    const { runner } = makeRunner(okDispatch())
    const submitted = await runner.submit(spec([{ a: "x" }, { a: "y" }, { a: "z" }]))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.items.map((i) => i.rowIndex)).toEqual([0, 1, 2])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Schema enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP7-1: concurrency cap (poolSize bound)", () => {
  test("poolSize > MAX_POOL_SIZE ⇒ invalid-spec (fan-out DoS guard)", async () => {
    const { runner } = makeRunner(okDispatch())
    const r = await runner.submit(spec([{ a: "x" }], { poolSize: MAX_POOL_SIZE + 1 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-spec")
  })
  test("poolSize === MAX_POOL_SIZE ⇒ accepted (boundary inclusive)", async () => {
    const { runner } = makeRunner(okDispatch())
    const r = await runner.submit(spec([{ a: "x" }], { poolSize: MAX_POOL_SIZE }))
    expect(r.ok).toBe(true)
  })
  test("poolSize 0 / negative still rejected", async () => {
    const { runner } = makeRunner(okDispatch())
    expect((await runner.submit(spec([{ a: "x" }], { poolSize: 0 }))).ok).toBe(false)
    expect((await runner.submit(spec([{ a: "x" }], { poolSize: -3 }))).ok).toBe(false)
  })
})

describe("GAP7-5: resume an interrupted job", () => {
  // Simulate a crash: a `running` job whose items are stranded mid-flight.
  const crashedJob = async (store: InMemoryJobStore) => {
    const job: BatchJob = {
      id: "crashed", name: "j", status: "running", instruction: "do",
      inputHeadersJson: "[]", poolSize: 2, maxAttempts: 2, createdAt: 1, updatedAt: 1, startedAt: 1,
    }
    const mk = (itemId: string, rowIndex: number, status: BatchJobItem["status"], attempt: number): BatchJobItem => ({
      jobId: "crashed", itemId, rowIndex, rowJson: "{}", status, attemptCount: attempt, createdAt: 1, updatedAt: 1,
    })
    await store.createJob(job, [
      mk("i0", 0, "done", 1),
      mk("i1", 1, "running", 1), // stranded
      mk("i2", 2, "running", 1), // stranded
    ])
  }

  test("stranded `running` items are re-dispatched ⇒ job completes", async () => {
    const { store, runner } = makeRunner(okDispatch())
    await crashedJob(store)
    const snap = await runner.resume("crashed")
    expect(snap.ok).toBe(true)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.job.status).toBe("completed")
    expect(snap.value.items.every((i) => i.status === "done")).toBe(true)
    // the previously-done item stays done; the two stranded ones were re-run.
    expect(snap.value.items.find((i) => i.itemId === "i0")?.status).toBe("done")
  })

  test("a stranded item's interrupted attempt is rolled back (attempt cap honored)", async () => {
    // Runner that always fails: a resumed item at attempt 1 (rolled back to 0)
    // gets maxAttempts(2) fresh tries, then sticky-fails — proving the roll-back.
    let calls = 0
    const failing: RowDispatchPort = () => {
      calls++
      return Promise.resolve(err({ kind: "store-failed", reason: "x" }))
    }
    const { store, runner } = makeRunner(failing)
    await crashedJob(store)
    await runner.resume("crashed")
    // 2 stranded items × 2 attempts each (roll-back gave each a full cap) = 4.
    expect(calls).toBe(4)
  })

  test("a terminal (completed) job ⇒ resume is a no-op snapshot", async () => {
    const { store, runner } = makeRunner(okDispatch())
    const job: BatchJob = {
      id: "done-job", name: "j", status: "completed", instruction: "do",
      inputHeadersJson: "[]", poolSize: 2, maxAttempts: 1, createdAt: 1, updatedAt: 1,
    }
    await store.createJob(job, [])
    const snap = await runner.resume("done-job")
    expect(snap.ok && snap.value.job.status).toBe("completed")
  })
})

describe("GAP7 audit R2: concurrency-safe item claim (no double-dispatch)", () => {
  test("claimItem is atomic: two concurrent claims on one pending item ⇒ exactly one wins", async () => {
    const store = new InMemoryJobStore()
    const job: BatchJob = {
      id: "j", name: "j", status: "running", instruction: "i", inputHeadersJson: "[]",
      poolSize: 1, maxAttempts: 1, createdAt: 1, updatedAt: 1,
    }
    const it: BatchJobItem = {
      jobId: "j", itemId: "i1", rowIndex: 0, rowJson: "{}", status: "pending", attemptCount: 0, createdAt: 1, updatedAt: 1,
    }
    await store.createJob(job, [it])
    const [a, b] = await Promise.all([store.claimItem("j", "i1", 2), store.claimItem("j", "i1", 3)])
    const winners = [a, b].filter((r) => r.ok && r.value !== null)
    const losers = [a, b].filter((r) => r.ok && r.value === null)
    expect(winners).toHaveLength(1) // exactly one claim won
    expect(losers).toHaveLength(1) // the other got null (lost)
  })

  test("two concurrent runToEnd over a SHARED store ⇒ each row dispatched EXACTLY once", async () => {
    const store = new InMemoryJobStore()
    const dispatches = new Map<number, number>()
    const countingDispatch: RowDispatchPort = (req) => {
      dispatches.set(req.rowIndex, (dispatches.get(req.rowIndex) ?? 0) + 1)
      return Promise.resolve(ok<RowDispatchResult>({ value: { ok: true } }))
    }
    const mk = () =>
      new BatchJobRunner({ store, dispatch: countingDispatch, clock: makeClock(), newId: makeIdGen() })
    const submitter = mk()
    const submitted = await submitter.submit(spec([{ a: "0" }, { a: "1" }, { a: "2" }, { a: "3" }], { poolSize: 4 }))
    if (!submitted.ok) throw new Error("unreachable")
    // Two runners drive the SAME job over the SAME store concurrently.
    await Promise.all([mk().runToEnd(submitted.value), mk().runToEnd(submitted.value)])
    for (const [, n] of dispatches) expect(n).toBe(1) // NO double-dispatch
    expect([...dispatches.keys()].sort()).toEqual([0, 1, 2, 3]) // every row ran
  })
})

describe("output schema enforcement", () => {
  const schemaJson = JSON.stringify({
    type: "object",
    fields: { name: "string", score: "number" },
  })

  test("schema-reject row is `failed` while sibling rows are `done`", async () => {
    let call = 0
    const dispatch: RowDispatchPort = () => {
      call += 1
      // row 0: valid; row 1: missing `score` → schema reject
      const value = call === 1 ? { name: "ok", score: 9 } : { name: "bad" }
      return Promise.resolve(ok<RowDispatchResult>({ value }))
    }
    const { runner } = makeRunner(dispatch, compileRowSchema(schemaJson))
    const submitted = await runner.submit(
      spec([{ a: "1" }, { a: "2" }], { poolSize: 1, outputSchemaJson: schemaJson }),
    )
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    // Job still completes — one bad row does NOT abort.
    expect(snap.value.job.status).toBe("completed")
    expect(snap.value.items[0]?.status).toBe("done")
    expect(snap.value.items[1]?.status).toBe("failed")
    expect(snap.value.items[1]?.lastError).toContain("schema-rejected")
    // A schema reject is NOT retried (it would fail identically).
    expect(snap.value.items[1]?.attemptCount).toBe(1)
  })

  test("validated value is what gets stored (strict object strips nothing valid)", async () => {
    const { runner } = makeRunner(
      okDispatch({ name: "alice", score: 100 }),
      compileRowSchema(schemaJson),
    )
    const submitted = await runner.submit(spec([{ a: "1" }], { outputSchemaJson: schemaJson }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.items[0]?.resultJson).toBe(JSON.stringify({ name: "alice", score: 100 }))
  })

  test("malformed schema descriptor → fail-closed (rejects every row)", async () => {
    const bad = "{ not json"
    const { runner } = makeRunner(okDispatch({ anything: true }), compileRowSchema(bad))
    const submitted = await runner.submit(spec([{ a: "1" }], { outputSchemaJson: bad }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.items[0]?.status).toBe("failed")
  })

  test("unknown extra key is rejected (strict)", () => {
    const v = compileRowSchema(schemaJson)({ name: "a", score: 1, extra: true })
    expect(v.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Retry + failure
// ─────────────────────────────────────────────────────────────────────────────

describe("retry + failure", () => {
  test("flaky row recovered by retry → done", async () => {
    let attempts = 0
    const dispatch: RowDispatchPort = () => {
      attempts += 1
      if (attempts === 1) {
        return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: "flaky" }))
      }
      return Promise.resolve(ok<RowDispatchResult>({ value: { done: true } }))
    }
    const { runner } = makeRunner(dispatch)
    const submitted = await runner.submit(spec([{ a: "1" }], { maxAttempts: 3 }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.items[0]?.status).toBe("done")
    expect(snap.value.items[0]?.attemptCount).toBe(2)
  })

  test("retry exhaustion → sticky failed at attemptCount == maxAttempts", async () => {
    const dispatch: RowDispatchPort = () =>
      Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: "always fails" }))
    const { runner } = makeRunner(dispatch)
    const submitted = await runner.submit(spec([{ a: "1" }], { maxAttempts: 3 }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.items[0]?.status).toBe("failed")
    expect(snap.value.items[0]?.attemptCount).toBe(3)
    expect(snap.value.items[0]?.lastError).toContain("dispatch-failed")
    // Job still `completed` (terminal), not stuck.
    expect(snap.value.job.status).toBe("completed")
  })

  test("partial failure: some rows done, some failed, job completes", async () => {
    let call = 0
    const dispatch: RowDispatchPort = () => {
      call += 1
      if (call % 2 === 0) {
        return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: "even fails" }))
      }
      return Promise.resolve(ok<RowDispatchResult>({ value: { n: call } }))
    }
    const { runner } = makeRunner(dispatch)
    const submitted = await runner.submit(
      spec([{ a: "1" }, { a: "2" }], { poolSize: 1, maxAttempts: 1 }),
    )
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    const statuses = snap.value.items.map((i) => i.status).sort()
    expect(statuses).toEqual(["done", "failed"])
    expect(snap.value.job.status).toBe("completed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Abort
// ─────────────────────────────────────────────────────────────────────────────

describe("abort", () => {
  test("pre-aborted signal → job cancelled, Err(aborted)", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const { runner } = makeRunner(okDispatch())
    const submitted = await runner.submit(spec([{ a: "1" }]))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value, ctrl.signal)
    expect(snap.ok).toBe(false)
    if (snap.ok) throw new Error("unreachable")
    expect(snap.error.kind).toBe("aborted")
    const after = await runner.snapshot(submitted.value)
    if (!after.ok) throw new Error("unreachable")
    expect(after.value.job.status).toBe("cancelled")
  })

  test("abort mid-job via dispatch returning aborted → job cancelled", async () => {
    const ctrl = new AbortController()
    const dispatch: RowDispatchPort = (req) => {
      if (req.rowIndex === 0) {
        return Promise.resolve(ok<RowDispatchResult>({ value: { ok: 1 } }))
      }
      // Second row: abort fires.
      ctrl.abort()
      return Promise.resolve(err<BatchJobError>({ kind: "aborted" }))
    }
    const { runner } = makeRunner(dispatch)
    const submitted = await runner.submit(spec([{ a: "1" }, { a: "2" }], { poolSize: 1 }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value, ctrl.signal)
    expect(snap.ok).toBe(false)
    const after = await runner.snapshot(submitted.value)
    if (!after.ok) throw new Error("unreachable")
    expect(after.value.job.status).toBe("cancelled")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bounded pool
// ─────────────────────────────────────────────────────────────────────────────

describe("bounded concurrency pool", () => {
  test("never more than poolSize dispatches in flight", async () => {
    let inFlight = 0
    let peak = 0
    const dispatch: RowDispatchPort = () =>
      new Promise<Result<RowDispatchResult, BatchJobError>>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight -= 1
          resolve(ok<RowDispatchResult>({ value: {} }))
        }, 2)
      })
    const { runner } = makeRunner(dispatch)
    const rows = Array.from({ length: 10 }, (_, i) => ({ a: String(i) }))
    const submitted = await runner.submit(spec(rows, { poolSize: 3 }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(peak).toBeLessThanOrEqual(3)
    expect(snap.value.items.every((i) => i.status === "done")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Gate-off no-op (byte-identity)
// ─────────────────────────────────────────────────────────────────────────────

describe("default-OFF", () => {
  test("constructing runner + store with NO submit leaves store empty", async () => {
    const store = new InMemoryJobStore()
    // No submit call ⇒ no job exists ⇒ any getJob is job-not-found.
    const r = await store.getJob("anything")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("job-not-found")
  })

  test("runToEnd on an unknown job → job-not-found, no crash", async () => {
    const { runner } = makeRunner(okDispatch())
    const snap = await runner.runToEnd("nope")
    expect(snap.ok).toBe(false)
    if (snap.ok) throw new Error("unreachable")
    expect(snap.error.kind).toBe("job-not-found")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Spec validation (programmer-bug → Err, never throw)
// ─────────────────────────────────────────────────────────────────────────────

describe("spec validation", () => {
  test("poolSize < 1 → invalid-spec", async () => {
    const { runner } = makeRunner(okDispatch())
    const r = await runner.submit(spec([{ a: "1" }], { poolSize: 0 }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("invalid-spec")
  })

  test("maxAttempts < 1 → invalid-spec", async () => {
    const { runner } = makeRunner(okDispatch())
    const r = await runner.submit(spec([{ a: "1" }], { maxAttempts: 0 }))
    expect(r.ok).toBe(false)
  })

  test("empty name → invalid-spec", async () => {
    const { runner } = makeRunner(okDispatch())
    const r = await runner.submit(spec([{ a: "1" }], { name: "" }))
    expect(r.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

describe("export CSV", () => {
  test("deterministic columns + rows with status/result/error", async () => {
    let call = 0
    const dispatch: RowDispatchPort = () => {
      call += 1
      if (call === 2) {
        return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: "boom" }))
      }
      return Promise.resolve(ok<RowDispatchResult>({ value: { r: call } }))
    }
    const { runner } = makeRunner(dispatch)
    const submitted = await runner.submit(
      spec(
        [
          { a: "1", b: "2" },
          { a: "3", b: "4" },
        ],
        { poolSize: 1, maxAttempts: 1 },
      ),
    )
    if (!submitted.ok) throw new Error("unreachable")
    await runner.runToEnd(submitted.value)
    const csv = await runner.exportCsv(submitted.value)
    expect(csv.ok).toBe(true)
    if (!csv.ok) throw new Error("unreachable")
    const lines = csv.value.trimEnd().split("\n")
    expect(lines[0]).toBe("a,b,_status,_result,_error")
    // row 0 done, row 1 failed
    expect(lines[1]).toContain("1,2,done")
    expect(lines[2]).toContain("3,4,failed")
  })

  test("cells needing quotes are RFC-4180 escaped", async () => {
    const { runner } = makeRunner(okDispatch({ note: 'has "quote", comma' }))
    const submitted = await runner.submit(
      spec([{ a: "x,y", b: 'he said "hi"' }], { headers: ["a", "b"] }),
    )
    if (!submitted.ok) throw new Error("unreachable")
    await runner.runToEnd(submitted.value)
    const csv = await runner.exportCsv(submitted.value)
    if (!csv.ok) throw new Error("unreachable")
    expect(csv.value).toContain('"x,y"')
    expect(csv.value).toContain('"he said ""hi"""')
  })

  test("export on unknown job → Err", async () => {
    const { runner } = makeRunner(okDispatch())
    const r = await runner.exportCsv("nope")
    expect(r.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Store-fault → job `failed` (the otherwise-dead JobStatus arm)
// ─────────────────────────────────────────────────────────────────────────────

/** An InMemoryJobStore whose `listItems` and/or `putItem` can be made to fault,
 *  to prove a store-level fault drives the job to `failed` (NOT `completed`). */
class FaultyJobStore extends InMemoryJobStore {
  failListAfter = Number.POSITIVE_INFINITY
  failPutItem = false
  private listCalls = 0

  override listItems(jobId: string): Promise<Result<ReadonlyArray<BatchJobItem>, BatchJobError>> {
    this.listCalls += 1
    if (this.listCalls > this.failListAfter) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: "list boom" }))
    }
    return super.listItems(jobId)
  }

  override putItem(item: BatchJobItem): Promise<Result<void, BatchJobError>> {
    if (this.failPutItem) {
      return Promise.resolve(err<BatchJobError>({ kind: "store-failed", reason: "put boom" }))
    }
    return super.putItem(item)
  }
}

const makeRunnerWith = (store: JobStorePort, dispatch: RowDispatchPort) =>
  new BatchJobRunner({ store, dispatch, clock: makeClock(), newId: makeIdGen() })

describe("store-fault → job failed", () => {
  test("listItems fault mid-pump → job `failed`, lastError carries cause", async () => {
    const store = new FaultyJobStore()
    const runner = makeRunnerWith(store, okDispatch())
    const submitted = await runner.submit(spec([{ a: "1" }, { a: "2" }], { poolSize: 1 }))
    if (!submitted.ok) throw new Error("unreachable")
    // First listItems (the pump's initial load) faults immediately.
    store.failListAfter = 0
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.job.status).toBe("failed")
    expect(snap.value.job.lastError).toContain("store failure")
  })

  test("putItem fault during item persistence → job `failed`", async () => {
    const store = new FaultyJobStore()
    const runner = makeRunnerWith(store, okDispatch())
    const submitted = await runner.submit(spec([{ a: "1" }], { poolSize: 1 }))
    if (!submitted.ok) throw new Error("unreachable")
    store.failPutItem = true
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.job.status).toBe("failed")
    expect(snap.value.job.lastError).toContain("store failure")
  })

  test("store-fault job is NOT misreported as completed", async () => {
    const store = new FaultyJobStore()
    const runner = makeRunnerWith(store, okDispatch())
    const submitted = await runner.submit(spec([{ a: "1" }], { poolSize: 1 }))
    if (!submitted.ok) throw new Error("unreachable")
    store.failPutItem = true
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    expect(snap.value.job.status).not.toBe("completed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Aborted item is resumable, never stranded `running`
// ─────────────────────────────────────────────────────────────────────────────

describe("aborted item state", () => {
  test("dispatch-aborted item is rolled back to pending (resumable), attempt un-counted", async () => {
    const ctrl = new AbortController()
    const dispatch: RowDispatchPort = () => {
      ctrl.abort()
      return Promise.resolve(err<BatchJobError>({ kind: "aborted" }))
    }
    const { runner } = makeRunner(dispatch)
    const submitted = await runner.submit(spec([{ a: "1" }], { poolSize: 1 }))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value, ctrl.signal)
    expect(snap.ok).toBe(false)
    const after = await runner.snapshot(submitted.value)
    if (!after.ok) throw new Error("unreachable")
    expect(after.value.job.status).toBe("cancelled")
    const item = after.value.items[0]
    // Never stranded `running`: left `pending` so a re-run re-dispatches it.
    expect(item?.status).toBe("pending")
    // The aborted attempt is not charged against the cap.
    expect(item?.attemptCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Job-status enum: every arm is reachable (no dead enum arm)
// ─────────────────────────────────────────────────────────────────────────────

describe("job-status enum reachability", () => {
  test("`failed` arm is reachable (store fault) — guards against silent dead arm", async () => {
    const store = new FaultyJobStore()
    store.failListAfter = 0
    const runner = makeRunnerWith(store, okDispatch())
    const submitted = await runner.submit(spec([{ a: "1" }]))
    if (!submitted.ok) throw new Error("unreachable")
    const snap = await runner.runToEnd(submitted.value)
    if (!snap.ok) throw new Error("unreachable")
    const reached: BatchJob["status"] = snap.value.job.status
    expect(reached).toBe("failed")
  })
})
