/**
 * HELLGATE — the retry path's DELIBERATE behaviours, pinned by their
 * OBSERVABLES.
 *
 * Both defects this file fences are the same shape: a behaviour was introduced
 * on purpose, nothing pinned it, and the next edit removed it (or could).
 *
 * ── V: a retry must be operator-VISIBLE ─────────────────────────────────────
 * MEASURED on `dd9b6cf9e^`, `post` warned on every non-2xx:
 *   `if (!res.ok) { safeWarn(\`POST ${path} → HTTP ${res.status}\`); ... }`
 * The retry-classification fix replaced that with a silent `{kind:"retry"}`,
 * and `onRetry` does not warn either — so 408/429/5xx now produce ZERO log
 * output. A collector 503ing for an hour is invisible until the buffer-cap
 * warn fires, and the comment on the interval callback still claims "failures
 * are logged via safeWarn inside `post`".
 *
 *   V-1  A 503 produces operator-visible output naming the status, the batch
 *        size and a running total (the same discipline the drop path already
 *        keeps). This arm FAILS if the warn is removed.
 *   V-2  PAIRED CONTROL — visible is not a firehose. Sustained failure over
 *        many flushes logs ONCE per consecutive-failure streak, not once per
 *        attempt; a fix of "warn on every retry" fails here.
 *   V-3  PAIRED CONTROL — ...and the latch RE-ARMS. A fix of "warn once, ever"
 *        (which would make a second, later outage invisible — exactly the bug)
 *        fails here.
 *   V-4  The transport-throw path is covered by the SAME line — one discipline,
 *        not two. (It used to warn per-attempt, an unlatched firehose.)
 *
 * ── F: `force` bypasses the backoff gate ────────────────────────────────────
 * SURVIVING MUTANT, measured on the shipping code: changing
 * `if (!force && now() < gate.notBeforeMs)` to `if (now() < gate.notBeforeMs)`
 * left all four otel hellgates green (49 pass / 0 fail). `force` exists because
 * "a skipped attempt at exit is loss, not deferral": two consecutive 503s arm a
 * 5s gate, and a `teardown()` inside that window silently discards the buffer.
 *
 *   F-1  teardown inside an ARMED backoff window still ATTEMPTS the POST —
 *        for BOTH streams (a fix that only forced spans fails here).
 *   F-2  PAIRED CONTROL — a NON-forced flush in the same window is still
 *        SKIPPED, so the fix cannot be "ignore the gate entirely".
 *
 * ── I / D: the neighbours with the same shape ───────────────────────────────
 *   I-1  The two gates are documented as INDEPENDENT ("a wedged metrics
 *        pipeline must not stall traces") and nothing pinned it.
 *   D-1  The drop counter's RUNNING TOTAL accumulates across drops; R-2 only
 *        proved a drop line exists at all.
 *   C-1  Single-flight: "at most one in-flight POST per stream". Also MEASURED
 *        unpinned (deleting the `inFlight` short-circuit: 333 pass / 0 fail).
 *
 * Every arm asserts an OBSERVABLE (a warn line reached the sink / a POST
 * reached `fetch`), never an internal flag — a refactor that keeps the
 * behaviour keeps passing.
 */

import { describe, expect, test } from "bun:test"
import type { ExportMetric, ExportSpan } from "@/observability/otel-exporter"
import { otelHttpExporter } from "@/observability/otel-exporter"

const span = (name: string): ExportSpan => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  name,
  startTimeEpochMs: 1_756_000_000_000,
  endTimeEpochMs: 1_756_000_000_001,
})

const metric = (name: string): ExportMetric => ({
  name,
  kind: "counter",
  value: 1,
  timeEpochMs: 1_756_000_000_000,
})

interface Harness {
  readonly posts: Array<{ readonly path: string; readonly body: string }>
  readonly warns: string[]
  readonly spanPosts: () => number
  readonly metricPosts: () => number
  readonly retryWarns: () => string[]
  readonly flush: () => Promise<void>
  readonly teardown: () => Promise<void>
  readonly recordSpan: (name: string) => void
  readonly recordMetric: (name: string) => void
  readonly advance: (ms: number) => void
}

/** `respond` is keyed on the OTLP path so a test can wedge one stream and
 *  leave the other healthy. Throwing simulates a transport failure. */
