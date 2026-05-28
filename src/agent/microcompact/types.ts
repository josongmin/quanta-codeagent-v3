/**
 * ADR-0409 — Microcompact port (partial-drop alternative to full compaction).
 *
 * Full compaction (`compactIfNeeded`) summarizes the entire prefix into one
 * synthetic user message — useful when the transcript is huge but the recent
 * work is still relevant. The COST is that everything older than the suffix
 * becomes a single opaque sentence: structure, file paths, tool outputs all
 * collapse together.
 *
 * Microcompact is the surgical alternative: drop the *oldest* N% of messages
 * verbatim, preserve the system prompt + the last K turns verbatim, and emit
 * a {@link RecoveryProvenance} record with `reason:"microcompact"` so the
 * host can attribute the drop in the Objective / observability stream.
 *
 * Default-OFF: nobody wires this port today. ADR-0409 SHIPS the slice +
 * factory + hellgate — wiring it into the loop is a follow-up. The slice is
 * a leaf and stays unimported by any non-test peer.
 *
 * Slice fence: imports ONLY from `@/agent/recovery-reason` (sibling leaf type)
 * — NO `@/agent/loop`, NO `@/agent/dispatch`, NO `@/agent/compaction.ts`. The
 * dependency is inverted (compaction.ts CONSUMES this port; this port does
 * not know compaction.ts exists).
 */

import type { RecoveryProvenance } from "@/agent/recovery-reason"

/** Caller's request to drop the oldest N% of the transcript.
 *
 *  Defaults pinned by hellgate:
 *  - `dropRatio` default = 0.25 (drop oldest 25%).
 *  - `preserveSystem` default = true (system-role messages never drop).
 *  - `preserveRecentTurns` default = 6 (the last 6 messages always survive,
 *    matching `compaction.ts#DEFAULT_KEEP_TURNS`).
 *
 *  `tokenEstimate` is OPTIONAL — when provided, used as the `tokensBefore`
 *  field of the emitted provenance; when absent, the compactor derives a
 *  chars/4 estimate via its own bounded walk (no `@/llm` import). */
export interface MicroCompactInput {
  readonly messages: readonly { role: string; content: unknown }[]
  readonly threadId: string
  readonly tokenEstimate?: number
  /** 0..1; default 0.25 = drop oldest 25%. Values outside [0,1] clamp to
   *  [0,1] (NO-THROW). */
  readonly dropRatio?: number
  /** default true — `role:"system"` messages NEVER drop. */
  readonly preserveSystem?: boolean
  /** default 6 — the last N messages are always retained regardless of
   *  `dropRatio`. */
  readonly preserveRecentTurns?: number
}

/** Result of {@link MicroCompactPort.compact}. `provenance.reason` is always
 *  `"microcompact"`. When `turnsDropped === 0` (a no-op compaction —
 *  malformed input, ratio=0, or the protected suffix already covers the
 *  whole transcript), `messages` is the input array unchanged + provenance
 *  records the no-op so the consumer can emit it for observability. */
export interface MicroCompactResult {
  readonly messages: readonly { role: string; content: unknown }[]
  readonly turnsDropped: number
  readonly turnsKept: number
  readonly provenance: RecoveryProvenance
}

/** Closed port. ONE method, NO-THROW: malformed input ⇒ returns the input
 *  unchanged with `turnsDropped:0` and `reason:"microcompact"` provenance. */
export interface MicroCompactPort {
  compact(input: MicroCompactInput): MicroCompactResult
}

/** Construction opts for {@link createMicroCompactor}. `now` is an injected
 *  clock seam (default `Date.now`) so hellgate can pin `compactedAt` to a
 *  fixed value without mocking `globalThis.Date`. */
export interface MicroCompactorOpts {
  readonly now?: () => number
}
