/**
 * W3C hex-id mint (single source of truth).
 *
 * Produces a lowercase, per-byte zero-padded hex string of `byteCount` random
 * bytes — the W3C Trace Context id shape: 16 bytes → 32-hex traceId, 8 bytes →
 * 16-hex spanId. Consolidates four formerly-duplicated copies (the exporter
 * span sink, the OTel exporting tracer, the no-op tracer, and the agent
 * session-resources CONTEXT-only bridge).
 *
 * WHY W3C hex: predictable/short trace IDs collide and silently merge unrelated
 * traces on a collector, so ids MUST be crypto-strong and full-width. The
 * default `gen` uses the platform CSPRNG (`crypto.getRandomValues`, WebCrypto —
 * available globally on Bun + Node 20+). There is deliberately NO fallback: if
 * the global is missing we'd rather crash than emit predictable IDs.
 *
 * The `gen` seam lets deterministic tests (the hellgate) inject a fixed byte
 * source and assert exact ids ("0000…"/"0101…") — production callers just call
 * `hexId(16)` / `hexId(8)` for randomness.
 */
export const hexId = (
  byteCount: number,
  gen: (len: number) => Uint8Array = (len) => crypto.getRandomValues(new Uint8Array(len)),
): string => Array.from(gen(byteCount), (b) => b.toString(16).padStart(2, "0")).join("")
