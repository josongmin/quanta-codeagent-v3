/**
 * Bench OTLP span-export attach seam (ADR-0268, jun-26 full-remote live trace).
 *
 * The agent loop emits OTel spans (`session_loop` / `turn` / `run_sampling_request`
 * / `handle_tool_call`) plus `gen_ai.*` LLM attrs and tool/instance attrs through
 * the process-global span sink (`src/observability/spans.ts`). With no sink
 * registered those calls are zero-alloc no-ops. The HOST composition root must
 * call `installOtelSpanExportFromEnv` ONCE at startup to register the OTLP/JSON
 * exporter as the sink — then the existing emit sites go live and STREAM to the
 * operator's collector (`QUANTA_OTEL_ENDPOINT/v1/{traces,metrics}`), replacing the
 * flaky box→local `run.log` push.
 *
 * Why a bench-local wrapper (vs calling `installOtelSpanExportFromEnv` inline at
 * the entry point like the CLI/agent/web apps): the bench has TWO entry binaries —
 * `apps/bench/cli.ts` (the box runs `bun run src/apps/bench/cli.ts run …`, and the
 * primary local entry) and `apps/bench/index.ts` (legacy direct-invoke). Both must
 * attach, and `import.meta.main` blocks are not unit-testable. This thin seam gives
 * a single tested attach point both entries call.
 *
 * Default-OFF byte-identical: when `QUANTA_OTEL_ENDPOINT` is unset/blank,
 * `installOtelSpanExportFromEnv` builds NO exporter and registers NO sink — the
 * agent loop is byte-identical to today. NO localhost default is fabricated
 * (composition-root policy: a silent default would leak observations).
 */

import { makeContextOnlySpanSink } from "@/observability/context-only-sink"
import type { OtelExporterOpts } from "@/observability/otel-exporter"
import {
  type ExporterSpanSinkOpts,
  type InstalledOtelExport,
  installOtelSpanExportFromEnv,
} from "@/observability/otel-span-export"
import { getSpanSink, setSpanSink } from "@/observability/spans"

/** Attach the OTLP span/metric exporter for a bench process when
 *  `QUANTA_OTEL_ENDPOINT` is set on `env`. Returns the installed handle (with a
 *  no-op `teardown` when export is OFF). The caller wires `teardown` into
 *  `beforeExit` so a best-effort final flush drains on natural exit.
 *
 *  `env` is injectable so the attach seam is unit-testable with a fake env
 *  (the entry points pass `process.env`). `overrides` threads the exporter test
 *  seams (fake fetch / clock / no-timer) through to the hellgate. */
export const attachBenchOtelExport = (
  env: Readonly<Record<string, string | undefined>>,
  overrides?: Partial<OtelExporterOpts> & ExporterSpanSinkOpts,
): InstalledOtelExport => installOtelSpanExportFromEnv(env, overrides)

/** Chars NOT allowed in a run-id slug — collapsed to `-` so an auto-issued id is
 *  always URL- and shell-safe (it rides into `?run=` and forwarded box env). */
const RUN_ID_UNSAFE = /[^A-Za-z0-9._-]+/g

/** Resolve the run id a bench process streams its spans under, or `undefined`
 *  when OTLP export is OFF (no endpoint) AND no explicit id was pinned — leaving
 *  Default-OFF byte-identical.
 *
 *  THE HOLE THIS CLOSES: the run-id deep-link (`?run=<id>`) only works if spans
 *  carry `quanta.run.id`, which only happens if `QUANTA_OTEL_RUN_ID` is set.
 *  Relying on the operator to remember it means a forgotten env (e.g. the jun-27
 *  3-arm A/B) streams with NO run id and the link shows nothing. So:
 *    - explicit `QUANTA_OTEL_RUN_ID` (trimmed, non-blank) ALWAYS wins — the
 *      operator can pin a clean campaign/arm label;
 *    - else an explicit `QUANTA_RUN_ID` (the artifact/observe/cassette pin) is
 *      honored so the SAME id authors BOTH the OTLP resource and the observe
 *      ctx (C5 run-id unification — kills the two-id divergence where the boot
 *      wire minted `QUANTA_OTEL_RUN_ID` and `runMain` separately minted
 *      `QUANTA_RUN_ID` in a different format);
 *    - else, when export is ON, AUTO-ISSUE `<preset-slug>-<base36 time>` so every
 *      run is linkable with zero manual steps and two runs never collide.
 *  Set the result back onto BOTH `process.env.QUANTA_OTEL_RUN_ID` AND
 *  `process.env.QUANTA_RUN_ID` at the boot wire (see {@link bootBenchOtelExport})
 *  so it (a) reaches the exporter, (b) reaches the observe/cassette ctx, AND
 *  (c) forwards to every full-remote box (one operator invocation ⇒ one shared
 *  id across all its boxes and both id namespaces). */
