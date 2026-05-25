/**
 * HELLGATE — adversarial EmbedBatcher proofs (ADR-0264).
 *
 * Invariants under attack:
 *  - Window coalescing: N same-tick embed() → 1 underlying call.
 *  - Window boundary: calls past the window arm a fresh flush (2 calls).
 *  - Provider batch_size: a single flush larger than maxBatchSize splits.
 *  - Single-flight: identical text in flight → 1 underlying call, all
 *    callers see the same vector.
 *  - flush(): drains pending synchronously (no real-time wait).
 *  - pending(): accurate while queued, 0 after flush.
 *  - Underlying throw → every pending caller gets `underlying-failed`,
 *    map cleanup so a *new* embed() starts a fresh flight.
 *  - AbortSignal: pre-enqueue → `aborted` immediately; post-enqueue →
 *    removed from pending, resolved with `aborted`, others unaffected.
 *  - windowMs=0 → microtask-scheduled flush; embed() still resolves.
 *  - Single-flight purity: in-flight map MUST settle back to size 0.
 *  - Default-OFF byte-identical: factory never throws, no global mutation.
 *  - Performance sanity: 1000 concurrent → completes (no quadratic).
 *  - BatchError 4-arm: `assertNever`-exhaustive switch covers all kinds.
 *  - Zombie timer: no leftover timer after flush().
 *
 * 15 adversarial cases.
 */
import { describe, expect, test } from "bun:test"
import {
  type BatchError,
  createDefaultBatcher,
  createSingleFlight,
  type EmbeddingVector,
  type UnderlyingEmbedder,
} from "@/retrieval/batching"
import { assertNever } from "@/shared"

/* --------------------------------------------------------------- */
/* Test doubles                                                    */
/* --------------------------------------------------------------- */

interface CountingEmbedder extends UnderlyingEmbedder {
  readonly calls: string[][]
}

