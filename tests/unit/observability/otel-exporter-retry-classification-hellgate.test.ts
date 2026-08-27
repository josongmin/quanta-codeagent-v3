/**
 * HELLGATE — a permanently-rejected batch must not be retried forever.
 *
 * MEASURED on the shipping exporter: `post` collapses EVERY non-2xx into
 * `false`, and `flushSpans` treats `false` as "keep it" — it `unshift`s the
 * unsent snapshot back at the FRONT of the buffer. Nothing distinguishes
 * "the collector is down, try again" from "the collector rejected these bytes
 * and always will".
 *
 * Consequences, all reachable with a misconfigured endpoint (a 404 path, a 401
 * from a rotated token, a 400 from a schema-strict collector):
 *   - the batch is re-POSTed on every flush, forever;
 *   - the buffer CAP cannot drain it — `boundedPush` only evicts when NEW
 *     records arrive, and it evicts from the front, so a wedged batch that is
 *     re-unshifted keeps re-taking the front;
 *   - every later span/metric queues behind bytes that can never land.
 * Previously measured shape: cap 3, 50 flushes → 50 POSTs.
 *
 * Fence:
 *   R-1  A 4xx (permanent) batch is DROPPED after one attempt.
 *   R-2  The drop is COUNTED and LOGGED — never silent.
 *   R-3  PAIRED CONTROL — a 5xx batch is RETRIED, not dropped. This is the arm
 *        that fails if the fix is "drop on any failure", which would turn a
 *        collector restart into permanent data loss.
 *   R-4  PAIRED CONTROL — a network throw is retried (the collector-is-down
 *        case is indistinguishable from a transient blip).
 *   R-5  408 / 429 are retried DESPITE being 4xx.
 *   R-6  Retry is BACKED OFF — repeated immediate flushes do not hammer.
 *   R-7  PAIRED CONTROL — a 2xx batch is cleared and never re-sent.
 *   R-8  A batch that cannot even be SERIALIZED is dropped, not re-queued
 *        forever (same blackhole, one layer up).
 */

import { describe, expect, test } from "bun:test"
import {
  classifyPostStatus,
  type ExportSpan,
  otelHttpExporter,
} from "@/observability/otel-exporter"

interface Harness {
  readonly posts: Array<{ url: string; body: string }>
  readonly warns: string[]
  readonly flush: () => Promise<void>
  readonly record: (name: string) => void
  readonly advance: (ms: number) => void
}

const span = (name: string): ExportSpan => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  name,
  startTimeEpochMs: 1_756_000_000_000,
  endTimeEpochMs: 1_756_000_000_001,
  attributes: {},
})

/** `respond` returns a Response, or throws to simulate a network failure. */
const harness = (respond: (attempt: number) => Response): Harness => {
  const posts: Array<{ url: string; body: string }> = []
  const warns: string[] = []
  let clock = 1_000_000
  const exporter = otelHttpExporter({
    endpoint: "http://collector.invalid",
    flushIntervalMs: 0, // no timer — the test drives every flush
    batchSize: 1_000_000, // never auto-flush on size
    maxBufferSize: 3,
    now: () => clock,
    warn: (m) => warns.push(m),
    fetch: (async (url: string, init: { body: string }) => {
      posts.push({ url: String(url), body: init.body })
      return respond(posts.length)
    }) as unknown as typeof fetch,
  })
  return {
    posts,
    warns,
    flush: () => exporter.flush(),
    record: (name) => exporter.recordSpan(span(name)),
    advance: (ms) => {
      clock += ms
    },
  }
}

const res = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : "{}", { status, headers })

