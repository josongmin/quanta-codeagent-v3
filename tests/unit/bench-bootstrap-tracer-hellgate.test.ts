/**
 * jun-27 #4 — bootstrap-phase OTEL visibility.
 *
 * A full-remote box spends ~20min in provisionBox (launch → cloud-init → rsync →
 * bun install → phantom deps → swebench/uvx warm → pyright) BEFORE the agent loop
 * starts emitting OTEL spans. To the operator's trace UI that window is dead air —
 * a slow bootstrap and a DEAD bootstrap look identical (the jun-25/jun-27 "box up
 * but nothing happening" confusion). The bootstrap tracer emits one OTLP span per
 * phase to the SAME sink the agent loop feeds, so the operator sees the bootstrap
 * waterfall live — and, critically, an ERROR span (with the message) at the phase
 * that FAILS, instead of silence.
 *
 * TEETH (red-on-injection):
 *  - each phase emits exactly one span, all under ONE traceId, name bootstrap.<n>,
 *    status ok, with a real duration (parsed back through the sink's OWN parser so
 *    the emitted shape is provably what the receiver consumes);
 *  - a FAILING phase emits status=error + the error MESSAGE and then RETHROWS (the
 *    bootstrap still fails — visibility only, zero behavior change);
 *  - Default-OFF: a non-http endpoint emits NOTHING yet still runs every phase fn
 *    (byte-identical);
 *  - a sink that is DOWN (fetch rejects) never breaks a phase — the fn's result
 *    still returns (an observability path must never fail the bootstrap).
 */
import { describe, expect, test } from "bun:test"
import { errMessage } from "../../src/shared"
import { parseResourceSpans } from "../../src/apps/bench/otel-trace-sink"
import type { BootstrapTracer } from "../../src/apps/bench/remote/bootstrap-tracer"
import { createBootstrapTracer } from "../../src/apps/bench/remote/bootstrap-tracer"
import { createSpawnRecorder, ok, whenArgsInclude, whenCmd, whenSshRemoteIncludes } from "./bench-spawn-testkit"

/** A fake fetch that records every OTLP POST (url + parsed body) and 200s. */
const recordingFetch = () => {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  return { posts, fetchImpl }
}

const ENDPOINT = "http://localhost:4318"

describe("bootstrap tracer — per-phase OTEL spans", () => {
  test("each phase emits one span: same traceId, bootstrap.<name>, ok, real duration", async () => {
    const { posts, fetchImpl } = recordingFetch()
    let clock = 1_000
    const tracer = createBootstrapTracer({
      endpoint: ENDPOINT,
      iid: "i-abc",
      fetch: fetchImpl,
      now: () => clock,
      traceId: "0123456789abcdef0123456789abcdef",
    })

    const r1 = await tracer.phase("launch", async () => {
      clock += 50 // the phase took 50ms
      return "box-id"
    })
    const r2 = await tracer.phase("rsync", async () => {
      clock += 120
      return 42
    })
    await tracer.close()

    expect(r1).toBe("box-id") // phase is transparent — returns fn's value
    expect(r2).toBe(42)

    // Parse the POSTed envelopes through the SINK's own parser (proves the emitted
    // shape is exactly what the live receiver consumes).
    const spans = posts.flatMap((p) => parseResourceSpans(p.body as never))
    const byName = new Map(spans.map((s) => [s.name, s]))
    expect(spans.length).toBe(2)
    expect(byName.get("bootstrap.launch")?.status).toBe("ok")
    expect(byName.get("bootstrap.launch")?.durationMs).toBe(50)
    expect(byName.get("bootstrap.rsync")?.durationMs).toBe(120)
    expect(posts.every((p) => p.url === `${ENDPOINT}/v1/traces`)).toBe(true)

    // All bootstrap phases share ONE trace so the UI groups them into one waterfall.
    const traceIds = new Set(
      posts.flatMap((p) =>
        ((p.body as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ traceId?: string }> }> }> })
          .resourceSpans ?? []
        ).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((s) => s.traceId))),
      ),
    )
    expect(traceIds.size).toBe(1)
    expect([...traceIds][0]).toBe("0123456789abcdef0123456789abcdef")
  })

  test("a FAILING phase emits status=error + message, then rethrows", async () => {
    const { posts, fetchImpl } = recordingFetch()
    let clock = 0
    const tracer = createBootstrapTracer({
      endpoint: ENDPOINT,
      iid: "i-dead",
      fetch: fetchImpl,
      now: () => clock,
    })

    await expect(
      tracer.phase("rsync", async () => {
        clock += 10
        throw new Error("rsync: connection reset by peer")
      }),
    ).rejects.toThrow(/connection reset/) // bootstrap STILL fails — visibility only
    await tracer.close()

    const spans = posts.flatMap((p) => parseResourceSpans(p.body as never))
    const failed = spans.find((s) => s.name === "bootstrap.rsync")
    expect(failed?.status).toBe("error")
    expect(failed?.statusMessage).toContain("connection reset by peer")
  })

  test("Default-OFF: a non-http endpoint emits NOTHING but still runs every phase", async () => {
    const { posts, fetchImpl } = recordingFetch()
    const tracer = createBootstrapTracer({ endpoint: "", fetch: fetchImpl, iid: "i-x" })
    let ran = false
    const r = await tracer.phase("launch", async () => {
      ran = true
      return "ok"
    })
    await tracer.close()
    expect(ran).toBe(true) // the phase fn ALWAYS runs
    expect(r).toBe("ok")
    expect(posts.length).toBe(0) // …but no OTLP traffic when off (byte-identical)
  })

  test("a DOWN sink (fetch rejects) never breaks a phase", async () => {
    const downFetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:4318")
    }) as unknown as typeof fetch
    const tracer = createBootstrapTracer({ endpoint: ENDPOINT, fetch: downFetch, iid: "i-x" })
    const r = await tracer.phase("warm", async () => "phase-result")
    await tracer.close()
    expect(r).toBe("phase-result") // the bootstrap is unaffected by a dead sink
  })
})

