/**
 * ADR-0144 / S6-Memory — MemoryTelemetryPort (inverted dependency).
 *
 * SSOT port for memory-slice telemetry emission. The `@/memory` slice cannot
 * (per RFC §3.1 layering — see `consolidate/constants.ts:53-64`) import from
 * `@/observability`; this port inverts that direction so a consolidator /
 * recall path can hand structured outcome counters + latencies to an injected
 * sink without ever knowing whether the sink is OTel, JSONL, Prometheus, or a
 * no-op test fake.
 *
 * Anti-leak invariant (★ load-bearing): the on-the-wire surface of this port
 * carries ONLY counts / latencies / outcome ENUMS. Memory entry text, score
 * values, ranking arrays, redacted patterns, and any other content-plane data
 * MUST NEVER cross this seam. Tests assert the field set is exactly the
 * allow-list below via runtime `Object.keys()` introspection — adding a
 * `content` / `score` / `entries` / `text` / `body` / `patterns` / `redacted`
 * field to any event interface is a structural regression caught at unit-test
 * time (see `tests/unit/memory-telemetry-port-hellgate.test.ts`).
 *
 * Default-OFF: nothing in the memory slice instantiates a port today. Wiring
 * is composed in the apps layer (consolidator hook + recall callers) and the
 * observability adapter (`@/observability/memory-telemetry`) is the only
 * production binding. With NO port injected, callers fall through the
 * optional-call branch and behavior is byte-identical to the pre-S6 path.
 */

/** Phase 1 (per-thread distill) terminal outcome enum.
 *
 *  - `stored`   — distill ran and a Stage1Output row was upserted.
 *  - `merged`   — Phase 2-side merge into an existing row (Wave B promotion).
 *  - `rejected` — promotion gate refused (e.g. outcome=fail, ADR-0131).
 *  - `skipped`  — `runPhase1` returned `kind:"skipped"` for any reason
 *                 (memoryMode disabled, turns_below_threshold, no_messages,
 *                 thread_id_empty). Reason granularity stays inside the
 *                 outcome model and is NEVER emitted via this port — only the
 *                 terminal bucket leaves the slice.
 *  - `error`    — `Phase1DistillError` or downstream throw.
 */
export type Phase1OutcomeKind = "stored" | "merged" | "rejected" | "skipped" | "error"

/** Phase 2 (global consolidator) terminal outcome enum.
 *
 *  - `incremental_ok` — incremental run produced a write.
 *  - `full_ok`        — INIT-mode full rebuild produced a write.
 *  - `no_op`          — `runPhase2` returned `kind:"skipped"` (incremental
 *                       with zero new entries).
 *  - `error`          — `Phase2ConsolidateError` / `MemoryWriteError` /
 *                       `WatermarkConflictError`.
 */
export type Phase2OutcomeKind = "incremental_ok" | "full_ok" | "no_op" | "error"

/** Phase 1 telemetry event — emitted at the END of every distill / skip /
 *  error branch. Numeric fields only. */
export interface Phase1TelemetryEvent {
  readonly outcome: Phase1OutcomeKind
  /** Real (non-meta) turn count of the source session — drives the
   *  MIN_TURN_THRESHOLD skip path and is useful as a histogram. */
  readonly turnsConsumed: number
  /** Wall-clock ms from runPhase1 entry to outcome resolution. */
  readonly latencyMs: number
  /** Optional total-input-tokens reading (when the Phase1Port reported it).
   *  Absent when the port did not expose usage. */
  readonly tokensIn?: number
  /** Optional total-output-tokens reading. */
  readonly tokensOut?: number
}

/** Phase 2 telemetry event — emitted at the END of every consolidate /
 *  skip / error branch. Numeric fields only. */
export interface Phase2TelemetryEvent {
  readonly outcome: Phase2OutcomeKind
  /** Stage1 entries the consolidator processed this run (the source-truth
   *  count; not the byte count of the resulting MEMORY.md). */
  readonly filesProcessed: number
  /** Wall-clock ms from runPhase2 entry to outcome resolution. */
  readonly latencyMs: number
  readonly tokensIn?: number
  readonly tokensOut?: number
}

/** Recall telemetry event — emitted at the END of every recall / rank call.
 *  INTENTIONALLY ABSENT: ranked-entry list, per-entry score, query text,
 *  query embedding, entry IDs. Only counts + latency leave the slice. */
export interface RecallTelemetryEvent {
  /** Number of entries returned by recall (post-rank, post-limit). */
  readonly hits: number
  /** Number of candidate entries the ranker scanned before filter/sort. */
  readonly totalScanned: number
  /** Wall-clock ms from recall entry to ranked-result resolution. */
  readonly latencyMs: number
}

/** Sink for memory-slice telemetry. Implementations MUST NOT throw —
 *  telemetry emission is best-effort and a sink fault MUST NOT crash the
 *  consolidator or the recall path. */
export interface MemoryTelemetryPort {
  recordPhase1(event: Phase1TelemetryEvent): void
  recordPhase2(event: Phase2TelemetryEvent): void
  recordRecall(event: RecallTelemetryEvent): void
}

/** No-op port — the structural Default-OFF binding. Used by tests and as the
 *  fallback when no production sink is wired. Frozen so a caller cannot
 *  silently swap the no-op methods. */
export const noopMemoryTelemetry: MemoryTelemetryPort = Object.freeze({
  recordPhase1: (_event: Phase1TelemetryEvent): void => {},
  recordPhase2: (_event: Phase2TelemetryEvent): void => {},
  recordRecall: (_event: RecallTelemetryEvent): void => {},
})

/** Runtime-enforced allow-list for {@link Phase1TelemetryEvent} keys. The
 *  hellgate test diffs every event the port receives against this set and
 *  fails on any extra key — this is the structural anti-leak gate. */
export const PHASE1_EVENT_ALLOWED_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(["outcome", "turnsConsumed", "latencyMs", "tokensIn", "tokensOut"]),
)

/** Allow-list for {@link Phase2TelemetryEvent} keys. */
export const PHASE2_EVENT_ALLOWED_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(["outcome", "filesProcessed", "latencyMs", "tokensIn", "tokensOut"]),
)

/** Allow-list for {@link RecallTelemetryEvent} keys. Notably ABSENT:
 *  `score`, `entries`, `content`, `text`, `body`, `patterns`, `redacted`. */
export const RECALL_EVENT_ALLOWED_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(["hits", "totalScanned", "latencyMs"]),
)

/** Structural forbidden-key set — the anti-leak invariant. ANY of these
 *  appearing on an event handed to the port is a regression. Tested at
 *  unit-test time against the allow-lists above (no overlap permitted). */
export const FORBIDDEN_TELEMETRY_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(["content", "score", "entries", "text", "body", "patterns", "redacted"]),
)
