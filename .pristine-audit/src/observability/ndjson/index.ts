/**
 * NDJSON live-event introspection sink — slice barrel (ADR-0468).
 *
 * The PURE half of Cursor's `cursor-ndjson-ingest`: a deterministic event →
 * NDJSON line encoder, a bounded ring-buffer backpressure policy, a no-throw
 * `NdjsonSinkPort`, and three sinks (Null = default-OFF, Capturing = tests,
 * Buffered = production core with an injected flush callback).
 *
 * The HTTP server / file-tail ADAPTER (the part that opens a socket in Cursor's
 * 7242-7942 port range and writes `.cursor/debug.log`) lives at the composition
 * root in `@/apps` — `@/observability` may import ONLY `@/shared`, so a net/fs
 * adapter cannot live in this slice. See ADR-0468 integration TODO for the exact
 * `NdjsonSinkPort` / `NdjsonFlush` shapes the adapter must satisfy.
 *
 * Plane-clean: only `@/shared` flows in. Zero `@/agent` / `@/tool` / `@/llm` /
 * net / fs.
 *
 * Default-OFF: no `@/apps` wire imports from this barrel today. The composition
 * root wires {@link NullNdjsonSink} unless `QUANTA_NDJSON_INGEST_PORT` (or a
 * configured path) is set — byte-identical to "no NDJSON introspection".
 */

export { createNdjsonEncoder, defaultNdjsonEncoder } from "./encoder"
export {
  createNdjsonRingBuffer,
  type NdjsonRingBuffer,
  type OfferOutcome,
} from "./ring-buffer"
export {
  type BufferedNdjsonSink,
  type CapturingNdjsonSink,
  createBufferedNdjsonSink,
  createCapturingNdjsonSink,
  type NdjsonFlush,
  NullNdjsonSink,
} from "./sinks"
export type {
  BackpressurePolicy,
  NdjsonConfigError,
  NdjsonEncoder,
  NdjsonEvent,
  NdjsonSinkError,
  NdjsonSinkPort,
  RingBufferConfig,
} from "./types"