/** A tracer that records the (name, status) of every phase + whether it closed —
 *  same control flow as the real one (run fn, ok on return / error+rethrow on
 *  throw) minus the OTLP emission, so it proves what provisionBox wraps. */
const recordingTracer = () => {
  const phases: Array<{ name: string; status: "ok" | "error"; message?: string }> = []
  const state = { closed: false }
  const tracer: BootstrapTracer = {
    phase: async (name, fn) => {
      try {
        const r = await fn()
        phases.push({ name, status: "ok" })
        return r
      } catch (err) {
        phases.push({ name, status: "error", message: errMessage(err) })
        throw err
      }
    },
    close: async () => {
      state.closed = true
    },
  }
  return { phases, state, tracer }
}

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS",
  refresh_token: "REFRESH",
  id_token: "IDTOK",
  account_id: "acct",
  expires_at: "2099-01-01T00:00:00Z",
})

// Drive provisionBox to the cloud-init phase, then make the box NEVER become
// bun-ready so that phase throws (the bootstrap dies there).
const mockSpawnForProvision = () =>
  createSpawnRecorder(
    whenArgsInclude("describe-security-groups", ok("sg-abc")),
    whenArgsInclude("run-instances", ok("i-box0")),
    whenArgsInclude("wait", ok("")),
    whenArgsInclude("describe-instances", ok("1.2.3.4")),
    whenArgsInclude("terminate-instances", ok("")),
    whenCmd("curl", ok("203.0.113.7\n")),
    whenSshRemoteIncludes("cloud-init", ok("")), // never reports ready
  )

describe("provisionBox ↔ bootstrap tracer wiring", () => {
  test("each bootstrap phase is wrapped; a failing phase records error + the tracer closes", async () => {
    const { provisionBox } = await import("../../src/apps/bench/remote/box-session")
    const { fn } = mockSpawnForProvision()
    const { phases, state, tracer } = recordingTracer()

    await provisionBox({
      repoDir: "/tmp/repo",
      authJson: FULL_AUTH,
      datasetPath: "/tmp/unused.jsonl",
      spawn: fn,
      sleep: async () => {},
      maxReadyPolls: 1,
      otelEndpoint: "http://localhost:4318",
      makeBootstrapTracer: () => tracer, // inject the recorder over createBootstrapTracer
    }).catch(() => undefined) // expected: cloud-init never readies ⇒ provisionBox throws

    const byName = new Map(phases.map((p) => [p.name, p]))
    // The fast pre-bootstrap wait is wrapped + ok…
    expect(byName.get("wait-running")?.status).toBe("ok")
    // …and the phase that DIED is recorded as error (so the trace UI shows WHERE),
    // not swallowed into silence.
    expect(byName.get("cloud-init")?.status).toBe("error")
    // bootstrap proper never ran (cloud-init threw first) — no false "ok".
    expect(byName.has("bootstrap")).toBe(false)
    // The tracer is always closed (finally), even on the failure path.
    expect(state.closed).toBe(true)
  })

  test("Default-OFF: no otelEndpoint ⇒ provisionBox still runs (real no-op tracer, no throw added)", async () => {
    const { provisionBox } = await import("../../src/apps/bench/remote/box-session")
    const { fn } = mockSpawnForProvision()
    // No makeBootstrapTracer + no otelEndpoint ⇒ the real createBootstrapTracer
    // returns its NOOP; provisionBox behaves exactly as before (still throws at the
    // never-ready cloud-init, NOT because of the tracer).
    await expect(
      provisionBox({
        repoDir: "/tmp/repo",
        authJson: FULL_AUTH,
        datasetPath: "/tmp/unused.jsonl",
        spawn: fn,
        sleep: async () => {},
        maxReadyPolls: 1,
      }),
    ).rejects.toThrow()
  })
})
