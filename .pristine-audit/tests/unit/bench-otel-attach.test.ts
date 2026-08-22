/**
 * jun-26 bench OTLP live-trace attach seam (ADR-0268).
 *
 * The bench entry binaries (apps/bench/cli.ts — the box + primary local entry —
 * and apps/bench/index.ts — legacy direct-invoke) must register the OTLP span
 * exporter as the process-global span sink so the agent loop's existing span emit
 * sites STREAM to the operator's collector. `attachBenchOtelExport(env)` is the
 * single tested seam both entries call.
 *
 * Asserts:
 *   - ON  : env has QUANTA_OTEL_ENDPOINT ⇒ a sink is registered AND a loop span
 *           flushed through it POSTs to <endpoint>/v1/traces (the emit sites go
 *           live). Service name from QUANTA_OTEL_SERVICE_NAME rides the resource.
 *   - OFF : env unset ⇒ NO sink registered (byte-identical Default-OFF) and NO
 *           POST ever happens — the loop is unchanged.
 *
 * Injected env + fake fetch/clock/no-timer make the seam deterministic (no real
 * network, no real timers).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { attachBenchOtelExport, bootBenchOtelExport, resolveBenchRunId } from "@/apps/bench/otel"
import { parseResourceSpansFull } from "@/apps/bench/otel-trace-sink"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import { __resetSpanSink, endSpan, getSpanSink, SPAN_NAMES, startSpan } from "@/observability/spans"

const ENDPOINT = "http://127.0.0.1:4318"

interface Captured {
  readonly url: string
  readonly body: string
}
const makeFakeFetch = (): { fetch: typeof fetch; calls: Captured[] } => {
  const calls: Captured[] = []
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      body: typeof init?.body === "string" ? init.body : "",
    })
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake Response
    return { ok: true, status: 200 } as any
  }
  return { fetch: f as unknown as typeof fetch, calls }
}

// Disable the real flush timer — teardown drives the only flush.
const noTimer = {
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}

const spansOf = (body: string): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = []
  const env = JSON.parse(body) as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: { stringValue?: string } }> }
      scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>
    }>
  }
  for (const rs of env.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.push(s)
  return out
}

const resourceAttrOf = (body: string, key: string): string | undefined => {
  const env = JSON.parse(body) as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: { stringValue?: string } }> }
    }>
  }
  const attrs = env.resourceSpans?.[0]?.resource?.attributes ?? []
  return attrs.find((a) => a.key === key)?.value?.stringValue
}
const serviceNameOf = (body: string): string | undefined => resourceAttrOf(body, "service.name")

afterEach(() => {
  __resetSpanSink()
  __resetDefaultMetricSink()
})

describe("bench OTEL attach seam (attachBenchOtelExport)", () => {
  test("ON: endpoint set ⇒ sink registered + loop span POSTs to /v1/traces with service name", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = attachBenchOtelExport(
      {
        QUANTA_OTEL_ENDPOINT: ENDPOINT,
        QUANTA_OTEL_SERVICE_NAME: "quanta-bench-box",
      },
      { fetch, flushIntervalMs: 0, ...noTimer },
    )
    // The emit sites are now live — previously the sink was null (no-op).
    expect(getSpanSink()).not.toBeNull()
    expect(installed.exporter).not.toBeNull()

    // Drive a real loop emit site (same call the agent loop makes).
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()

    const traceCalls = calls.filter((c) => c.url === `${ENDPOINT}/v1/traces`)
    expect(traceCalls.length).toBeGreaterThanOrEqual(1)
    const allSpans = traceCalls.flatMap((c) => spansOf(c.body))
    expect(allSpans.length).toBe(1)
    expect(allSpans[0]?.name).toBe(SPAN_NAMES.sessionLoop)
    expect(serviceNameOf(traceCalls[0]?.body ?? "{}")).toBe("quanta-bench-box")
    // teardown restores the prior (null) sink — no leak across the process.
    expect(getSpanSink()).toBeNull()
  })

  // jun-27 run-id deep-link: QUANTA_OTEL_RUN_ID stamps `quanta.run.id` on the
  // span RESOURCE so the trace-viewer can filter ONE run out of a mixed sink
  // (`?run=<id>`). End-to-end: the real exporter ships it on the wire AND the
  // sink's parser folds it onto each span's attrs (where the viewer reads it).
  test("RUN ID: QUANTA_OTEL_RUN_ID ⇒ resource carries quanta.run.id AND sink folds it onto span attrs", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = attachBenchOtelExport(
      {
        QUANTA_OTEL_ENDPOINT: ENDPOINT,
        QUANTA_OTEL_SERVICE_NAME: "quanta-bench-box",
        QUANTA_OTEL_RUN_ID: "ab-closure-repair-A2",
      },
      { fetch, flushIntervalMs: 0, ...noTimer },
    )
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()

    const body = calls.find((c) => c.url === `${ENDPOINT}/v1/traces`)?.body ?? "{}"
    // 1) on the wire: resource attribute (alongside service.name, not replacing it)
    expect(resourceAttrOf(body, "quanta.run.id")).toBe("ab-closure-repair-A2")
    expect(serviceNameOf(body)).toBe("quanta-bench-box")
    // 2) the sink (what /spans.json serves) folds the resource run id onto EVERY
    //    span's attrs — the viewer's `?run=` filter is attribute-driven.
    const full = parseResourceSpansFull(JSON.parse(body))
    expect(full.length).toBe(1)
    expect(full[0]?.attrs["quanta.run.id"]).toBe("ab-closure-repair-A2")
  })

  test("RUN ID unset/blank ⇒ NO quanta.run.id attribute (byte-identical to today)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = attachBenchOtelExport(
      { QUANTA_OTEL_ENDPOINT: ENDPOINT, QUANTA_OTEL_RUN_ID: "   " },
      { fetch, flushIntervalMs: 0, ...noTimer },
    )
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()

    const body = calls.find((c) => c.url === `${ENDPOINT}/v1/traces`)?.body ?? "{}"
    expect(resourceAttrOf(body, "quanta.run.id")).toBeUndefined()
    expect(parseResourceSpansFull(JSON.parse(body))[0]?.attrs["quanta.run.id"]).toBeUndefined()
  })

  test("OFF: endpoint unset ⇒ no sink, no POST (byte-identical Default-OFF)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const before = getSpanSink()
    const installed = attachBenchOtelExport({}, { fetch })
    expect(installed.exporter).toBeNull()
    // Sink unchanged — still whatever it was (null in a fresh process).
    expect(getSpanSink()).toBe(before)

    // Loop emit sites stay no-op — nothing ships.
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()
    expect(calls.length).toBe(0)
  })

  test("OFF: blank/whitespace endpoint is treated as unset (no silent localhost)", () => {
    const { fetch } = makeFakeFetch()
    const installed = attachBenchOtelExport({ QUANTA_OTEL_ENDPOINT: "  \t " }, { fetch })
    expect(installed.exporter).toBeNull()
    expect(getSpanSink()).toBeNull()
  })
})

// jun-27: a forgotten QUANTA_OTEL_RUN_ID was THE hole — runs streamed with no run
// id and the `?run=` deep-link showed nothing. resolveBenchRunId auto-issues one
// when export is on, so every run is linkable with zero manual steps.
describe("bench run-id auto-issue (resolveBenchRunId)", () => {
  // inject both clock + entropy: rand=0 ⇒ entropy "000" (deterministic suffix)
  const at = (ms: number, r = 0) => ({ now: () => ms, rand: () => r })

  test("explicit QUANTA_OTEL_RUN_ID wins (trimmed) regardless of endpoint", () => {
    expect(
      resolveBenchRunId({ QUANTA_OTEL_ENDPOINT: "http://x:4318", QUANTA_OTEL_RUN_ID: "  arm-A2 " }),
    ).toBe("arm-A2")
    // explicit wins even with no endpoint (operator pre-labels a run)
    expect(resolveBenchRunId({ QUANTA_OTEL_RUN_ID: "arm-A2" })).toBe("arm-A2")
  })

  test("OFF: no endpoint ⇒ undefined (no env mutation, byte-identical Default-OFF)", () => {
    expect(resolveBenchRunId({})).toBeUndefined()
    expect(resolveBenchRunId({ QUANTA_BENCH_PRESET: "agentless-v6" })).toBeUndefined()
    // blank endpoint is unset too
    expect(
      resolveBenchRunId({ QUANTA_OTEL_ENDPOINT: "   ", QUANTA_BENCH_PRESET: "p" }),
    ).toBeUndefined()
  })

  test("AUTO: endpoint on + no run id ⇒ <preset-slug>-<base36 time><entropy>, deterministic under injected clock+rand", () => {
    const id = resolveBenchRunId(
      {
        QUANTA_OTEL_ENDPOINT: "http://127.0.0.1:4318",
        QUANTA_BENCH_PRESET: "agentless-v6-closure-repair",
      },
      at(0x1234567),
    )
    expect(id).toBe(`agentless-v6-closure-repair-${(0x1234567).toString(36).slice(-6)}000`)
  })

  test("AUTO: same ms + DIFFERENT entropy ⇒ different ids (parallel same-preset boxes don't merge)", () => {
    const env = { QUANTA_OTEL_ENDPOINT: "http://x:4318", QUANTA_BENCH_PRESET: "armA" }
    const a = resolveBenchRunId(env, at(777, 0.1))
    const b = resolveBenchRunId(env, at(777, 0.9))
    expect(a).not.toBe(b) // identical ms, the entropy disambiguates
  })

  test("AUTO: blank explicit run id falls through to auto-issue (not treated as a label)", () => {
    const id = resolveBenchRunId(
      { QUANTA_OTEL_ENDPOINT: "http://x:4318", QUANTA_OTEL_RUN_ID: "   ", QUANTA_BENCH_SOTA: "v6" },
      at(100),
    )
    expect(id).toBe(`v6-${(100).toString(36)}000`)
  })

  test("AUTO: a label with unsafe chars is slugified (URL/shell-safe id)", () => {
    const id = resolveBenchRunId(
      { QUANTA_OTEL_ENDPOINT: "http://x:4318", QUANTA_OTEL_SERVICE_NAME: "box A/B & co" },
      at(1),
    )
    // spaces/slashes/ampersands → '-', trimmed, no trailing dash before the suffix
    expect(id).toMatch(/^box-A-B-co-[0-9a-z]+$/)
    expect(id).not.toMatch(/[^A-Za-z0-9._-]/)
  })

  test("AUTO: bare endpoint, no preset/service ⇒ 'bench-<suffix>' (never empty slug)", () => {
    expect(resolveBenchRunId({ QUANTA_OTEL_ENDPOINT: "http://x:4318" }, at(0))).toBe("bench-0000")
  })

  test("AUTO: two different presets ⇒ different ids (arms never collapse)", () => {
    const a = resolveBenchRunId(
      { QUANTA_OTEL_ENDPOINT: "http://x", QUANTA_BENCH_PRESET: "armA" },
      at(5),
    )
    const b = resolveBenchRunId(
      { QUANTA_OTEL_ENDPOINT: "http://x", QUANTA_BENCH_PRESET: "armB" },
      at(5),
    )
    expect(a).not.toBe(b)
  })
})

// The shared boot seam BOTH entry binaries (cli.ts + legacy index.ts) call — so
// they auto-issue + attach identically (the legacy entry used to attach WITHOUT
// auto-issuing → direct-invoke runs had no run id and a dead `?run=` link).
describe("bench boot seam (bootBenchOtelExport)", () => {
  const noTimerBoot = { flushIntervalMs: 0, ...noTimer }

  test("ON: writes the auto-issued run id BACK onto env (so it forwards to boxes) + builds the deep-link", () => {
    const { fetch } = makeFakeFetch()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: "http://127.0.0.1:4319",
      QUANTA_BENCH_PRESET: "agentless-v6-closure-repair",
    }
    const boot = bootBenchOtelExport(env, { fetch, ...noTimerBoot })
    expect(boot.runId).toBeDefined()
    // mutated in place — buildForwardedBenchEnv(process.env) at box-launch sees it
    expect(env.QUANTA_OTEL_RUN_ID).toBe(boot.runId)
    expect(boot.runId?.startsWith("agentless-v6-closure-repair-")).toBe(true)
    // link points at the endpoint's port (4319), deep-linked to this run
    expect(boot.traceLink).toBe(
      `http://127.0.0.1:4319/?run=${encodeURIComponent(boot.runId as string)}`,
    )
    expect(boot.otelExport.exporter).not.toBeNull()
    void boot.otelExport.teardown()
    __resetSpanSink()
  })

  test("EXPLICIT run id is preserved (not overwritten) and used in the link", () => {
    const { fetch } = makeFakeFetch()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: "http://127.0.0.1:4318",
      QUANTA_OTEL_RUN_ID: "armA",
    }
    const boot = bootBenchOtelExport(env, { fetch, ...noTimerBoot })
    expect(boot.runId).toBe("armA")
    expect(env.QUANTA_OTEL_RUN_ID).toBe("armA")
    expect(boot.traceLink).toBe("http://127.0.0.1:4318/?run=armA")
    void boot.otelExport.teardown()
    __resetSpanSink()
  })

  test("OFF: no endpoint ⇒ no exporter, no link, env untouched (byte-identical Default-OFF)", () => {
    const env: Record<string, string | undefined> = { QUANTA_BENCH_PRESET: "p" }
    const boot = bootBenchOtelExport(env)
    expect(boot.otelExport.exporter).toBeNull()
    expect(boot.runId).toBeUndefined()
    expect(boot.traceLink).toBeUndefined()
    expect(env.QUANTA_OTEL_RUN_ID).toBeUndefined() // NOT mutated
  })
})