export const resolveBenchRunId = (
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly now?: () => number; readonly rand?: () => number } = {},
): string | undefined => {
  const explicit = env.QUANTA_OTEL_RUN_ID
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim()
  // An explicit artifact-pin (QUANTA_RUN_ID) is the SAME logical run — honor it
  // as the authority so the OTLP resource and the observe ctx never diverge.
  // This wins even with NO endpoint (the operator pre-labeled the run), matching
  // the QUANTA_OTEL_RUN_ID explicit-precedence rule above.
  const explicitRunId = env.QUANTA_RUN_ID
  if (explicitRunId !== undefined && explicitRunId.trim() !== "") return explicitRunId.trim()
  // Auto-issue only when export is actually ON — no endpoint ⇒ nothing streams,
  // so minting an id would be a confusing no-op (and a non-OFF env mutation).
  if ((env.QUANTA_OTEL_ENDPOINT ?? "").trim() === "") return undefined
  const label =
    env.QUANTA_OTEL_SERVICE_NAME?.trim() &&
    env.QUANTA_OTEL_SERVICE_NAME.trim() !== "quanta-codeagent"
      ? env.QUANTA_OTEL_SERVICE_NAME
      : (env.QUANTA_BENCH_PRESET ?? env.QUANTA_BENCH_SOTA ?? env.QUANTA_KNOBS_PRESET ?? "bench")
  const slug =
    label
      .replace(RUN_ID_UNSAFE, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "bench"
  const now = opts.now ?? Date.now
  const rand = opts.rand ?? Math.random
  const t = Math.trunc(Math.abs(now())).toString(36).slice(-6)
  // 3 base36 entropy chars: a TIME suffix alone collides when two operator
  // processes auto-issue the same preset in the SAME millisecond (parallel
  // campaign boxes) → both stream under one id and the viewer MERGES them. The
  // entropy makes that 1-in-46656 even at identical ms (explicit ids stay exact).
  const ent = Math.floor(Math.abs(rand()) * 36 ** 3)
    .toString(36)
    .padStart(3, "0")
    .slice(-3)
  return `${slug}-${t}${ent}`
}

/** Compose the trace-viewer URL, deep-linked to one run when a run id is given
 *  (`?run=<id>` — the viewer then filters to only that run's spans). */
export const traceViewerUrl = (port: number, runId?: string): string =>
  `http://127.0.0.1:${port}/${runId !== undefined ? `?run=${encodeURIComponent(runId)}` : ""}`

/** Port the local trace-viewer UI is served on. The operator runs the sink on
 *  the SAME port their `QUANTA_OTEL_ENDPOINT` points at, so parse it from there
 *  (the printed boot-wire link must match where the UI actually listens); falls
 *  back to the OTLP/HTTP default 4318 when unset / unparseable. */
export const otelUiPort = (env: Readonly<Record<string, string | undefined>>): number => {
  const raw = env.QUANTA_OTEL_ENDPOINT
  if (raw !== undefined) {
    try {
      const p = Number(new URL(raw.trim()).port)
      if (Number.isInteger(p) && p > 0) return p
    } catch {
      // not a parseable URL → default port
    }
  }
  return 4318
}

export interface BenchOtelBoot {
  readonly otelExport: InstalledOtelExport
  /** The run id this process streams under, or undefined when export is OFF. */
  readonly runId: string | undefined
  /** The clickable trace-viewer deep-link, or undefined when export is OFF —
   *  the entry logs it so the operator can jump straight to this run's waterfall. */
  readonly traceLink: string | undefined
}

/** THE single bench boot seam both entry binaries (`cli.ts` + the legacy
 *  `index.ts`) call, so they auto-issue + attach IDENTICALLY (no drift: the
 *  legacy entry previously attached WITHOUT auto-issuing, so direct-invoke runs
 *  streamed with no run id and the `?run=` link was dead). It:
 *    1. resolves the run id ({@link resolveBenchRunId}) and writes it BACK onto
 *       `env` (process.env) BEFORE attach, so it both (a) reaches the exporter
 *       and (b) forwards to every full-remote box (buildForwardedBenchEnv reads
 *       process.env at box-launch) — one operator invocation ⇒ one shared id.
 *       C5 UNIFICATION: the SAME id is seeded onto BOTH `QUANTA_OTEL_RUN_ID`
 *       (OTLP resource / span deep-link) AND `QUANTA_RUN_ID` (the observe /
 *       cassette / artifact ctx that `runMain` would otherwise mint separately
 *       as `run-<ts>`). Seeding `QUANTA_RUN_ID` here — BEFORE `runMain`'s
 *       `??=` default and BEFORE the first `runtimeConfig()` freeze — makes the
 *       OTLP `quanta.run.id` and the observe `ctx.runId` the exact same value,
 *       so an OTLP span joins its `<runId>/<instanceId>.<attempt>.jsonl`
 *       trajectory. When a run id is resolved but `QUANTA_RUN_ID` was already
 *       pinned we leave it (the resolver already preferred that pin), so we
 *       never clobber an operator's artifact label;
 *    2. attaches the exporter ({@link attachBenchOtelExport});
 *    3. computes the trace-viewer deep-link for the entry to print.
 *  Default-OFF byte-identical: no endpoint AND no explicit id ⇒ runId/traceLink
 *  undefined, env untouched (NEITHER id key seeded — `runMain` mints
 *  `QUANTA_RUN_ID=run-<ts>` exactly as before), no sink registered. The run-id
 *  unification only bites when a sink is active OR an id was explicitly pinned.
 *  `env` is mutated in place by design (the entries pass process.env); a test
 *  passes a throwaway record. */
export const bootBenchOtelExport = (
  env: Record<string, string | undefined>,
  overrides?: Partial<OtelExporterOpts> & ExporterSpanSinkOpts,
): BenchOtelBoot => {
  const runId = resolveBenchRunId(env)
  if (runId !== undefined) {
    env.QUANTA_OTEL_RUN_ID = runId
    // Seed the artifact/observe/cassette id too so BOTH namespaces share ONE
    // authority. Use `??=` so an explicit QUANTA_RUN_ID pin (which the resolver
    // already honored as the source) is never overwritten.
    env.QUANTA_RUN_ID ??= runId
  }
  // ATTACH FIRST (T-B2 install-order guard): the OTLP exporter, when an endpoint
  // IS set, installs ITS span sink here and must WIN. `attachBenchOtelExport`
  // returns a non-null `exporter` exactly when it installed that sink, so gating
  // the context-only branch on `exporter === null` guarantees context-only NEVER
  // runs when the exporter is present (it cannot shadow it). Belt-and-braces: even
  // if that read ever drifted, `installOtelSpanExportFromEnv`'s own idempotent
  // guard (`getSpanSink() !== null`) means the exporter, once installed, owns the
  // sink — but we re-check `getSpanSink() === null` below so we NEVER clobber an
  // already-registered sink (exporter or a nested boot).
  const otelExport = attachBenchOtelExport(env, overrides)
  // jul-13 (ADR-0539, T-B2) — CONTEXT-ONLY span sink. When the knob is set AND no
  // OTLP endpoint is configured (no exporter installed above), install the
  // context-only sink so `withActiveSpanScope` mints real `{traceId,spanId}` on
  // every recorded unit — the trajectory viewer's span-tree becomes non-empty on
  // ordinary (non-export) bench runs — while exporting NOTHING.
  //
  // ⚠️ INSTANCE-FATAL COUPLING (the reason this is HIGH-risk): installing ANY sink
  // flips `traceContextExpected: () => getSpanSink() !== null` true
  // (`runner/batch/observe.ts:179`). If a recorded event were ever emitted OUTSIDE
  // `withActiveSpanScope` while the sink is live, the recorder would emit
  // `observability_degraded` (reason `missing_trace_context`) and FAIL the strict
  // rail → `verdict:"degraded"` → EXCLUDED from the eval denominator = a
  // bench-correctness regression. The real loop wraps EVERY recorded unit
  // (session/turn/tool/sampling) in `withActiveSpanScope`, so every emit sees a
  // ref and this never triggers on the real path — proven by the wiring test's
  // zero-spurious-degraded + LIVE-GATE red-on-injection cases.
  const traceContextOnly =
    otelExport.exporter === null && (env.QUANTA_TRACE_CONTEXT ?? "").trim() !== ""
  // `getSpanSink() === null` is the final ownership guard: an already-registered
  // sink (the exporter, or an outer boot) keeps control — context-only never
  // shadows it. Combined with `exporter === null` this is doubly safe.
  if (traceContextOnly && getSpanSink() === null) setSpanSink(makeContextOnlySpanSink())
  const traceLink =
    otelExport.exporter !== null && runId !== undefined
      ? traceViewerUrl(otelUiPort(env), runId)
      : undefined
  return { otelExport, runId, traceLink }
}
