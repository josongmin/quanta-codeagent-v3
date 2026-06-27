/**
 * Span-sink PORT + adapters — WHERE the live OTEL trace receiver durably persists
 * raw span NDJSON, decoupled from the receiver itself. The in-memory ring
 * (`GET /spans.json`) is ALWAYS the live view; this is the optional durable tee.
 *
 * Best-effort BY CONTRACT: a live receiver must survive a flaky disk / network /
 * S3, so every adapter swallows its OWN errors — a single dropped span must never
 * crash span ingestion (which would blind the operator mid-run, the exact failure
 * this layer exists to prevent).
 *
 * Adapters:
 *   - noop  (default)          — in-memory ring only, no durable persistence.
 *   - file:/abs/path.jsonl     — append each span as one JSONL line (the historical
 *                                `QUANTA_OTEL_SAVE` behavior, now an adapter).
 *   - s3://bucket/prefix       — buffer lines + flush as NDJSON objects, reusing the
 *                                shared {@link RemoteBackend} (aws-cli, offline-
 *                                testable) the spot-resume store already uses.
 *
 * Destination selected by `QUANTA_OTEL_SINK` (`file:…` | `s3://…` | bare path ⇒
 * file); legacy `QUANTA_OTEL_SAVE=/path` still works (⇒ `file:/path`).
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { type RemoteBackend, s3Backend } from "@/shared/remote-store"

/** The seam every trace-sink persistence target implements. */
export interface SpanSinkPort {
  /** Persist ONE already-JSON-serialized span line. MUST NOT throw. */
  write(line: string): void
  /** Flush any buffered spans to the durable backend (e.g. a final S3 put on
   *  shutdown). MUST NOT throw. No-op for synchronous adapters. */
  flush(): Promise<void>
}

/** Default: ring only, nothing durable. */
export const noopSpanSink = (): SpanSinkPort => ({
  write: () => {},
  flush: async () => {},
})

/** Append each span as a JSONL line under `path` (parent dirs created). */
export const fileSpanSink = (path: string): SpanSinkPort => {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // parent may already exist / be unwritable — write() reports the real failure
  }
  return {
    write: (line) => {
      try {
        appendFileSync(path, `${line}\n`)
      } catch {
        // disk full / permission — drop this span, keep the receiver alive
      }
    },
    flush: async () => {},
  }
}

/** Buffer span lines + flush every `flushEveryN` (and on explicit flush) as an
 *  NDJSON object `s3://bucket/<prefix>/spans-<seq>.jsonl`. */
export const s3SpanSink = (
  backend: RemoteBackend,
  prefix: string,
  opts: { readonly flushEveryN?: number } = {},
): SpanSinkPort => {
  const flushN = opts.flushEveryN ?? 200
  const buf: string[] = []
  // Durable sequence: resolved ONCE from the highest existing `spans-<n>` under the
  // prefix so a sink RESTART appends instead of overwriting `spans-000000` (silent
  // data loss — the bug this fixes). `list` is the same primitive the resume segment
  // store uses. Guarded by a single init promise so concurrent first-flushes can't
  // both seed `seq` (the only async-interleave race in a single-threaded event loop).
  let seq = -1
  let init: Promise<void> | undefined
  const ensureSeq = async (): Promise<void> => {
    if (seq >= 0) return
    init ??= (async () => {
      let max = -1
      try {
        for (const key of await backend.list(prefix)) {
          const m = key.match(/spans-(\d+)\.jsonl$/)
          if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
        }
      } catch {
        // list unavailable — start at 0 (best-effort; first object may overwrite)
      }
      seq = max + 1
    })()
    await init
  }
  const flush = async (): Promise<void> => {
    if (buf.length === 0) return
    const body = `${buf.join("\n")}\n`
    buf.length = 0
    await ensureSeq()
    const part = String(seq++).padStart(6, "0")
    try {
      await backend.put(`${prefix}/spans-${part}.jsonl`, body)
    } catch {
      // S3 hiccup — drop this batch rather than crash ingestion; the ring still
      // serves the live view and the next batch retries the upload.
    }
  }
  return {
    write: (line) => {
      buf.push(line)
      if (buf.length >= flushN) void flush()
    },
    flush,
  }
}

/** Parse `s3://bucket/prefix/...` into its bucket + key prefix (prefix defaults
 *  to `spans` when only a bucket is given). */
const parseS3Dest = (dest: string): { bucket: string; prefix: string } => {
  const rest = dest.slice("s3://".length)
  const slash = rest.indexOf("/")
  if (slash === -1) return { bucket: rest, prefix: "spans" }
  return { bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) || "spans" }
}

export interface SpanSinkDeps {
  /** Injected S3 backend factory (offline-testable); default = the real cli-backed
   *  `s3Backend`. */
  readonly makeS3?: (bucket: string, region: string | undefined) => RemoteBackend
}

/**
 * Resolve the durable sink from the environment. `QUANTA_OTEL_SINK` wins:
 *   `s3://bucket/prefix`  ⇒ S3 adapter (region from QUANTA_OTEL_S3_REGION/AWS_REGION)
 *   `file:/abs/path`      ⇒ file adapter
 *   bare `/abs/path`      ⇒ file adapter
 * Back-compat: `QUANTA_OTEL_SAVE=/path` ⇒ `file:/path`. Unset/empty ⇒ noop.
 */
export const resolveSpanSink = (
  env: NodeJS.ProcessEnv,
  deps: SpanSinkDeps = {},
): SpanSinkPort => {
  const legacy =
    env.QUANTA_OTEL_SAVE !== undefined && env.QUANTA_OTEL_SAVE !== ""
      ? `file:${env.QUANTA_OTEL_SAVE}`
      : undefined
  const dest = env.QUANTA_OTEL_SINK ?? legacy
  if (dest === undefined || dest === "") return noopSpanSink()
  if (dest.startsWith("s3://")) {
    const { bucket, prefix } = parseS3Dest(dest)
    if (bucket === "") return noopSpanSink()
    const region = env.QUANTA_OTEL_S3_REGION ?? env.AWS_REGION
    const make =
      deps.makeS3 ??
      ((b: string, r: string | undefined) =>
        s3Backend({ bucket: b, ...(r !== undefined ? { region: r } : {}) }))
    return s3SpanSink(make(bucket, region), prefix)
  }
  const path = dest.startsWith("file:") ? dest.slice("file:".length) : dest
  return path === "" ? noopSpanSink() : fileSpanSink(path)
}
