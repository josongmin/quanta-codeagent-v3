/**
 * RFC-01 A1 — `UserQuestionBroker` state machine (`@/session/user-question`).
 *
 * The broker is the pending-question TRUTH: a real question is published BEFORE
 * the awaiting Promise settles, answered/declined/cancelled by opaque
 * `requestId` under a revisioned CAS, and settled EXACTLY once. Clock and id
 * are injected so ordering/ids are deterministic.
 */

import { describe, expect, test } from "bun:test"
import { createUserQuestionBroker } from "@/session/user-question"

/** Deterministic broker: monotonic clock + sequential ids. */
const makeBroker = () => {
  let clock = 100
  let seq = 0
  return createUserQuestionBroker({
    now: () => {
      clock += 10
      return clock
    },
    mintId: () => {
      seq += 1
      return `q_${seq.toString().padStart(3, "0")}`
    },
  })
}

/** Let queued microtasks (Promise `.then`) run so we can assert non-settlement. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe("UserQuestionBroker — publish/settle", () => {
  test("pending is visible BEFORE the request Promise settles; answer resolves once and removes", async () => {
    const broker = makeBroker()
    let settled: unknown = "UNSET"
    const p = broker.request({ owner: { kind: "root" }, prompt: "Which branch?" })
    void p.then((o) => {
      settled = o
    })
    await flush()
    // Visible while still pending, and the promise has NOT settled.
    const pending = broker.listPending()
    expect(pending).toHaveLength(1)
    expect(settled).toBe("UNSET")
    const row = pending[0]!
    expect(row.owner).toEqual({ kind: "root" })

    const res = broker.answer(row.requestId, { text: "main" }, broker.revision())
    expect(res.ok).toBe(true)
    const outcome = await p
    expect(outcome).toEqual({ kind: "answered", text: "main" })
    // Exactly one settlement + removal from pending.
    expect(broker.listPending()).toHaveLength(0)
  })

  test("task-owner arm carries the exact taskId (no synthetic root)", async () => {
    const broker = makeBroker()
    const p = broker.request({ owner: { kind: "task", taskId: "task_abc" }, prompt: "go?" })
    void p.catch(() => {})
    const row = broker.listPending()[0]!
    expect(row.owner).toEqual({ kind: "task", taskId: "task_abc" })
    broker.cancel(row.requestId, "teardown", broker.revision())
    await p.catch(() => {})
  })

  test("decline settles with a declined outcome", async () => {
    const broker = makeBroker()
    const p = broker.request({ owner: { kind: "root" }, prompt: "q" })
    const row = broker.listPending()[0]!
    expect(broker.decline(row.requestId, broker.revision()).ok).toBe(true)
    expect(await p).toEqual({ kind: "declined" })
  })

  test("cancel settles with the given cancel reason", async () => {
    const broker = makeBroker()
    const p = broker.request({ owner: { kind: "root" }, prompt: "q" })
    const row = broker.listPending()[0]!
    expect(broker.cancel(row.requestId, "superseded", broker.revision()).ok).toBe(true)
    expect(await p).toEqual({ kind: "cancelled", reason: "superseded" })
  })
})

describe("UserQuestionBroker — lifecycle races", () => {
  test("double-answer: the second settlement of the same id is rejected (unknown)", async () => {
    const broker = makeBroker()
    const p = broker.request({ owner: { kind: "root" }, prompt: "q" })
    const row = broker.listPending()[0]!
    const first = broker.answer(row.requestId, { text: "a" }, broker.revision())
    expect(first.ok).toBe(true)
    const second = broker.answer(row.requestId, { text: "b" }, first.revision)
    expect(second).toMatchObject({ ok: false, reason: "unknown" })
    // The first (only) settlement wins.
    expect(await p).toEqual({ kind: "answered", text: "a" })
  })

  test("stale expected-revision is a typed rejection (does not settle)", async () => {
    const broker = makeBroker()
    const first = broker.request({ owner: { kind: "root" }, prompt: "q1" })
    void first.catch(() => {})
    const revAtRead = broker.revision()
    // A second request advances the domain revision.
    const second = broker.request({ owner: { kind: "root" }, prompt: "q2" })
    void second.catch(() => {})
    const firstId = broker.listPending().find((r) => r.preview.includes("q1"))!.requestId
    const stale = broker.answer(firstId, { text: "x" }, revAtRead)
    expect(stale).toMatchObject({ ok: false, reason: "stale" })
    // Still pending — the stale answer did not settle it.
    expect(broker.listPending().some((r) => r.requestId === firstId)).toBe(true)
    // Answering with the CURRENT revision succeeds.
    const ok = broker.answer(firstId, { text: "x" }, broker.revision())
    expect(ok.ok).toBe(true)
    expect(await first).toEqual({ kind: "answered", text: "x" })
    broker.cancelAll("teardown")
    await second.catch(() => {})
  })

  test("unknown id is a typed rejection", () => {
    const broker = makeBroker()
    expect(broker.answer("q_nope", { text: "x" }, broker.revision())).toMatchObject({
      ok: false,
      reason: "unknown",
    })
  })

  test("cancelAll (teardown) cancels every pending waiter exactly once", async () => {
    const broker = makeBroker()
    const a = broker.request({ owner: { kind: "root" }, prompt: "a" })
    const b = broker.request({ owner: { kind: "task", taskId: "t" }, prompt: "b" })
    expect(broker.listPending()).toHaveLength(2)
    broker.cancelAll("teardown")
    expect(broker.listPending()).toHaveLength(0)
    expect(await a).toEqual({ kind: "cancelled", reason: "teardown" })
    expect(await b).toEqual({ kind: "cancelled", reason: "teardown" })
  })
})

describe("UserQuestionBroker — projection", () => {
  test("listPending is deterministically oldest-first (askedAt, then requestId)", () => {
    const broker = makeBroker()
    void broker.request({ owner: { kind: "root" }, prompt: "first" }).catch(() => {})
    void broker.request({ owner: { kind: "root" }, prompt: "second" }).catch(() => {})
    void broker.request({ owner: { kind: "root" }, prompt: "third" }).catch(() => {})
    const rows = broker.listPending()
    expect(rows.map((r) => r.requestId)).toEqual(["q_001", "q_002", "q_003"])
    expect(rows.map((r) => r.askedAt)).toEqual([110, 120, 130])
    broker.cancelAll("teardown")
  })

  test("preview is bounded + secret-scrubbed; the raw prompt/answer never enter the projection", () => {
    const broker = makeBroker()
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef"
    const long = `token=${secret} ${"x".repeat(500)}`
    void broker.request({ owner: { kind: "root" }, prompt: long }).catch(() => {})
    const row = broker.listPending()[0]!
    // Bounded well under the raw length.
    expect(row.preview.length).toBeLessThanOrEqual(260)
    // The literal secret is not present verbatim.
    expect(row.preview.includes(secret)).toBe(false)
    // The projection shape carries no raw `prompt` field.
    expect(Object.keys(row).sort()).toEqual(["askedAt", "owner", "preview", "requestId"])
    broker.cancelAll("teardown")
  })

  test("revision increases monotonically on publish and on settle", () => {
    const broker = makeBroker()
    expect(broker.revision()).toBe(0)
    void broker.request({ owner: { kind: "root" }, prompt: "q" }).catch(() => {})
    expect(broker.revision()).toBe(1)
    const id = broker.listPending()[0]!.requestId
    broker.answer(id, { text: "a" }, broker.revision())
    expect(broker.revision()).toBe(2)
  })
})
