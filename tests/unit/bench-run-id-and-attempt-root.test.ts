/**
 * C5 (jul-12 OTel GenAI unification) — bench IDENTITY + per-attempt ROOT.
 *
 * Two claims this pins:
 *
 *  (1) ONE run-id authority. `bootBenchOtelExport` resolves ONE run id and seeds
 *      BOTH `QUANTA_RUN_ID` (artifact/observe/cassette `ctx.runId`, via
 *      `runtimeConfig().runId`) AND `QUANTA_OTEL_RUN_ID` (the OTLP resource
 *      `quanta.run.id`). Kills the pre-C5 divergence where the boot wire minted
 *      `QUANTA_OTEL_RUN_ID` (`<slug>-<t><ent>`) and `runMain` separately minted
 *      `QUANTA_RUN_ID` (`run-<ts>`) — an OTLP span then could NOT join its
 *      `<runId>/<instanceId>.<attempt>.jsonl` trajectory. Proven for BOTH an
 *      explicit pin and an auto-issued id, and end-to-end onto the real OTLP
 *      resource on the wire.
 *
 *  (2) Per-attempt bench ROOT. `withBenchInstanceRoot` opens a
 *      `quanta.bench.instance` INTERNAL root per instance ATTEMPT, minting a
 *      FRESH trace id each call (Best-of-N attempts never merge) and carrying the
 *      0-based `quanta.instance.attempt`. And `buildConfig`'s `spanIdentity`
 *      threads the SAME 0-based attempt (from `deps.observe.attempt`) onto the
 *      loop span. Gated on a live sink ⇒ OFF is byte-identical (no span, no
 *      active-context frame, no id).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { bootBenchOtelExport, resolveBenchRunId } from "@/apps/bench/otel"
import { withBenchInstanceRoot } from "@/apps/bench/run-main-helpers"
import type { LLMPort } from "@/llm"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"
import {
  __resetSpanSink,
  endSpan,
  getSpanSink,
  SPAN_NAMES,
  type SpanSink,
  setSpanSink,
  startSpan,
} from "@/observability/spans"
import { getActiveTraceRef } from "@/observability/tracing"
import { buildConfig } from "@/runner/batch/eval/driver/config-build"
import type { RunInstanceDeps } from "@/runner/batch/eval/driver/context-types"
import type { Instance } from "@/runner/batch/types"
import type { StreamPort } from "@/stream"

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
const noTimer = {
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}
const bootOpts = { flushIntervalMs: 0, ...noTimer }

const resourceAttrOf = (body: string, key: string): string | undefined => {
  const env = JSON.parse(body) as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: { stringValue?: string } }> }
    }>
  }
  const attrs = env.resourceSpans?.[0]?.resource?.attributes ?? []
  return attrs.find((a) => a.key === key)?.value?.stringValue
}

afterEach(() => {
  __resetSpanSink()
  __resetDefaultMetricSink()
})

// ─────────────────────────────────────────────────────────────────────────────
// (1) ONE run-id authority — explicit + auto both feed observe ctx AND OTLP.
// ─────────────────────────────────────────────────────────────────────────────

describe("C5 run-id unification — one id feeds observe ctx AND OTLP resource", () => {
  test("resolveBenchRunId honors an explicit QUANTA_RUN_ID (artifact pin) — even with no endpoint", () => {
    // The observe/cassette id is authoritative for the whole run; the OTLP id must
    // match it, not a fresh mint.
    expect(resolveBenchRunId({ QUANTA_RUN_ID: "  campaign-A2 " })).toBe("campaign-A2")
    // QUANTA_OTEL_RUN_ID still out-ranks it (an explicit OTLP label wins).
    expect(resolveBenchRunId({ QUANTA_RUN_ID: "artifact-id", QUANTA_OTEL_RUN_ID: "otel-id" })).toBe(
      "otel-id",
    )
  })

  test("EXPLICIT: boot seeds BOTH id keys to the SAME value AND the OTLP resource carries it", () => {
    const { fetch, calls } = makeFakeFetch()
    // Operator pinned ONLY the artifact id (the observe/cassette ctx source).
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_RUN_ID: "campaign-A2",
    }
    const boot = bootBenchOtelExport(env, { fetch, ...bootOpts })
    // observe/cassette id (runtimeConfig().runId ← QUANTA_RUN_ID) == OTLP id.
    expect(env.QUANTA_RUN_ID).toBe("campaign-A2")
    expect(env.QUANTA_OTEL_RUN_ID).toBe("campaign-A2")
    expect(boot.runId).toBe("campaign-A2")

    // End-to-end: the SAME id lands on the OTLP resource on the wire.
    endSpan(startSpan(SPAN_NAMES.sessionLoop, {}), "ok", {})
    return boot.otelExport.teardown().then(() => {
      const body = calls.find((c) => c.url === `${ENDPOINT}/v1/traces`)?.body ?? "{}"
      expect(resourceAttrOf(body, "quanta.run.id")).toBe("campaign-A2")
    })
  })

  test("AUTO: an auto-issued id is written to BOTH keys AND onto the OTLP resource (one value)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_BENCH_PRESET: "agentless-v6",
    }
    const boot = bootBenchOtelExport(env, { fetch, ...bootOpts })
    const auto = boot.runId
    expect(auto).toBeDefined()
    expect(auto?.startsWith("agentless-v6-")).toBe(true)
    // BOTH namespaces carry the auto-issued id (no divergence).
    expect(env.QUANTA_RUN_ID).toBe(auto)
    expect(env.QUANTA_OTEL_RUN_ID).toBe(auto)

    endSpan(startSpan(SPAN_NAMES.sessionLoop, {}), "ok", {})
    await boot.otelExport.teardown()
    const body = calls.find((c) => c.url === `${ENDPOINT}/v1/traces`)?.body ?? "{}"
    // observe ctx id (env.QUANTA_RUN_ID) === OTLP resource id — the join key.
    expect(resourceAttrOf(body, "quanta.run.id")).toBe(env.QUANTA_RUN_ID)
  })

  test("OFF: no endpoint + no explicit id ⇒ NEITHER id seeded (runMain mints run-<ts>; byte-identical)", () => {
    const env: Record<string, string | undefined> = { QUANTA_BENCH_PRESET: "p" }
    const boot = bootBenchOtelExport(env)
    expect(boot.runId).toBeUndefined()
    // Both untouched — the unification never bites when nothing streams.
    expect(env.QUANTA_RUN_ID).toBeUndefined()
    expect(env.QUANTA_OTEL_RUN_ID).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (2) attempt threading — config-build stamps the 0-based observe attempt.
// ─────────────────────────────────────────────────────────────────────────────

const stubLlm: LLMPort = {
  model: "stub",
  // biome-ignore lint/correctness/useYield: a wiring test never streams this stub
  async *stream() {
    throw new Error("stub llm should not be streamed in a wiring test")
  },
}
const nullStream: StreamPort = { emit() {} }
const makeInstance = (): Instance => ({
  id: "c5__attempt-wiring",
  repoPath: process.cwd(),
  problemStatement: "wiring probe: spanIdentity.attempt threads from observe",
  testCmd: "true",
})
const depsWith = (observe?: RunInstanceDeps["observe"]): RunInstanceDeps => ({
  llm: stubLlm,
  maxTurns: 1,
  timeoutMs: 1,
  ...(observe !== undefined ? { observe } : {}),
})

describe("C5 attempt threading — spanIdentity carries the 0-based observe attempt", () => {
  const spanIdentityOf = (deps: RunInstanceDeps) =>
    buildConfig(makeInstance(), deps, process.cwd(), new AbortController().signal, nullStream)
      .spanIdentity

  test("observe.attempt=1 ⇒ spanIdentity.attempt=1 (the .1.jsonl file's index)", () => {
    const id = spanIdentityOf(depsWith({ dir: "/tmp/obs", runId: "r1", attempt: 1 }))
    expect(id).toEqual({ instanceId: "c5__attempt-wiring", attempt: 1 })
  })

  test("observe.attempt=0 ⇒ spanIdentity.attempt=0 (single-pass / first Best-of-N attempt)", () => {
    const id = spanIdentityOf(depsWith({ dir: "/tmp/obs", runId: "r1", attempt: 0 }))
    expect(id).toEqual({ instanceId: "c5__attempt-wiring", attempt: 0 })
  })

  test("NO observe ⇒ attempt key OMITTED (join still works on runId+instanceId)", () => {
    const id = spanIdentityOf(depsWith(undefined))
    expect(id).toEqual({ instanceId: "c5__attempt-wiring" })
    expect("attempt" in (id as object)).toBe(false)
  })

  test("observe present but attempt undefined ⇒ key OMITTED (never stamps a bogus 0)", () => {
    const id = spanIdentityOf(depsWith({ dir: "/tmp/obs", runId: "r1" }))
    expect(id).toEqual({ instanceId: "c5__attempt-wiring" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (2b) per-attempt root — distinct trace ids + distinct attempt attrs, gated.
// ─────────────────────────────────────────────────────────────────────────────

/** A trivial live SpanSink — its mere presence flips `withBenchInstanceRoot` ON
 *  (the gate is `getSpanSink()`), so the active-context root is installed. */
