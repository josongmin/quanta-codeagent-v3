/**
 * Headless (in-memory) inline-trigger watcher (ADR-0250).
 *
 * Deterministic stand-in for the `fs.watch`-backed adapter. Lets tests
 * + headless CI rigs drive the same `InlineTriggerWatcher` port shape
 * without binding a real OS file-system watcher.
 *
 * The stub:
 *   - Records every active subscription's (markers, callback, debouncer).
 *   - Exposes a `fire(file, content)` helper that simulates a saved
 *     file under any watched root. Per active subscription, the body
 *     is scanned (`./comment-scanner.ts`) and the debounced callback
 *     fires for every marker hit.
 *   - Validates roots the same way the real adapter does — any missing
 *     root returns a typed `root-missing` (HELL-IT-13 pins parity).
 *   - The `unsubscribe()` handle clears that sub's debouncer (so
 *     HELL-IT-15's no-leak invariant holds in headless too).
 *
 * The stub does NOT touch disk. The hellgate uses it for cases where
 * a real fs.watch would be flaky (timing-sensitive debounce assertions,
 * binary-file skipping, performance sanity).
 */

import { scanFile } from "./comment-scanner"
import { createDebouncer, type Debouncer } from "./debouncer"
import type { InlineTriggerWatcher, Subscription, TriggerCallback, WatchResult } from "./port"
import { DEFAULT_DEBOUNCE_MS } from "./types"

interface Active {
  readonly roots: readonly string[]
  readonly markers: readonly string[]
  readonly callback: TriggerCallback
  readonly debouncer: Debouncer
  stopped: boolean
}

export interface HeadlessInlineTriggerWatcher extends InlineTriggerWatcher {
  /**
   * Simulate a saved file with the given absolute path + UTF-8 body.
   * For every active subscription, the body is scanned and the
   * debounced callback fires per marker hit.
   *
   * Returns the number of (sub × marker) pairs that fired (before
   * debounce) — useful for test assertions.
   */
  readonly fire: (file: string, content: string) => number
  /** Number of non-stopped subscriptions (test introspection). */
  readonly activeCount: () => number
  /** Sum of pending debounced actions across all subs (leak check). */
  readonly pendingCount: () => number
}

/**
 * Validate a root list. The stub treats roots whose path STARTS WITH
 * `/missing/` as missing — that lets tests assert the parity branch
 * without `existsSync` calls (which would be non-deterministic). All
 * other roots are accepted.
 *
 * The convention is documented + opt-in via path prefix to keep the
 * stub small. Tests that want to exercise real-fs missing-root semantics
 * use the production adapter (HELL-IT-10).
 */
const headlessCheckRoot = (root: string): { kind: "root-missing"; root: string } | null => {
  if (root.startsWith("/missing/")) return { kind: "root-missing", root }
  return null
}

export const createHeadlessInlineTrigger = (): HeadlessInlineTriggerWatcher => {
  const subs: Active[] = []

  const watch = (
    roots: readonly string[],
    markers: readonly string[],
    callback: TriggerCallback,
    debounceMs?: number,
  ): WatchResult => {
    for (const root of roots) {
      const err = headlessCheckRoot(root)
      if (err !== null) return { ok: false, error: err }
    }

    const sub: Active = {
      roots,
      markers,
      callback,
      debouncer: createDebouncer(debounceMs ?? DEFAULT_DEBOUNCE_MS),
      stopped: false,
    }
    subs.push(sub)

    const subscription: Subscription = {
      unsubscribe: () => {
        if (sub.stopped) return
        sub.stopped = true
        sub.debouncer.cancelAll()
      },
    }
    return { ok: true, subscription }
  }

  const fire = (file: string, content: string): number => {
    let count = 0
    for (const sub of subs) {
      if (sub.stopped) continue
      // Same binary-skip heuristic as the real adapter — HELL-IT-11
      // covers this branch via the headless stub.
      if (content.includes("\0")) continue
      const events = scanFile(file, content, sub.markers)
      if (events.length === 0) continue
      sub.debouncer.schedule(file, () => {
        if (sub.stopped) return
        for (const ev of events) {
          if (sub.stopped) return
          sub.callback(ev)
        }
      })
      count += events.length
    }
    return count
  }

  return {
    watch,
    fire,
    activeCount: () => subs.filter((s) => !s.stopped).length,
    pendingCount: () => subs.reduce((acc, s) => acc + s.debouncer.pendingCount(), 0),
  }
}