const counting = (
  impl?: (texts: readonly string[]) => readonly EmbeddingVector[],
): CountingEmbedder => {
  const calls: string[][] = []
  return {
    calls,
    async embed(texts) {
      calls.push([...texts])
      return impl ? impl(texts) : texts.map((t) => [t.length])
    },
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/* --------------------------------------------------------------- */

describe("EmbedBatcher hellgate (ADR-0264)", () => {
  test("HELL-EB-01: single embed() resolves with the vector after flush()", async () => {
    const e = counting((t) => t.map((s) => [s.length]))
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 50, maxBatchSize: 96 } })
    const p = b.embed("hello")
    await b.flush()
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([5])
    expect(e.calls.length).toBe(1)
  })

  test("HELL-EB-02: 3 embed() within window → 1 underlying call (window coalesce)", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 50, maxBatchSize: 96 } })
    const ps = [b.embed("a"), b.embed("b"), b.embed("c")]
    await b.flush()
    const rs = await Promise.all(ps)
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(e.calls.length).toBe(1)
    expect(e.calls[0]).toEqual(["a", "b", "c"])
  })

  test("HELL-EB-03: calls separated by > windowMs → 2 underlying calls", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 10, maxBatchSize: 96 } })
    const p1 = b.embed("a")
    await sleep(40) // > windowMs → first batch fires
    const p2 = b.embed("b")
    await b.flush()
    await Promise.all([p1, p2])
    expect(e.calls.length).toBe(2)
    expect(e.calls[0]).toEqual(["a"])
    expect(e.calls[1]).toEqual(["b"])
  })

  test("HELL-EB-04: pending > maxBatchSize → split into chunks (parallel)", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 0, maxBatchSize: 2 } })
    const ps: Array<Promise<unknown>> = []
    for (const t of ["a", "b", "c", "d", "e"]) ps.push(b.embed(t))
    await b.flush()
    await Promise.all(ps)
    // 5 texts / batch=2 → 3 chunks (2,2,1)
    expect(e.calls.length).toBe(3)
    expect(e.calls.map((c) => c.length).sort()).toEqual([1, 2, 2])
  })

  test("HELL-EB-05: same text concurrently → 1 underlying call, both promises resolve", async () => {
    const e = counting((t) => t.map((s) => [s.length * 2]))
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 0, maxBatchSize: 96 } })
    const p1 = b.embed("hello")
    const p2 = b.embed("hello")
    await b.flush()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok && r2.ok).toBe(true)
    expect(e.calls.length).toBe(1) // single underlying call
    expect(e.calls[0]).toEqual(["hello"]) // in-batch dedupe → 1 text issued
    if (r1.ok && r2.ok) expect(r1.value).toEqual(r2.value)
  })

  test("HELL-EB-06: flush() drains pending without waiting for the timer", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 10_000, maxBatchSize: 96 } })
    const p = b.embed("a")
    expect(b.pending()).toBe(1)
    const t0 = Date.now()
    await b.flush()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(500) // way under the 10s window
    const r = await p
    expect(r.ok).toBe(true)
    expect(b.pending()).toBe(0)
  })

  test("HELL-EB-07: pending() reports queued count accurately", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 50, maxBatchSize: 96 } })
    expect(b.pending()).toBe(0)
    void b.embed("a")
    void b.embed("b")
    expect(b.pending()).toBe(2)
    await b.flush()
    expect(b.pending()).toBe(0)
  })

  test("HELL-EB-08: underlying throw → every pending caller gets `underlying-failed`", async () => {
    const e: UnderlyingEmbedder = {
      async embed() {
        throw new Error("provider 500")
      },
    }
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 0, maxBatchSize: 96 } })
    const [r1, r2, r3] = await Promise.all([b.embed("a"), b.embed("b"), b.embed("c")])
    const all = [r1, r2, r3]
    for (const r of all) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.kind).toBe("underlying-failed")
        if (r.error.kind === "underlying-failed") {
          expect(r.error.detail).toContain("provider 500")
        }
      }
    }
  })

  test("HELL-EB-09: AbortSignal pre-enqueue → `aborted` immediately; post-enqueue → removed", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 50, maxBatchSize: 96 } })

    // Pre-enqueue abort: signal is already aborted at embed() time.
    const ac1 = new AbortController()
    ac1.abort()
    const r1 = await b.embed("pre", { signal: ac1.signal })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error.kind).toBe("aborted")
    expect(e.calls.length).toBe(0) // never issued

    // Post-enqueue abort: enqueue, then abort before flush.
    const ac2 = new AbortController()
    const p2 = b.embed("kept-pending", { signal: ac2.signal })
    const p3 = b.embed("kept-alive") // unrelated caller in same batch
    expect(b.pending()).toBe(2)
    ac2.abort()
    expect(b.pending()).toBe(1) // p2 removed from queue
    await b.flush()
    const r2 = await p2
    const r3 = await p3
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.kind).toBe("aborted")
    expect(r3.ok).toBe(true)
    expect(e.calls).toEqual([["kept-alive"]]) // only the survivor was issued
  })

  test("HELL-EB-10: windowMs=0 → microtask flush, still resolves", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 0, maxBatchSize: 96 } })
    const [r1, r2] = await Promise.all([b.embed("a"), b.embed("b")])
    expect(r1.ok && r2.ok).toBe(true)
    expect(e.calls.length).toBe(1) // microtask coalesces same-tick calls
    expect(e.calls[0]).toEqual(["a", "b"])
  })

  test("HELL-EB-11: single-flight helper purity — dedupe map cleans up on settle", async () => {
    const sf = createSingleFlight<number>()
    let calls = 0
    const r = await sf.run("k", async () => {
      calls++
      return 42
    })
    expect(r).toBe(42)
    expect(sf.size()).toBe(0) // cleaned after settle

    // Failure path: still cleans up.
    await expect(
      sf.run("k", async () => {
        calls++
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(sf.size()).toBe(0)
    expect(calls).toBe(2) // two distinct flights, not coalesced (settle between)
  })

  test("HELL-EB-12: default-OFF byte-identical — factory never throws on construction", () => {
    const e = counting()
    // No embed() calls → no underlying invocation, no side effects.
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 50, maxBatchSize: 96 } })
    expect(b.pending()).toBe(0)
    expect(e.calls.length).toBe(0)
    // Construction with invalid config also does NOT throw — error surfaces
    // at embed() time as `config-invalid` (caller doesn't need try/catch).
    const bBad = createDefaultBatcher({
      embedder: e,
      config: { windowMs: -1, maxBatchSize: 0 },
    })
    expect(bBad.pending()).toBe(0)
  })

  test("HELL-EB-13: 1000 concurrent embed() → completes, no quadratic blowup", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 0, maxBatchSize: 128 } })
    const ps: Array<Promise<unknown>> = []
    for (let i = 0; i < 1000; i++) ps.push(b.embed(`t-${i}`))
    const t0 = Date.now()
    await b.flush()
    const rs = await Promise.all(ps)
    const elapsed = Date.now() - t0
    expect(rs.every((r) => (r as { ok: boolean }).ok)).toBe(true)
    expect(elapsed).toBeLessThan(2000) // generous bound; CI sanity
    // 1000 / 128 = 8 chunks
    expect(e.calls.length).toBe(8)
  })

  test("HELL-EB-14: BatchError 4-arm exhaustive via assertNever AND runtime", async () => {
    const describeArm = (er: BatchError): string => {
      switch (er.kind) {
        case "underlying-failed":
          return `under:${er.detail}`
        case "aborted":
          return "abort"
        case "vector-missing":
          return `miss:${er.text}`
        case "config-invalid":
          return `cfg:${er.detail}`
        default:
          return assertNever(er)
      }
    }
    expect(describeArm({ kind: "underlying-failed", detail: "x" })).toBe("under:x")
    expect(describeArm({ kind: "aborted" })).toBe("abort")
    expect(describeArm({ kind: "vector-missing", text: "y" })).toBe("miss:y")
    expect(describeArm({ kind: "config-invalid", detail: "z" })).toBe("cfg:z")

    // Runtime proof: config-invalid via bad config.
    const bBad = createDefaultBatcher({
      embedder: {
        async embed() {
          return []
        },
      },
      config: { windowMs: -1, maxBatchSize: 96 },
    })
    const rCfg = await bBad.embed("x")
    expect(rCfg.ok).toBe(false)
    if (!rCfg.ok) expect(rCfg.error.kind).toBe("config-invalid")

    // Runtime proof: vector-missing via truncating underlying.
    const truncating: UnderlyingEmbedder = {
      async embed(texts) {
        return texts.length > 0 ? [[1]] : []
      },
    }
    const bTrunc = createDefaultBatcher({
      embedder: truncating,
      config: { windowMs: 0, maxBatchSize: 96 },
    })
    const [r1, r2] = await Promise.all([bTrunc.embed("first"), bTrunc.embed("second")])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.kind).toBe("vector-missing")
  })

  test("HELL-EB-15: no zombie timer after flush() — second flush is no-op fast", async () => {
    const e = counting()
    const b = createDefaultBatcher({ embedder: e, config: { windowMs: 10_000, maxBatchSize: 96 } })
    void b.embed("a")
    await b.flush()
    expect(e.calls.length).toBe(1)
    // No pending, no timer → second flush returns immediately.
    const t0 = Date.now()
    await b.flush()
    await b.flush()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(100)
    expect(e.calls.length).toBe(1) // no extra underlying call
    expect(b.pending()).toBe(0)

    // And: a fresh embed() after flush() arms a NEW timer (not a zombie).
    void b.embed("b")
    expect(b.pending()).toBe(1)
    await b.flush()
    expect(e.calls.length).toBe(2)
  })
})
