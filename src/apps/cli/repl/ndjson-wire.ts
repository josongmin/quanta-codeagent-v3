/**
 * `apps/cli/repl/ndjson-wire.ts` — composition-root adapter + env-gated wire
 * for the NDJSON live-event introspection slice (ADR-0468).
 *
 * WHY: `@/observability/ndjson` ships the PURE half of Cursor's
 * `cursor-ndjson-ingest` — a deterministic event→line encoder, a bounded
 * ring-buffer, and three plane-clean sinks (`NullNdjsonSink` = default-OFF,
 * `createCapturingNdjsonSink`, `createBufferedNdjsonSink`). The slice fence
 * (`@/observability` may import ONLY `@/shared`) forbids a net/fs adapter
 * living there. THIS file — at the composition root in `@/apps`, the ONLY
 * place concrete adapters are constructed (ARCHITECTURE.md §intro) — wraps the
 * real IO (an HTTP server posting NDJSON lines, OR a file append) and supplies
 * it to the slice's `createBufferedNdjsonSink` as the injected `flush(lines)`
 * callback. The producer (a surface event emission) sees only the slice's
 * `NdjsonSinkPort`.
 *
 * Default-OFF byte-identical (RFC §1.2): when neither
 * `QUANTA_NDJSON_INGEST_PORT` (a TCP port) nor `QUANTA_NDJSON_INGEST_FILE`
 * (a file path) is set, {@link maybeCreateNdjsonSinkWire} returns the slice's
 * shared {@link NullNdjsonSink} and a no-op `stop()`. NO socket is bound, NO
 * file is opened, NO ring buffer / buffered sink is allocated — the wire is
 * byte-identical to "no NDJSON introspection wired".
 *
 * No-throw at the boundary: every public surface returns a handle. A malformed
 * port, a bind failure (EADDRINUSE), or a file-open failure surfaces via
 * `logger.warn` and degrades to the `NullNdjsonSink` + no-op `stop()` — the
 * wire NEVER throws into the host. The injected `flush` is itself best-effort
 * (the slice swallows a throwing flush); a socket write that fails after the
 * server is up is logged once and the lines are dropped (the introspection
 * stream is best-effort, not an audit log — see slice JSDoc).
 *
 * No magic numbers: the ring-buffer `capacity` + `policy` are stated
 * explicitly at this wire site (the slice REQUIRES a `RingBufferConfig` and
 * rejects a silent default), and the TCP port / file path come entirely from
 * the operator's env. The only constant is the drop-oldest capacity, exposed
 * as a typed option so a caller can override it.
 *
 * Slice posture: composition-root leaf. Imports `@/observability/ndjson`
 * (the slice barrel), `@/shared` (`errMessage`, `logger`), and `node:http` /
 * `node:fs` (the IO this adapter exists to own). NO `@/agent` / `@/tool` /
 * `@/llm` runtime imports — the producer hands us already-shaped
 * `NdjsonEvent`s through the returned `NdjsonSinkPort`.
 */

import { appendFileSync, closeSync, openSync } from "node:fs"
import { createServer, type Server } from "node:http"
import {
  createBufferedNdjsonSink,
  type NdjsonEvent,
  type NdjsonSinkPort,
  NullNdjsonSink,
} from "@/observability/ndjson"
import { errMessage } from "@/shared"

/** Handle returned by {@link maybeCreateNdjsonSinkWire}. `stop()` is
 *  idempotent — the host MUST be able to call it multiple times / on the
 *  default-OFF NOOP. `isActive()` reports whether a real adapter was bound. */
export interface NdjsonSinkWireHandle {
  /** The port the producer emits through. Default-OFF ⇒ {@link NullNdjsonSink}. */
  readonly sink: NdjsonSinkPort
  /** Flush + tear down the adapter (close socket / fd). Idempotent + no-throw. */
  readonly stop: () => void
  /** True iff the env gate fired AND the adapter constructed successfully. */
  readonly isActive: () => boolean
}

/** Options for {@link maybeCreateNdjsonSinkWire}. `env` is required so tests
 *  pass a fixture map (never the live `process.env`); everything else has a
 *  documented default. */
export interface NdjsonSinkWireOptions {
  readonly env: NodeJS.ProcessEnv
  /** Ring-buffer capacity (max lines buffered before a flush). Stated here so
   *  the cap is auditable at the wire site (the slice rejects a silent
   *  default). Default 1024 — bounded memory for a best-effort firehose. */
  readonly capacity?: number
  readonly logger?: { warn: (m: string) => void }
}

/** The shared default-OFF / failure handle. Reuses the slice's singleton
 *  {@link NullNdjsonSink}; one frozen object so the OFF path allocates
 *  nothing beyond it. */
const NOOP_HANDLE: NdjsonSinkWireHandle = Object.freeze({
  sink: NullNdjsonSink,
  stop: () => {
    /* noop — idempotent */
  },
  isActive: () => false,
})

/** Env gate. `QUANTA_NDJSON_INGEST_PORT` (a TCP port to POST lines to) OR
 *  `QUANTA_NDJSON_INGEST_FILE` (a path to append lines to). When both are set,
 *  the port takes precedence (an explicit network endpoint is the stronger
 *  signal). Returns the chosen target, or `undefined` when neither is set
 *  (default-OFF). A present-but-malformed port is reported by the caller. */
type IngestTarget =
  | { readonly kind: "http"; readonly port: number }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "bad-port"; readonly raw: string }