const noopLiveSink: SpanSink = { onStart: () => ({}), onEnd: () => {} }

describe("C5 bench-attempt root — Best-of-N attempts get DISTINCT traces + attempt attrs", () => {
  test("live sink ⇒ two attempts of one instance carry DISTINCT trace ids (never merged)", async () => {
    setSpanSink(noopLiveSink)
    const traceOf = async (attempt: number): Promise<string | undefined> =>
      withBenchInstanceRoot({ instanceId: "django-1", attempt }, async () => {
        // Inside the root, the active ref IS this attempt's root span.
        return getActiveTraceRef()?.traceId
      })
    const t0 = await traceOf(0)
    const t1 = await traceOf(1)
    expect(t0).toBeDefined()
    expect(t1).toBeDefined()
    // One trace per attempt — Best-of-N attempts are separate traces.
    expect(t0).not.toBe(t1)
    // W3C-shaped id (32 lowercase hex).
    expect(t0).toMatch(/^[0-9a-f]{32}$/)
  })

  test("live sink ⇒ the root installs an active ref (nested loop spans discover it as parent)", async () => {
    setSpanSink(noopLiveSink)
    // No enclosing scope ⇒ undefined; inside the root ⇒ a valid ref whose spanId
    // becomes the parent of any nested `withActiveSpanScope(false)` span.
    expect(getActiveTraceRef()).toBeUndefined()
    const inner = await withBenchInstanceRoot({ instanceId: "django-1", attempt: 0 }, async () =>
      getActiveTraceRef(),
    )
    expect(inner?.spanId).toMatch(/^[0-9a-f]{16}$/)
    // The root is a fresh trace ⇒ no parent edge on it.
    expect(inner?.parentSpanId).toBeUndefined()
  })

  test("OFF (no sink) ⇒ NO span, NO active ref, body called directly (byte-identical)", async () => {
    expect(getSpanSink()).toBeNull()
    let sawRef: unknown = "unset"
    const out = await withBenchInstanceRoot({ instanceId: "django-1", attempt: 0 }, async () => {
      sawRef = getActiveTraceRef()
      return 42
    })
    expect(out).toBe(42) // body ran, value flows through
    expect(sawRef).toBeUndefined() // NO context frame installed
  })
})
