/**
 * HELLGATE (integration, e2e) — bench live-trace RUN-LINK end to end.
 *
 * Drives the REAL composition path of the `bench-live-trace-run-link` feature —
 * NOT a hand-rolled fixture — from the boot seam all the way to the viewer's
 * `?run=<id>` deep-link filter:
 *
 *   bootBenchOtelExport(env, {fake fetch})            ← the SINGLE bench boot seam
 *     → resolveBenchRunId AUTO-ISSUES a run id (no explicit id, export ON)
 *     → the id is written back onto env.QUANTA_OTEL_RUN_ID / QUANTA_RUN_ID
 *     → installOtelSpanExportFromEnv registers the REAL exporter span sink
 *   startSpan/endSpan (the loop's real emit sites) → exporter buffers the span
 *     → exporter.flush() POSTs an OTLP/JSON envelope; the FAKE fetch captures it
 *        verbatim — the envelope carries `quanta.run.id` on the RESOURCE
 *   parseResourceSpansFull(capturedBody)              ← the REAL sink parser
 *     → toFullSpan FOLDS the resource `quanta.run.id` onto every span's `.attrs`
 *   applyRunFilter(spans, runId)                      ← FAITHFUL PORT of the
 *        trace-viewer.html `?run=<id>` filter (:183) → selects ONLY that run
 *
 * Every arrow above is production code exercised here (the ONLY test double is
 * the injected `fetch`, so it is hermetic — no live network, no real timers).
 * The existing `tracing-viewer-join-e2e.test.ts` is a hellgate for a DIFFERENT
 * feature (OBSERVE↔cassette span-tree unification via context-only sink) and
 * cannot cover this receiver→resource-fold→deep-link join.
 *
 * NON-VACUOUS — the run-filter join is proven by a paired RED-ON-INJECTION case:
 * with the resource `quanta.run.id` fold BROKEN (stripped before filtering), the
 * SAME assertion that passes here goes empty, so the green is load-bearing.
 *
 * Also pins the feature yaml's negative invariants (notes a–e):
 *   (a) run id rides the RESOURCE, not duplicated as a per-span attr on the wire
 *   (b) auto-issue ONLY when export is ON (no endpoint ⇒ no id)
 *   (c) an explicit QUANTA_OTEL_RUN_ID is NEVER overwritten
 *   (d) the `quanta.run.id` literal lives ONLY in vocabulary.ts (QUANTA_ATTRS.run.id)
 *   (e) auto-id is slugified to [A-Za-z0-9._-] so it is shell/URL safe
 * plus the Default-OFF byte-identical gate-off contract.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { bootBenchOtelExport, resolveBenchRunId, traceViewerUrl } from "@/apps/bench/otel"
import { type FullSpan, parseResourceSpansFull } from "@/apps/bench/otel-trace-sink"
import { attrs } from "@/observability/attrs"
import { __resetSpanSink, endSpan, getSpanSink, SPAN_NAMES, startSpan } from "@/observability/spans"
import { QUANTA_ATTRS } from "@/observability/vocabulary"

const ENDPOINT = "http://127.0.0.1:4318"

// ── in-process capturing OTLP receiver (fake fetch) ──────────────────────────
// NOT a live network endpoint: the exporter's injected `fetch` records each POST
// body verbatim. This IS the sink's wire — the same bytes a real collector's
// `/v1/traces` handler would `req.json()`.
interface CapturedPost {
  readonly path: string
  readonly body: unknown
}
const makeCapturingSink = (): { fetch: typeof fetch; posts: CapturedPost[] } => {
  const posts: CapturedPost[] = []
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input)
    posts.push({
      path: url.replace(ENDPOINT, ""),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake Response
    return { ok: true, status: 200 } as any
  }
  return { fetch: f as unknown as typeof fetch, posts }
}

// Exporter boot overrides: capture instead of network + NO real timers (flush is
// driven manually so the test is deterministic and hermetic).
const noTimer = {
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}
const bootOverrides = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  flushIntervalMs: 0,
  ...noTimer,
})

afterEach(() => {
  // The boot seam registers a process-global span sink; clear it between cases
  // so no sink leaks (mirrors __resetRuntimeConfig discipline).
  __resetSpanSink()
})

// ── FAITHFUL PORT of the trace-viewer.html `?run=<id>` filter ────────────────
// trace-viewer.html:183 `applyRunFilter`:
//   function applyRunFilter(spans){
//     if(!runFilter) return spans;
//     return spans.filter(s => String(s.attrs && s.attrs["quanta.run.id"] || "") === runFilter);
//   }
// Byte-faithful semantics: no filter ⇒ identity; else keep spans whose folded
// `quanta.run.id` attr === the requested run. The viewer reads the FOLDED
// per-span attr (never the resource sub-tree), which is exactly what the sink's
// `toFullSpan` produced — so this join is the real one, not a re-derivation.
const applyRunFilter = (
  spans: ReadonlyArray<FullSpan>,
  runFilter: string | undefined,
): FullSpan[] => {
  if (!runFilter) return [...spans]
  // Faithful to trace-viewer.html:183 — coerce the folded run-id attr to a string
  // (missing/empty ⇒ "") and keep only exact matches. (`s.attrs?.[k]` is the
  // lint-clean form of the HTML's `s.attrs && s.attrs[k]`; identical semantics.)
  return spans.filter((s) => String(s.attrs?.[QUANTA_ATTRS.run.id] || "") === runFilter)
}

/** Emit ONE real closed span through the process-global sink the boot seam
 *  installed (the loop's actual `startSpan`/`endSpan` sites), then flush the
 *  exporter so the capturing fetch records the OTLP/JSON envelope. Returns the
 *  captured `/v1/traces` body. */