const harness = (respond: (path: string, attempt: number) => Response): Harness => {
  const posts: Array<{ path: string; body: string }> = []
  const warns: string[] = []
  let clock = 1_000_000
  const exporter = otelHttpExporter({
    endpoint: "http://collector.invalid",
    flushIntervalMs: 0, // no timer — the test drives every flush
    batchSize: 1_000_000, // never auto-flush on size
    now: () => clock,
    warn: (m) => warns.push(m),
    fetch: (async (url: string, init: { body: string }) => {
      const path = new URL(String(url)).pathname
      posts.push({ path, body: init.body })
      return respond(path, posts.filter((p) => p.path === path).length)
    }) as unknown as typeof fetch,
  })
  const count = (path: string): number => posts.filter((p) => p.path === path).length
  return {
    posts,
    warns,
    spanPosts: () => count("/v1/traces"),
    metricPosts: () => count("/v1/metrics"),
    retryWarns: () => warns.filter((w) => w.includes("retry")),
    flush: () => exporter.flush(),
    teardown: () => exporter.teardown(),
    recordSpan: (name) => exporter.recordSpan(span(name)),
    recordMetric: (name) => exporter.recordMetric(metric(name)),
    advance: (ms) => {
      clock += ms
    },
  }
}

const res = (status: number): Response => new Response("{}", { status })

