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

import type { OtelExporterOpts } from "@/observability/otel-exporter"
import {
  type ExporterSpanSinkOpts,
  type InstalledOtelExport,
  installOtelSpanExportFromEnv,
} from "@/observability/otel-span-export"

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
