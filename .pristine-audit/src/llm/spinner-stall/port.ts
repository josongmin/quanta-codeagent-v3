/**
 * ADR-0227 — Spinner stall detector port (Claude Code `tengu_spinner_stalled_ui`
 * absorption, B6).
 *
 * # What this is
 *
 * A closed port that decouples *deciding when an LLM stream has gone silent
 * mid-turn* from *reacting to that silence* (UI panel, telemetry, retry
 * prompt, etc.). The detector tracks per-correlation-id "last event seen at"
 * timestamps; callers tick on every model event (token, tool-use chunk, …)
 * and periodically poll {@link SpinnerStallDetectorPort.checkAll} to harvest
 * the set of correlations that have crossed their stall threshold.
 *
 * # Why this exists (gap vs ADR-0200)
 *
 * ADR-0200 (`src/llm/stream-timeout.ts` + `src/agent/stream-timeout/`) already
 * aborts a stream that goes idle past `idleMs`. But abort is a *destructive*
 * reaction. Claude Code's `tengu_spinner_stalled_ui` fires WELL BEFORE the
 * hard abort and lets the surface show a "still working… [r]etry / [a]bort"
 * panel — the user keeps the stream alive if they're willing to wait. We
 * have **no** signal between "chunk arrived" and "hard abort"; this slice
 * fills that gap with a default-30s soft signal that's strictly orthogonal
 * to the 120s hard idle timeout.
 *
 * # Design
 *
 * - **Pure book-keeping.** The detector NEVER emits anything itself. It
 *   tracks state and answers "which correlation ids are stalled right now?".
 *   The decision to emit a "spinner-stalled" event lives in the
 *   `event-emitter.ts` sibling, which is itself a port consumer.
 * - **Pull-based polling.** `checkAll(now)` is called by the loop / a timer
 *   in the orchestration plane. We deliberately do NOT keep our own
 *   `setInterval` — that would force every test to mock timers and would
 *   cross the plane boundary. Callers schedule polls; we answer purely.
 * - **Multi-correlation.** A single detector instance tracks N concurrent
 *   streams (parallel sub-agents, branch-search verifier-prover, etc.) by
 *   `correlationId`. Each id is independent — one stall does not affect
 *   the others.
 * - **Memory-safe.** `stop(id)` removes the entry. `checkAll` does NOT
 *   mutate the map — entries persist until explicitly stopped (so a
 *   stalled stream that recovers can re-tick without `start` having been
 *   called again, and so successive polls see the same stall until the
 *   caller acts). This matches Claude Code's behaviour: the spinner stays
 *   stalled-flagged until the user retries / aborts / a chunk arrives.
 *
 * # Closed-port contract
 *
 *  1. **`start(id, thresholdMs, now)`**: register a correlation. Idempotent —
 *     calling `start` twice for the same id resets `lastEventMs` to `now`
 *     and overwrites the threshold (so a knob change mid-stream takes
 *     effect on the next poll). The `now` parameter is the wall-clock ms
 *     at which the stream started; tests inject a virtual clock.
 *  2. **`tickEvent(id, now)`**: bump `lastEventMs` for the id. If the id
 *     is unknown (never started, or already stopped) this is a no-op (NOT
 *     an error) — the stream-timeout hook is best-effort and must not
 *     poison the producer on stale state.
 *  3. **`stop(id)`**: remove the id. Idempotent — calling `stop` on an
 *     unknown id is a no-op. After `stop`, the id never appears in
 *     `checkAll` again unless re-`start`ed.
 *  4. **`checkAll(now)`**: pure scan. Returns `{ correlationId, stalledForMs }`
 *     for every id whose `lastEventMs + thresholdMs < now`. Order is
 *     insertion-order (Map iteration semantics) so callers see a stable
 *     sequence across polls.
 *
 * # Default-OFF
 *
 * The detector itself is constructive; it allocates a Map and a clock
 * reference. But its EFFECT is gated by whether anyone calls `start`. The
 * stream-timeout wire (`src/llm/stream-timeout.ts`) only calls `tickEvent`
 * (no-op when nothing is registered), so a process that never builds an
 * emitter sees zero behavioural change — byte-identical to the pre-slice
 * world.
 *
 * # Plane-clean
 *
 * This file imports ONLY type primitives. No `@/agent`, no `@/tool`, no
 * `@/permission`. The clock seam is a function ref injected via the
 * detector constructor (see `default-detector.ts`).
 */

/** Surfaceable stall record. Emitted (via the emitter sibling) when a
 *  correlation's last event is older than its registered threshold.
 *
 *  `stalledForMs` is the *current* stall duration at the time of the
 *  polling call — not when the threshold was first crossed. So a stream
 *  that has been silent for 90s when polled at 90s reports `stalledForMs:
 *  90000`; the next poll at 95s reports `stalledForMs: 95000`. This lets
 *  the UI surface show a live "stalled for 1m 35s" counter without the
 *  detector having to track first-crossed-at separately. */
export interface StallEvent {
  /** The correlation id that has gone silent (matches the id passed to
   *  `start` / `tickEvent`). */
  readonly correlationId: string
  /** Wall-clock ms since the last `tickEvent` (or `start` if no tick has
   *  arrived). Always > the registered threshold. */
  readonly stalledForMs: number
}

/** Arguments for {@link SpinnerStallDetectorPort.start}. */
export interface StartArgs {
  readonly correlationId: string
  readonly stallThresholdMs: number
  readonly now: number
}

/** Arguments for {@link SpinnerStallDetectorPort.tickEvent}. */
export interface TickEventArgs {
  readonly correlationId: string
  readonly now: number
}

/** Arguments for {@link SpinnerStallDetectorPort.stop}. */
export interface StopArgs {
  readonly correlationId: string
}

/** Arguments for {@link SpinnerStallDetectorPort.checkAll}. */
export interface CheckAllArgs {
  readonly now: number
}

/** The detector port. Pure book-keeping — never throws, never IO. */
export interface SpinnerStallDetectorPort {
  /** Register a correlation id for stall tracking. Idempotent; re-`start`
   *  resets `lastEventMs = now` and overwrites the threshold. */
  start(args: StartArgs): void
  /** Record a model event arrival for `correlationId`. Unknown id ⇒
   *  no-op. */
  tickEvent(args: TickEventArgs): void
  /** Remove `correlationId` from tracking. Unknown id ⇒ no-op. */
  stop(args: StopArgs): void
  /** Scan all tracked ids and return those whose `lastEventMs +
   *  thresholdMs < now`. Pure — does not mutate state. */
  checkAll(args: CheckAllArgs): readonly StallEvent[]
}
