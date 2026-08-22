/**
 * Built-in JSONL sink (ADR-0144).
 *
 * Appends `JSON.stringify(sample) + "\n"` to a file per send call. Synchronous
 * write keeps the contract simple (no buffering surprises across test boundaries)
 * — `flush()` is therefore a no-op. For high-throughput production exporters,
 * wire a buffered OTel/Prometheus adapter instead.
 *
 * Directory creation: the sink ensures the parent directory exists at
 * construction time (`mkdirSync` with `recursive`). A missing-dir error at
 * write time is non-fatal — the sink swallows per the no-throw policy in
 * ADR-0144 contract #3.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { MetricSink } from "./port"

/** Construct a JSONL sink targeting `path`. Auto-creates the parent
 *  directory if missing. */
export const jsonlMetricsSink = (path: string): MetricSink => {
  // Best-effort directory create at construction so the first `send` finds
  // the path. recursive=true is idempotent on an existing dir; on permission
  // failure we swallow and let the per-write try/catch take over.
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // Swallow — first `send` will surface the same failure (and also swallow
    // per the no-throw policy).
  }
  return {
    send(sample) {
      try {
        appendFileSync(path, `${JSON.stringify(sample)}\n`)
      } catch {
        // Swallow — observability sink must not crash callers (ADR-0144 #3).
      }
    },
    async flush() {
      // Sync write — nothing to drain. Kept on the surface so a future
      // buffered variant can swap in without API churn.
    },
  }
}