describe("R — retry classification", () => {
  test("R-1/R-2 a 400 batch is dropped after ONE attempt, and the drop is logged", async () => {
    const h = harness(() => res(400))
    h.record("s1")
    // 50 flushes, exactly as the original measurement.
    for (let i = 0; i < 50; i++) {
      h.advance(60_000) // well past any backoff — this is NOT a backoff test
      await h.flush()
    }
    expect(h.posts.length).toBe(1)
    // R-2: counted + logged, not silent.
    const dropLines = h.warns.filter((w) => w.includes("drop"))
    expect(dropLines.length).toBeGreaterThan(0)
    expect(dropLines.join("\n")).toContain("400")
  })

  test("R-3 PAIRED CONTROL — a 503 batch is RETRIED, with the same records", async () => {
    const h = harness(() => res(503))
    h.record("s1")
    for (let i = 0; i < 5; i++) {
      h.advance(60_000)
      await h.flush()
    }
    expect(h.posts.length).toBeGreaterThan(1)
    // ...and it is the SAME batch each time — the records were not lost.
    for (const p of h.posts) expect(p.body).toContain("s1")
  })

  test("R-4 PAIRED CONTROL — a network throw is retried, not dropped", async () => {
    const posts: string[] = []
    let clock = 0
    const exporter = otelHttpExporter({
      endpoint: "http://collector.invalid",
      flushIntervalMs: 0,
      batchSize: 1_000_000,
      now: () => clock,
      warn: () => {},
      fetch: (async (_u: string, init: { body: string }) => {
        posts.push(init.body)
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    exporter.recordSpan(span("s1"))
    for (let i = 0; i < 5; i++) {
      clock += 60_000
      await exporter.flush()
    }
    expect(posts.length).toBeGreaterThan(1)
  })

  test("R-5 408 and 429 are retried despite being 4xx", async () => {
    for (const status of [408, 429]) {
      const h = harness(() => res(status))
      h.record("s1")
      for (let i = 0; i < 4; i++) {
        h.advance(60_000)
        await h.flush()
      }
      expect({ status, posts: h.posts.length > 1 }).toEqual({ status, posts: true })
    }
  })

  test("R-6 retry is BACKED OFF — immediate re-flushes do not hammer the collector", async () => {
    const h = harness(() => res(503))
    h.record("s1")
    // 20 flushes with NO clock movement. `IMMEDIATE_RETRIES = 1` means the
    // FIRST retry is deliberately un-delayed (a collector mid-restart should
    // not cost 5s), so the expected count is exactly 2: the initial attempt
    // plus one immediate retry, then the gate closes. 20 → 2, not 20 → 20.
    for (let i = 0; i < 20; i++) await h.flush()
    expect(h.posts.length).toBe(2)
    // ...and once the backoff elapses, it DOES retry (not wedged shut).
    h.advance(60_000)
    await h.flush()
    expect(h.posts.length).toBe(3)
  })

  test("R-7 PAIRED CONTROL — a 2xx batch is cleared and never re-sent", async () => {
    const h = harness(() => res(200))
    h.record("s1")
    await h.flush()
    await h.flush()
    await h.flush()
    expect(h.posts.length).toBe(1)
    expect(h.warns).toEqual([])
  })

  test("R-8 an unserializable batch is dropped, not re-queued forever", async () => {
    const posts: string[] = []
    const warns: string[] = []
    const exporter = otelHttpExporter({
      endpoint: "http://collector.invalid",
      flushIntervalMs: 0,
      batchSize: 1_000_000,
      warn: (m) => warns.push(m),
      fetch: (async (_u: string, init: { body: string }) => {
        posts.push(init.body)
        return res(200)
      }) as unknown as typeof fetch,
    })
    // A BigInt on the envelope makes JSON.stringify throw — the same permanent
    // failure class as a 400, one layer up. It has to be a field the serializer
    // copies VERBATIM (`traceId`): `otlpAttributes` filters unknown attribute
    // types out, so a bigint ATTRIBUTE serializes fine and would test nothing.
    const unserializable = { ...span("s1"), traceId: 1n } as unknown as ExportSpan
    exporter.recordSpan(unserializable)
    for (let i = 0; i < 10; i++) await exporter.flush()
    expect(posts.length).toBe(0)
    expect(warns.filter((w) => w.includes("drop")).length).toBeGreaterThan(0)
  })
})

/**
 * R-9 — the classifier itself, as a table.
 *
 * The end-to-end arms above prove the WIRING (a 400 batch really is discarded
 * by the real flush path). This block pins the POLICY at every boundary, so a
 * later edit that moves the 5xx line or forgets 429 is caught by name rather
 * than by whichever status a harness happened to use.
 */
describe("R-9 classifyPostStatus — the boundaries", () => {
  const CASES: ReadonlyArray<readonly [number, "retry" | "drop"]> = [
    [100, "drop"], // 1xx — not a state a resend progresses from
    [301, "drop"], // fetch follows real redirects; a surfaced 3xx is config
    [304, "drop"],
    [400, "drop"], // malformed payload — identical bytes, identical answer
    [401, "drop"], // bad credentials
    [403, "drop"],
    [404, "drop"], // wrong path
    [408, "retry"], // 4xx by number, transient by meaning
    [413, "drop"],
    [422, "drop"],
    [429, "retry"], // the collector ASKING for backpressure
    [499, "drop"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"], // collector restarting — the bytes are fine
    [504, "retry"],
    [599, "retry"],
  ]

  test("every boundary status classifies as documented", () => {
    const actual = CASES.map(([status]) => [status, classifyPostStatus(status)] as const)
    expect(actual).toEqual(CASES.map(([s, d]) => [s, d] as const))
  })

  test("PAIRED CONTROL — the 4xx band is not classified WHOLESALE either way", () => {
    // A fix that dropped every 4xx, or retried every 4xx, would pass a table
    // built only from 400 and 503. Both halves must be represented.
    const fourXx = CASES.filter(([s]) => s >= 400 && s < 500).map(([, d]) => d)
    expect(new Set(fourXx)).toEqual(new Set(["drop", "retry"]))
  })
})

/**
 * R-10 — `Retry-After` is honoured.
 *
 * 429 is the collector ASKING for a specific backpressure window; ignoring the
 * header and using our own exponential curve would re-POST inside the window it
 * just told us not to. The discriminator is deliberately chosen so the two
 * policies disagree: with `IMMEDIATE_RETRIES = 1` a 429 with NO header retries
 * at once, so a second POST appearing without clock movement is proof the
 * header was ignored.
 */
describe("R-10 Retry-After", () => {
  test("a 429 WITH retry-after gates the immediate retry", async () => {
    const h = harness(() => res(429, { "retry-after": "60" }))
    h.record("s1")
    await h.flush()
    await h.flush()
    expect(h.posts.length).toBe(1)
    // Inside the window the collector named: still gated.
    h.advance(59_000)
    await h.flush()
    expect(h.posts.length).toBe(1)
    // Past it: retried.
    h.advance(2_000)
    await h.flush()
    expect(h.posts.length).toBe(2)
  })

  test("PAIRED CONTROL — the same 429 WITHOUT the header retries immediately", async () => {
    const h = harness(() => res(429))
    h.record("s1")
    await h.flush()
    await h.flush()
    expect(h.posts.length).toBe(2)
  })

  test("PAIRED CONTROL — a malformed retry-after falls back to backoff, not to 0 or NaN", async () => {
    // `NaN` deadlines compare false against everything, which would silently
    // disable the gate — the exact shape the nanos() guard exists for, one
    // module over.
    const h = harness(() => res(503, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }))
    h.record("s1")
    for (let i = 0; i < 10; i++) await h.flush()
    // 1 initial + 1 immediate retry, then the exponential gate closes.
    expect(h.posts.length).toBe(2)
  })
})
