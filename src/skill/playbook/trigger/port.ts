/**
 * Closed port for the inline-trigger sub-slice (ADR-0250).
 *
 * The port has ONE method (`watch`) and one nested handle type
 * (`Subscription`). Keeping it minimal is intentional — every additional
 * method is one more thing test rigs must mock. The headless-stub and
 * the `fs.watch` adapter both implement this shape and nothing more.
 *
 * Composition contract:
 *
 *   1. Host calls `watcher.watch(roots, markers, callback)`.
 *   2. Adapter installs a per-root file-system observer. On every
 *      saved file under any root, it scans the file's UTF-8 body for
 *      any of `markers`. For every marker hit, `callback(event)` fires
 *      with the absolute path and 1-based line number.
 *   3. Same-file fires within `debounceMs` are coalesced to ONE call
 *      (HELL-IT-07).
 *   4. Host calls `subscription.unsubscribe()` to release resources.
 *      All in-flight debounce timers are cleared (HELL-IT-15) and no
 *      further callbacks fire (HELL-IT-08).
 *
 * The port returns a typed `WatchResult` rather than throwing on
 * fs-level errors so the host can render a precise reason (e.g. a
 * missing root vs an EMFILE).
 */

import type { TriggerError, TriggerEvent } from "./types"

/** Callback invoked once per debounced marker hit. */
export type TriggerCallback = (event: TriggerEvent) => void

/**
 * Handle returned by a successful `watch()` call.
 *
 * `unsubscribe` is idempotent — calling it twice is a no-op. After it
 * returns, no further callback fires for any pending in-flight event,
 * and all debounce timers are cleared (no leaked node `Timeout`s).
 */
export interface Subscription {
  readonly unsubscribe: () => void
}

/** Result of a `watch()` invocation — typed so failure has a reason. */
export type WatchResult =
  | { readonly ok: true; readonly subscription: Subscription }
  | { readonly ok: false; readonly error: TriggerError }

/**
 * The watch primitive.
 *
 * `roots` is a list of absolute directory paths to watch RECURSIVELY.
 * `markers` is a list of literal substrings the scanner searches for in
 * any line of any saved file under any root. `callback` is invoked
 * once per (file, marker) pair that fires (post-debounce).
 *
 * Optional `debounceMs` overrides the default coalescing window
 * (see `types.ts: DEFAULT_DEBOUNCE_MS`). A value of 0 disables
 * debouncing (every fs.watch event is scanned).
 */
export interface InlineTriggerWatcher {
  readonly watch: (
    roots: readonly string[],
    markers: readonly string[],
    callback: TriggerCallback,
    debounceMs?: number,
  ) => WatchResult
}

export type { TriggerError, TriggerEvent } from "./types"
/** Re-export so consumers only import from `./port`. */
export type { TriggerCallback as InlineTriggerCallback }
