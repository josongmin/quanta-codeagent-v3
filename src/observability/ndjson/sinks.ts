/**
 * NDJSON sink adapters — pure / test-side (ADR-0468).
 *
 * Three plane-clean sinks (no IO):
 *   - {@link NullNdjsonSink}    — the DEFAULT-OFF sink. `emit()` is a no-op
 *     returning `ok()`. Wired at the composition root when no
 *     `QUANTA_NDJSON_INGEST_PORT` / path is configured → byte-identical to "no
 *     NDJSON introspection". Encodes nothing, allocates nothing.
 *   - {@link createCapturingNdjsonSink} — in-memory capture for tests/asserts.
 *     Encodes each event (so tests pin the exact line bytes) and buffers it
 *     through the bounded ring buffer (so tests pin overflow behavior). Exposes
 *     the encoded lines + drop count.
 *   - {@link createBufferedNdjsonSink} — the production-shaped pure core: encode
 *     → ring-buffer → hand drained lines to an injected `flush(lines)` callback.
 *     The composition-root HTTP/file adapter supplies `flush`; this slice never
 *     touches a socket or the filesystem (fence: `@/observability` may import
 *     only `@/shared`).
 *
 * NO-THROW: every `emit()` returns `Result`. Encode failures and full
 * reject-newest buffers are `Err`; nothing throws past the boundary. An
 * injected `flush` that throws is contained (best-effort drain), never
 * propagated to the producer.
 *
 * Plane-clean: imports ONLY `@/shared` + sibling pure modules.
 */

import { err, ok, type Result } from "@/shared"
import { defaultNdjsonEncoder } from "./encoder"
import { createNdjsonRingBuffer, type NdjsonRingBuffer } from "./ring-buffer"
import type {
  NdjsonConfigError,
  NdjsonEncoder,
  NdjsonEvent,
  NdjsonSinkError,
  NdjsonSinkPort,
  RingBufferConfig,
} from "./types"

/** The DEFAULT-OFF sink. Every method is a deliberate no-op returning `ok()`.
 *  Shared singleton — it holds no state, so one instance is safe everywhere. */
export const NullNdjsonSink: NdjsonSinkPort = {
  emit(_event: NdjsonEvent): Result<void, NdjsonSinkError> {
    return ok(undefined)
  },
}

/** In-memory capturing sink for tests. Encodes + buffers each event through the
 *  SAME bounded ring buffer the production sink uses, so a test asserting
 *  overflow exercises the real policy. */
export interface CapturingNdjsonSink extends NdjsonSinkPort {
  /** Every line currently retained (post-overflow), in FIFO order. */
  lines(): string[]
  /** Count of lines dropped due to overflow (drop-oldest policy). */
  dropped(): number
  /** Count of events rejected because a reject-newest buffer was full. */
  rejected(): number
}

/** Build an in-memory capturing sink. `config` is REQUIRED — tests state the
 *  capacity + policy they want to exercise. Returns `Err` on invalid config
 *  (mirrors the production sink's construction contract). */
export const createCapturingNdjsonSink = (
  config: RingBufferConfig,
  encoder: NdjsonEncoder = defaultNdjsonEncoder,
): Result<CapturingNdjsonSink, NdjsonConfigError> => {
  const buf = createNdjsonRingBuffer(config)
  if (!buf.ok) return buf
  const ring: NdjsonRingBuffer = buf.value
  let rejected = 0
  return ok({
    emit(event: NdjsonEvent): Result<void, NdjsonSinkError> {
      const encoded = encoder.encode(event)
      if (!encoded.ok) return encoded
      const outcome = ring.offer(encoded.value)
      if (!outcome.accepted) {
        rejected += 1
        return err({ kind: "buffer-full", capacity: ring.capacity })
      }
      return ok(undefined)
    },
    lines(): string[] {
      // Non-destructive view: drain() empties the ring, so we drain-then-
      // restore in FIFO order to leave the buffer unchanged.
      return snapshot(ring)
    },
    dropped(): number {
      return ring.totalDropped()
    },
    rejected(): number {
      return rejected
    },
  })
}

/** Non-destructive snapshot: drain then restore. The ring buffer is FIFO; we
 *  re-offer in order so size + order are preserved. Safe because the test sink
 *  is single-threaded. */
const snapshot = (ring: NdjsonRingBuffer): string[] => {
  const out = ring.drain()
  for (const l of out) ring.offer(l)
  return out
}

/** Flush callback the composition-root adapter supplies. Receives drained
 *  lines in FIFO order. Best-effort — its return/throw does NOT propagate to
 *  the producer. */
export type NdjsonFlush = (lines: string[]) => void

/** Production-shaped pure sink core. `emit()` encodes + buffers; whenever the
 *  buffer reaches capacity (or on explicit {@link BufferedNdjsonSink.flush})
 *  the drained lines are handed to the injected `flush`. The HTTP/file adapter
 *  at the composition root provides `flush`; this slice stays plane-clean.
 *
 *  The flush trigger is "buffer is full after this offer" so the sink batches
 *  rather than syscalling per event, while the bound guarantees memory stays
 *  capped. Callers wanting time-based flush wrap this and call `flush()` on a
 *  timer they own (timers are an IO concern → composition root). */
export interface BufferedNdjsonSink extends NdjsonSinkPort {
  /** Drain whatever is buffered to the injected `flush` now. Idempotent on an
   *  empty buffer. Never throws (a throwing `flush` is swallowed). */
  flush(): void
  /** Buffered line count not yet flushed. */
  pending(): number
  /** Cumulative count of lines lost to drop-oldest overflow over this sink's
   *  lifetime. Mirrors {@link CapturingNdjsonSink.dropped} so loss is OBSERVABLE
   *  in production, not only in tests — an operator wiring the real HTTP/file
   *  adapter must be able to see "the firehose outran the consumer; N lines were
   *  dropped" (the introspection stream is best-effort, but the loss must not be
   *  silent). reject-newest never drops here; under that policy this stays 0 and
   *  rejections surface as `buffer-full` Errs to the producer instead. */
  dropped(): number
}

export const createBufferedNdjsonSink = (
  config: RingBufferConfig,
  flush: NdjsonFlush,
  encoder: NdjsonEncoder = defaultNdjsonEncoder,
): Result<BufferedNdjsonSink, NdjsonConfigError> => {
  const buf = createNdjsonRingBuffer(config)
  if (!buf.ok) return buf
  const ring: NdjsonRingBuffer = buf.value

  const doFlush = (): void => {
    const lines = ring.drain()
    if (lines.length === 0) return
    try {
      flush(lines)
    } catch {
      // Best-effort: an injected adapter that throws (socket closed mid-write)
      // must not crash the producer. The lines are lost — consistent with the
      // best-effort introspection contract (this is not an audit log).
    }
  }

  return ok({
    emit(event: NdjsonEvent): Result<void, NdjsonSinkError> {
      const encoded = encoder.encode(event)
      if (!encoded.ok) return encoded
      const outcome = ring.offer(encoded.value)
      // Flush when the buffer is at capacity so memory stays bounded and the
      // adapter sees batches. Under reject-newest a full buffer means the new
      // line was refused — flush to make room, then surface the rejection so
      // the caller knows THIS event did not land.
      if (ring.size() >= ring.capacity) {
        doFlush()
      }
      if (!outcome.accepted) {
        return err({ kind: "buffer-full", capacity: ring.capacity })
      }
      return ok(undefined)
    },
    flush(): void {
      doFlush()
    },
    pending(): number {
      return ring.size()
    },
    dropped(): number {
      return ring.totalDropped()
    },
  })
}
