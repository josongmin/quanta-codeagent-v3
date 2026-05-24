/**
 * ADR-0200 — Closed port for the stream timeout watchdog.
 *
 * Wraps an async iterable with idle + total wall-clock guards. The
 * default impl lives in `./default-watchdog.ts`; the no-op fallback
 * lives in `./no-op-watchdog.ts`. Both honour the same contract:
 *
 *  - `policy` undefined OR both `idleMs`/`totalMs` undefined ⇒
 *    strict pass-through (consumer sees the source iterator verbatim).
 *  - `signal?.aborted` at any point ⇒ {@link StreamAbortError}.
 *  - `policy.snooze?.isPaused()` ⇒ idle counter parked (total NOT paused).
 *  - source `next()` called AT MOST once per yielded event (no
 *    double-pull on a slow source).
 *
 * Plane-clean: imports types-only siblings.
 */

import type { TimeoutPolicy } from "./types"

export interface StreamWatchdog {
  wrap<T>(src: AsyncIterable<T>, policy?: TimeoutPolicy, signal?: AbortSignal): AsyncIterable<T>
}