const emitAndCapture = async (
  boot: ReturnType<typeof bootBenchOtelExport>,
  posts: CapturedPost[],
  instanceId: string,
): Promise<unknown> => {
  const span = startSpan(
    SPAN_NAMES.handleToolCall,
    attrs({ [QUANTA_ATTRS.instance.id]: instanceId }),
    "client",
  )
  endSpan(span, "ok", attrs({}))
  const exporter = boot.otelExport.exporter
  if (exporter === null) throw new Error("expected an exporter to be installed")
  await exporter.flush()
  // The just-flushed batch is the LAST `/v1/traces` POST — a shared receiver
  // accumulates many, so index from the end (not `find`, which returns arm A's
  // body for every subsequent flush).
  const traces = [...posts].reverse().find((p) => p.path === "/v1/traces")
  expect(traces).toBeDefined()
  return traces?.body
}

describe("bench live-trace run-link — real boot→sink→run-id fold→deep-link join", () => {
  test("AUTO-ISSUE: boot mints a run id, folds it onto every span, and ?run=<id> selects exactly that run", async () => {
    const { fetch, posts } = makeCapturingSink()
    // A throwaway env (the real entries pass process.env, which the seam mutates
    // in place); export ON, NO explicit run id ⇒ resolveBenchRunId auto-issues.
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_BENCH_PRESET: "v3-thin",
    }
    const boot = bootBenchOtelExport(env, bootOverrides(fetch))

    // 1a. resolveBenchRunId auto-issued an id AND the seam wrote it back onto env
    //     (both id namespaces — reaches exporter AND forwards to boxes).
    expect(boot.runId).toBeDefined()
    const runId = boot.runId as string
    expect(env.QUANTA_OTEL_RUN_ID).toBe(runId)
    expect(env.QUANTA_RUN_ID).toBe(runId) // C5 unification
    // The exporter span sink is really installed (not a no-op).
    expect(boot.otelExport.exporter).not.toBeNull()
    expect(getSpanSink()).not.toBeNull()
    // The boot wire computed the clickable deep-link for this run.
    expect(boot.traceLink).toBe(traceViewerUrl(4318, runId))
    expect(boot.traceLink).toContain(`?run=${encodeURIComponent(runId)}`)

    // 2. A real emitted span reaches the exporter; the flushed OTLP envelope
    //    carries `quanta.run.id` on the RESOURCE.
    const body = await emitAndCapture(boot, posts, "django__django-11138")

    // 3. The REAL sink parser folds the resource run id onto each span's attrs.
    const spans = parseResourceSpansFull(body as never)
    expect(spans.length).toBe(1)
    expect(spans[0]?.attrs[QUANTA_ATTRS.run.id]).toBe(runId) // the FOLD happened

    // 4. The viewer's ?run=<id> filter selects exactly this run.
    const selected = applyRunFilter(spans, runId)
    expect(selected.length).toBe(1)
    expect(selected[0]?.attrs[QUANTA_ATTRS.instance.id]).toBe("django__django-11138")

    // A DIFFERENT run's deep-link selects NOTHING from this sink (the whole point
    // — a mixed sink no longer bleeds one run into another's view).
    expect(applyRunFilter(spans, "some-other-run-9zzz").length).toBe(0)
  })

  test("MIXED SINK: two concurrent runs stream into ONE receiver; each ?run=<id> isolates its own", async () => {
    // Two boots = two operator invocations sharing one sink. Because a sink is
    // process-global, boot #2's install is idempotently skipped — so we drive
    // each run's spans through ITS OWN boot/exporter (the real full-remote shape:
    // each box has its own exporter, all POSTing to the same receiver).
    const { fetch, posts } = makeCapturingSink()

    const envA: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_OTEL_RUN_ID: "armA-campaign",
    }
    const bootA = bootBenchOtelExport(envA, bootOverrides(fetch))
    expect(bootA.runId).toBe("armA-campaign")
    const bodyA = await emitAndCapture(bootA, posts, "inst-A")
    __resetSpanSink() // free the global sink so boot B can install its own exporter

    const envB: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_OTEL_RUN_ID: "armB-campaign",
    }
    const bootB = bootBenchOtelExport(envB, bootOverrides(fetch))
    expect(bootB.runId).toBe("armB-campaign")
    const bodyB = await emitAndCapture(bootB, posts, "inst-B")

    // The receiver now holds BOTH runs' spans (a real mixed sink).
    const all = [
      ...parseResourceSpansFull(bodyA as never),
      ...parseResourceSpansFull(bodyB as never),
    ]
    expect(all.length).toBe(2)

    // ?run=armA-campaign isolates ONLY arm A; ?run=armB isolates ONLY arm B.
    const onlyA = applyRunFilter(all, "armA-campaign")
    expect(onlyA.length).toBe(1)
    expect(onlyA[0]?.attrs[QUANTA_ATTRS.instance.id]).toBe("inst-A")
    const onlyB = applyRunFilter(all, "armB-campaign")
    expect(onlyB.length).toBe(1)
    expect(onlyB[0]?.attrs[QUANTA_ATTRS.instance.id]).toBe("inst-B")
    // No-filter view shows the mix (identity) — the bug this feature closes.
    expect(applyRunFilter(all, undefined).length).toBe(2)
  })

  test("RED-ON-INJECTION: break the resource→per-span run-id FOLD ⇒ the deep-link filter goes empty (proves the green is load-bearing)", async () => {
    const { fetch, posts } = makeCapturingSink()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_OTEL_RUN_ID: "linkme-run",
    }
    const boot = bootBenchOtelExport(env, bootOverrides(fetch))
    const runId = boot.runId as string
    const body = await emitAndCapture(boot, posts, "inst-red")

    // CONTROL: the real fold selects the run (this is the green assertion).
    const folded = parseResourceSpansFull(body as never)
    expect(applyRunFilter(folded, runId).length).toBe(1)

    // INJECTION: simulate a broken sink fold — strip the folded resource run id
    // off every span BEFORE the viewer filter (exactly the regression of NOT
    // stamping `quanta.run.id` per span in `toFullSpan`). The deep-link filter
    // now matches nothing: the run is UNLINKABLE. This is the failure the green
    // above rules out — so the green is non-vacuous.
    const unfolded: FullSpan[] = folded.map((s) => {
      const { [QUANTA_ATTRS.run.id]: _dropped, ...rest } = s.attrs
      return { ...s, attrs: rest }
    })
    expect(applyRunFilter(unfolded, runId).length).toBe(0)
  })

  test("negative (a): the run id rides the RESOURCE — NOT duplicated as a per-span attr on the wire", async () => {
    const { fetch, posts } = makeCapturingSink()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_OTEL_RUN_ID: "resource-only-run",
    }
    const boot = bootBenchOtelExport(env, bootOverrides(fetch))
    const body = (await emitAndCapture(boot, posts, "inst-a")) as {
      resourceSpans: ReadonlyArray<{
        resource?: { attributes?: ReadonlyArray<{ key?: string }> }
        scopeSpans?: ReadonlyArray<{
          spans?: ReadonlyArray<{ attributes?: ReadonlyArray<{ key?: string }> }>
        }>
      }>
    }
    const rs = body.resourceSpans[0]
    // On the RESOURCE: present exactly once.
    const resourceKeys = (rs?.resource?.attributes ?? []).map((kv) => kv.key)
    expect(resourceKeys).toContain(QUANTA_ATTRS.run.id)
    // On every SPAN's own wire attrs: ABSENT (the fold is a receiver-side view,
    // not an N-times-duplicated per-span wire attr).
    for (const ss of rs?.scopeSpans ?? [])
      for (const span of ss.spans ?? []) {
        const spanKeys = (span.attributes ?? []).map((kv) => kv.key)
        expect(spanKeys).not.toContain(QUANTA_ATTRS.run.id)
      }
  })

  test("negative (b): auto-issue ONLY when export is ON — no endpoint ⇒ NO run id (via resolveBenchRunId directly)", () => {
    // Export ON but no explicit id ⇒ auto-issue.
    expect(resolveBenchRunId({ QUANTA_OTEL_ENDPOINT: ENDPOINT })).toBeDefined()
    // No endpoint AND no explicit id ⇒ NO id (minting one would be a confusing
    // no-op + a non-OFF env mutation).
    expect(resolveBenchRunId({})).toBeUndefined()
    expect(resolveBenchRunId({ QUANTA_OTEL_ENDPOINT: "   " })).toBeUndefined()
  })

  test("negative (c): an explicit QUANTA_OTEL_RUN_ID is NEVER overwritten by the boot seam", () => {
    const { fetch } = makeCapturingSink()
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      QUANTA_OTEL_RUN_ID: "operator-pinned-label",
    }
    const boot = bootBenchOtelExport(env, bootOverrides(fetch))
    expect(boot.runId).toBe("operator-pinned-label")
    // The seam leaves the operator's pin exactly as given (no re-mint / re-slug).
    expect(env.QUANTA_OTEL_RUN_ID).toBe("operator-pinned-label")
    // resolveBenchRunId echoes the explicit pin (trimmed) with export OFF too.
    expect(resolveBenchRunId({ QUANTA_OTEL_RUN_ID: "  pinned  " })).toBe("pinned")
  })

  test("negative (d): the run-id literal lives ONLY in vocabulary.ts — the fold/filter key IS QUANTA_ATTRS.run.id", () => {
    // The join key threaded through resource → fold → filter is the single
    // vocabulary constant (orphan-literal ratchet). If someone re-hardcoded a
    // stray "quanta.run.id" string it would drift from this SSOT.
    expect(QUANTA_ATTRS.run.id).toBe("quanta.run.id")
  })

  test("negative (e): the auto-issued id is slugified to [A-Za-z0-9._-] so it is shell/URL safe", () => {
    const runId = resolveBenchRunId({
      QUANTA_OTEL_ENDPOINT: ENDPOINT,
      // A preset with URL/shell-hostile chars must be collapsed to `-`.
      QUANTA_BENCH_PRESET: "arm/1 A&B?x",
    })
    expect(runId).toBeDefined()
    const id = runId as string
    // Every char is URL/shell safe (the RUN_ID_UNSAFE class is collapsed).
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
    // Round-trips through URL encoding unchanged (safe to ride `?run=`).
    expect(encodeURIComponent(id)).toBe(id)
    // The hostile chars are gone — the preset was really slugified, not echoed.
    expect(id).not.toContain("/")
    expect(id).not.toContain("&")
    expect(id).not.toContain("?")
    expect(id).not.toContain(" ")
  })

  test("gate-OFF (Default-OFF byte-identical): no QUANTA_OTEL_ENDPOINT ⇒ no run id, env untouched, no sink installed", () => {
    const { fetch } = makeCapturingSink()
    // A plain run: no endpoint, no id, no pins. Snapshot the env to prove it is
    // not mutated (the boot seam mutates in place BY DESIGN when export is on).
    const env: Record<string, string | undefined> = { SOME_UNRELATED: "x" }
    const before = { ...env }
    const boot = bootBenchOtelExport(env, bootOverrides(fetch))

    // No run id issued, no deep-link, no exporter.
    expect(boot.runId).toBeUndefined()
    expect(boot.traceLink).toBeUndefined()
    expect(boot.otelExport.exporter).toBeNull()
    // NO span sink registered (byte-identical to today's plain run).
    expect(getSpanSink()).toBeNull()
    // NEITHER id namespace was seeded — env is byte-identical to before.
    expect(env.QUANTA_OTEL_RUN_ID).toBeUndefined()
    expect(env.QUANTA_RUN_ID).toBeUndefined()
    expect(env).toEqual(before)
  })
})
