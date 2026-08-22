/**
 * Default-ON bench tracing (jun-27). A full-remote run's agent spans are only
 * captured if an OTEL sink is listening AND `QUANTA_OTEL_ENDPOINT` points at it —
 * forget either and the trace is silently LOST (jun-27: a 55-turn solve of
 * django-11141 was unrecoverable because the run wasn't traced). This makes
 * capture the DEFAULT: when the operator hasn't chosen their own endpoint, the
 * bench embeds a durable trace sink (waterfall UI + a per-run `.jsonl` under
 * benchHome/traces) and points the run at it, so every run is auto-traced.
 *
 * Contract: MUTATES `env.QUANTA_OTEL_ENDPOINT` + `env.QUANTA_OTEL_RUN_ID` +
 * `env.QUANTA_RUN_ID` so the box exporter + the reverse tunnel (both already
 * wired to those vars) pick it up.
 *   - endpoint UNSET ............ embed a sink, set the vars (default-ON).
 *   - endpoint = off/0/false .... opt-out, no-op (byte-identical: nothing traced).
 *   - endpoint = a real URL ..... the operator's own collector — respect it, no-op.
 * Returns a handle whose `stop()` drains + frees the port (call in a `finally`),
 * or null when it no-op'd.
 *
 * C5 run-id unification: this is the THIRD run-id writer (after
 * `bootBenchOtelExport` and `runMain`). It no longer BLINDLY re-mints from the
 * caller's `opts.runId` — an id already pinned in `env` (QUANTA_OTEL_RUN_ID or
 * QUANTA_RUN_ID, e.g. seeded by the boot wire or the operator) is the SAME
 * logical run and WINS, so the embedded-sink run id, the forwarded OTLP id, and
 * the observe/cassette id are ONE authority. It then seeds BOTH id keys so a
 * full-remote box receives one id in both namespaces (see box-session
 * FORWARD_EXTRA_ENV), and the box's OTLP resource joins its observe ctx.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { benchHome } from "@/runner/batch/corpus/paths"
import { runTraceSink } from "./otel-trace-sink"
import { fileSpanSink } from "./span-sink"

export interface DefaultTraceSink {
  readonly runId: string
  readonly uiUrl: string
  readonly file: string
  stop(): Promise<void>
}

const OPT_OUT = new Set(["off", "0", "false", "no"])

/** Consume the UNIFIED run id: an id already pinned in env (OTLP or artifact
 *  namespace) is authoritative — the caller's `fallback` is only a mint of last
 *  resort. Prefer the OTLP id (the boot wire's authority) then the artifact id,
 *  else the fallback. Trimmed/blank-safe. */
const unifiedRunId = (env: Record<string, string | undefined>, fallback: string): string => {
  const otel = env.QUANTA_OTEL_RUN_ID?.trim()
  if (otel !== undefined && otel !== "") return otel
  const artifact = env.QUANTA_RUN_ID?.trim()
  if (artifact !== undefined && artifact !== "") return artifact
  return fallback
}

export const ensureBenchTraceSink = (
  env: Record<string, string | undefined>,
  opts: { runId: string; port?: number; log?: (m: string) => void },
): DefaultTraceSink | null => {
  const existing = (env.QUANTA_OTEL_ENDPOINT ?? "").trim()
  if (OPT_OUT.has(existing.toLowerCase())) return null // explicit opt-out
  if (existing !== "") return null // operator's own endpoint — don't embed, respect it

  // ONE authority: reuse a pinned id if present, else mint from the caller's
  // fallback. This is what makes the sink id == the forwarded OTLP id == the
  // observe ctx id instead of a diverging `fullremote-…-<ts>`.
  const runId = unifiedRunId(env, opts.runId)
  const port = opts.port ?? 4318
  const endpoint = `http://127.0.0.1:${port}`
  const dir = join(benchHome(), "traces")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${runId}.jsonl`)
  // Arm the box exporter + reverse tunnel REGARDLESS of whether we win the port —
  // if a sink is already on it (the operator ran `quanta-bench trace`), the run
  // streams to THAT one instead of failing. Seed BOTH id namespaces from the ONE
  // resolved id so the forwarded env carries a single authority.
  env.QUANTA_OTEL_ENDPOINT = endpoint
  env.QUANTA_OTEL_RUN_ID = runId
  env.QUANTA_RUN_ID = runId
  try {
    const sink = runTraceSink({ port, spanSink: fileSpanSink(file), sinkLabel: `file:${file}` })
    opts.log?.(
      `[trace] default-ON — capturing this run → ${file}\n` +
        `        live waterfall: ${sink.uiUrl}?run=${runId}  (opt out: QUANTA_OTEL_ENDPOINT=off)`,
    )
    return { runId, uiUrl: sink.uiUrl, file, stop: sink.stop }
  } catch {
    // Port busy ⇒ reuse the sink already listening; we own no lifecycle for it.
    opts.log?.(`[trace] default-ON — streaming to the sink already on :${port} (run=${runId})`)
    return { runId, uiUrl: `${endpoint}/`, file, stop: async () => {} }
  }
}