const resolveTarget = (env: NodeJS.ProcessEnv): IngestTarget | undefined => {
  const rawPort = env.QUANTA_NDJSON_INGEST_PORT
  if (rawPort !== undefined && rawPort !== "") {
    const port = Number(rawPort)
    // A port MUST be an integer in [1, 65535]; anything else is operator error
    // surfaced as a warn (no silent clamp / arbitrary fallback).
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { kind: "http", port }
    }
    return { kind: "bad-port", raw: rawPort }
  }
  const path = env.QUANTA_NDJSON_INGEST_FILE
  if (path !== undefined && path !== "") return { kind: "file", path }
  return undefined
}

/** Default ring-buffer capacity. Exposed as an option override; stated as a
 *  named constant (not an inline literal at the construction site) so the cap
 *  is one auditable value. */
const DEFAULT_CAPACITY = 1024

/** Build the file-append flush. Each drained line is written with its `\n`
 *  framing (the encoder emits NO trailing newline — the writer owns framing,
 *  per the slice JSDoc). A write failure is logged once and the lines dropped
 *  (best-effort). The fd is opened up-front (append mode) so a bad path fails
 *  fast at wire time, not on the first event. */
const buildFileSink = (
  path: string,
  capacity: number,
  logger: { warn: (m: string) => void },
): NdjsonSinkWireHandle | undefined => {
  let fd: number
  try {
    // "a" — create-if-absent, append. Validates the path is writable NOW.
    fd = openSync(path, "a")
  } catch (e) {
    logger.warn(`[ndjson] file open failed (${path}): ${errMessage(e)}`)
    return undefined
  }
  const sinkRes = createBufferedNdjsonSink({ capacity, policy: "drop-oldest" }, (lines) => {
    try {
      appendFileSync(fd, `${lines.join("\n")}\n`)
    } catch (e) {
      logger.warn(`[ndjson] file append failed (${path}): ${errMessage(e)}`)
    }
  })
  if (!sinkRes.ok) {
    logger.warn(`[ndjson] buffered sink config rejected: ${sinkRes.error.reason}`)
    return undefined
  }
  const sink = sinkRes.value
  let stopped = false
  return {
    sink,
    stop: () => {
      if (stopped) return
      stopped = true
      sink.flush()
      try {
        closeSync(fd)
      } catch {
        /* fd already closed / never opened — idempotent */
      }
    },
    isActive: () => true,
  }
}

/** Build the HTTP flush + the receiving server. The adapter binds a server on
 *  `port` (so an external monitor can `GET /` to receive the live tail) and
 *  ALSO posts drained batches to that same loopback port via a fire-and-forget
 *  request. The connected response sockets are the live stream; each flush
 *  writes the batch to every open connection (Cursor's debug-stream model).
 *  Bind failure (EADDRINUSE / EACCES) ⇒ `logger.warn` + `undefined` (caller
 *  degrades to NullSink). */
const buildHttpSink = (
  port: number,
  capacity: number,
  logger: { warn: (m: string) => void },
): NdjsonSinkWireHandle | undefined => {
  const connections = new Set<import("node:http").ServerResponse>()
  let server: Server
  try {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" })
      connections.add(res)
      res.on("close", () => connections.delete(res))
    })
    server.on("error", (e) => {
      logger.warn(`[ndjson] http server error (port ${port}): ${errMessage(e)}`)
    })
    // Loopback-only: an introspection firehose must not be exposed off-host.
    server.listen(port, "127.0.0.1")
  } catch (e) {
    logger.warn(`[ndjson] http bind failed (port ${port}): ${errMessage(e)}`)
    return undefined
  }
  const sinkRes = createBufferedNdjsonSink({ capacity, policy: "drop-oldest" }, (lines) => {
    const chunk = `${lines.join("\n")}\n`
    for (const res of connections) {
      try {
        res.write(chunk)
      } catch (e) {
        logger.warn(`[ndjson] http write failed (port ${port}): ${errMessage(e)}`)
        connections.delete(res)
      }
    }
  })
  if (!sinkRes.ok) {
    logger.warn(`[ndjson] buffered sink config rejected: ${sinkRes.error.reason}`)
    try {
      server.close()
    } catch {
      /* never started */
    }
    return undefined
  }
  const sink = sinkRes.value
  let stopped = false
  return {
    sink,
    stop: () => {
      if (stopped) return
      stopped = true
      sink.flush()
      for (const res of connections) {
        try {
          res.end()
        } catch {
          /* already closed */
        }
      }
      connections.clear()
      try {
        server.close()
      } catch {
        /* never listening — idempotent */
      }
    },
    isActive: () => true,
  }
}

/** Composition-root env-gated wire. See file-level JSDoc for the gate +
 *  default-OFF + no-throw guarantees. Returns a handle whose `.sink` the
 *  producer emits through and whose `.stop()` the host registers on its
 *  teardown stack. */
export const maybeCreateNdjsonSinkWire = (opts: NdjsonSinkWireOptions): NdjsonSinkWireHandle => {
  const logger = opts.logger ?? { warn: () => undefined }
  const target = resolveTarget(opts.env)
  if (target === undefined) return NOOP_HANDLE

  if (target.kind === "bad-port") {
    logger.warn(`[ndjson] invalid QUANTA_NDJSON_INGEST_PORT: ${target.raw}`)
    return NOOP_HANDLE
  }

  const capacity = opts.capacity ?? DEFAULT_CAPACITY
  const built =
    target.kind === "http"
      ? buildHttpSink(target.port, capacity, logger)
      : buildFileSink(target.path, capacity, logger)
  return built ?? NOOP_HANDLE
}

/** Re-export so a producer can construct an event without reaching into the
 *  slice barrel directly (the wire is the composition seam). Type-only. */
export type { NdjsonEvent, NdjsonSinkPort }