describe("V — a retry is operator-visible", () => {
  test("V-1 a 503 produces a warn naming the status, the batch size and a running total", async () => {
    const h = harness(() => res(503))
    h.recordSpan("s1")
    h.recordSpan("s2")
    await h.flush()

    // The observable: something reached the warn sink at all. This is the
    // assertion that fails if the `safeWarn` on the retry path is removed
    // again — the exact regression `dd9b6cf9e` introduced.
    expect(h.retryWarns().length).toBeGreaterThan(0)
    const line = h.retryWarns()[0] ?? ""
    expect(line).toContain("503") // WHICH failure
    expect(line).toContain("/v1/traces") // WHICH stream
    expect(line).toContain("2 span(s)") // HOW MUCH is held
    expect(line).toContain("2 retried total") // the running total
  })

  test("V-2 PAIRED CONTROL — sustained failure logs ONCE per streak, not once per attempt", async () => {
    const h = harness(() => res(503))
    h.recordSpan("s1")
    // 20 flushes, each far past any backoff so EVERY one really POSTs. A warn
    // on each attempt would be 20 lines — that just relocates the DoS to the
    // logger, which is why `post` was made silent in the first place.
    for (let i = 0; i < 20; i++) {
      h.advance(60_000)
      await h.flush()
    }
    expect(h.spanPosts()).toBe(20) // the attempts really happened
    expect(h.retryWarns().length).toBe(1) // ...and they were logged once
  })

  test("V-3 PAIRED CONTROL — the latch RE-ARMS, so a LATER outage is visible too", async () => {
    // "Warn once ever" would pass V-1 and V-2 and still hide the hour-long
    // outage that starts after the first blip recovers.
    let healthy = false
    const h = harness(() => (healthy ? res(200) : res(503)))
    h.recordSpan("s1")
    await h.flush() // outage #1 → 1 line
    expect(h.retryWarns().length).toBe(1)

    healthy = true
    h.advance(60_000)
    await h.flush() // recovered — clears the latch
    expect(h.retryWarns().length).toBe(1)

    healthy = false
    h.recordSpan("s2")
    h.advance(60_000)
    await h.flush() // outage #2 → a SECOND line
    expect(h.retryWarns().length).toBe(2)
  })

  test("V-4 a transport throw is logged by the same latched line, not a per-attempt firehose", async () => {
    const posts: string[] = []
    const warns: string[] = []
    let clock = 0
    const exporter = otelHttpExporter({
      endpoint: "http://collector.invalid",
      flushIntervalMs: 0,
      batchSize: 1_000_000,
      now: () => clock,
      warn: (m) => warns.push(m),
      fetch: (async (_u: string, init: { body: string }) => {
        posts.push(init.body)
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    exporter.recordSpan(span("s1"))
    for (let i = 0; i < 10; i++) {
      clock += 60_000
      await exporter.flush()
    }
    expect(posts.length).toBe(10)
    const retryLines = warns.filter((w) => w.includes("retry"))
    expect(retryLines.length).toBe(1)
    expect(retryLines[0] ?? "").toContain("ECONNREFUSED")
  })
})

describe("F — `force` bypasses the backoff gate (teardown's last chance)", () => {
  /** Drive both streams into an ARMED backoff window: two consecutive 503s
   *  leave `attempts = 2`, and `backoffMs(2)` is the 5s initial delay, so the
   *  gate is shut for the next 5s of the fake clock. */
  const wedge = async (h: Harness): Promise<void> => {
    h.recordSpan("s1")
    h.recordMetric("m1")
    await h.flush() // attempt 1 — IMMEDIATE_RETRIES = 1, gate stays open
    await h.flush() // attempt 2 — backoff armed
    expect(h.spanPosts()).toBe(2)
    expect(h.metricPosts()).toBe(2)
    // Proof the gate really is shut: another flush right now is a no-op.
    await h.flush()
    expect(h.spanPosts()).toBe(2)
    expect(h.metricPosts()).toBe(2)
  }

  test("F-1 teardown INSIDE an armed backoff window still attempts the POST — both streams", async () => {
    const h = harness(() => res(503))
    await wedge(h)

    // No clock movement: we are still inside the 5s window. At exit there is no
    // "next tick" to defer to, so a skipped attempt is permanent loss.
    await h.teardown()

    expect({ spans: h.spanPosts(), metrics: h.metricPosts() }).toEqual({ spans: 3, metrics: 3 })
    // ...and it carried the real records, not an empty envelope.
    const last = h.posts.filter((p) => p.path === "/v1/traces").at(-1)
    expect(last?.body ?? "").toContain("s1")
  })

  test("F-2 PAIRED CONTROL — a NON-forced flush in the SAME window is still skipped", async () => {
    const h = harness(() => res(503))
    await wedge(h)

    // Identical state to F-1, identical clock — the ONLY difference is that
    // this caller is not `teardown`. If the fix were "ignore the gate", this
    // would POST and the backoff would be gone.
    for (let i = 0; i < 5; i++) await h.flush()
    expect({ spans: h.spanPosts(), metrics: h.metricPosts() }).toEqual({ spans: 2, metrics: 2 })

    // ...and the gate is a DELAY, not a wedge: past the window it flows again.
    h.advance(60_000)
    await h.flush()
    expect({ spans: h.spanPosts(), metrics: h.metricPosts() }).toEqual({ spans: 3, metrics: 3 })
  })
})

describe("I — the two backoff gates are independent", () => {
  test("I-1 a wedged METRICS pipeline does not stall TRACES", async () => {
    // The gate is documented per-stream ("a wedged metrics pipeline must not
    // stall traces"). A single shared gate — the obvious simplification a later
    // edit reaches for — would make one bad collector route silence both.
    const h = harness((path) => (path === "/v1/metrics" ? res(503) : res(200)))
    for (let i = 0; i < 6; i++) {
      h.recordSpan(`s${i}`)
      h.recordMetric(`m${i}`)
      await h.flush() // NO clock movement: the metric gate stays shut throughout
    }
    // Traces: never gated, one POST per flush.
    expect(h.spanPosts()).toBe(6)
    // PAIRED CONTROL — the metric stream really IS gated (otherwise "no gate at
    // all" would pass the line above). 1 initial + 1 immediate retry, then shut.
    expect(h.metricPosts()).toBe(2)
  })
})

describe("D — the drop counter's running total", () => {
  test("D-1 the total ACCUMULATES across drops rather than restating the batch size", async () => {
    const h = harness(() => res(400))
    h.recordSpan("s1")
    await h.flush()
    h.recordSpan("s2")
    h.recordSpan("s3")
    await h.flush()
    const drops = h.warns.filter((w) => w.includes("dropping"))
    expect(drops.length).toBe(2)
    expect(drops[0] ?? "").toContain("1 dropped total")
    // 1 + 2 = 3. A counter that was assigned rather than incremented, or reset
    // per batch, would say "2 dropped total" here and still pass R-1/R-2.
    expect(drops[1] ?? "").toContain("3 dropped total")
  })
})

describe("C — at most one in-flight POST per stream", () => {
  test("C-1 a flush that collides with an in-flight one does NOT open a second concurrent POST", async () => {
    // The documented invariant: a fire-and-forget batch-size flush and an
    // awaited explicit flush can collide; the second caller awaits the SAME
    // promise, and records that arrived meanwhile ride the NEXT flush.
    const bodies: string[] = []
    let release: (() => void) | undefined
    const held = new Promise<void>((r) => {
      release = r
    })
    const exporter = otelHttpExporter({
      endpoint: "http://collector.invalid",
      flushIntervalMs: 0,
      batchSize: 1_000_000,
      fetch: (async (_u: string, init: { body: string }) => {
        bodies.push(init.body)
        await held
        return res(200)
      }) as unknown as typeof fetch,
    })

    exporter.recordSpan(span("s1"))
    const first = exporter.flush() // blocks inside fetch
    exporter.recordSpan(span("s2")) // arrives DURING the in-flight POST
    const second = exporter.flush() // collides
    release?.()
    await Promise.all([first, second])

    // Two concurrent POSTs would be 2 here.
    expect(bodies.length).toBe(1)
    expect([bodies[0]?.includes("s1"), bodies[0]?.includes("s2")]).toEqual([true, false])
    // PAIRED CONTROL — the newcomer was DEFERRED, not lost.
    await exporter.flush()
    expect(bodies.length).toBe(2)
    expect(bodies[1] ?? "").toContain("s2")
  })
})
