import type { ToolResult } from "../types"
import type { DeferredResultRegistry, DeferredWork } from "./port"
import type { DeferredError, DeferredHandle, Status } from "./types"

/**
 * ADR-0286 — default in-memory production registry implementing the closed
 * `DeferredResultRegistry` port.
 *
 * Design invariants (every one is locked by a hellgate case):
 *
 *  1. **Each handle owns one AbortController.** `cancel(handle)` aborts it;
 *     the worker receives the signal in its argument and is expected to
 *     cooperate. The registry itself does NOT race a cancel against a
 *     completion — it commits whichever transition lands first.
 *  2. **Microtask scheduling.** `register()` schedules the worker on a
 *     `queueMicrotask` boundary so the caller's tick observes a `pending`
 *     status before any worker code runs. The worker then moves the handle
 *     to `running` BEFORE awaiting any I/O so a `poll()` between schedule
 *     and first-await sees the correct intermediate state.
 *  3. **LRU eviction.** When the live-handle count exceeds the configured
 *     cap (default 1000), the OLDEST non-`pending`/non-`running` entry is
 *     dropped. Pending/running entries are NEVER evicted (would lose the
 *     worker's eventual result with no recovery channel). When every live
 *     entry is pending/running we accept the over-cap state and emit no
 *     handles — the cap is a soft ceiling on COMPLETED entries.
 *  4. **`poll()` is total.** Unknown handle returns a synthetic
 *     `failed`/`unknown-handle` status, never throws. An evicted entry
 *     returns `failed`/`handle-evicted` (carried in an eviction-marker map).
 *  5. **`await()` is total.** Same posture — uses `poll()` first; if not
 *     terminal, attaches a per-handle waiter that fires on the next
 *     transition. `timeoutMs` is enforced via a SHARED timer the waiter
 *     races; on timeout the worker is NOT cancelled (caller may re-await).
 *  6. **No zombie Promise.** Awaiters are detached on every terminal
 *     transition AND on timeout (the timer's callback removes its own
 *     entry). A failed/cancelled/completed handle has zero waiters left.
 *  7. **Default-OFF.** The registry is a leaf module; nothing imports it
 *     from a composition root by default. The agent only constructs one
 *     when `runtimeConfig().asyncTools === true`.
 */

/** Optional construction options (cap exposed for tests + the
 *  `QUANTA_DEFERRED_CAP` env knob). Defaults: 1000 handles. */
export interface DefaultRegistryOptions {
  readonly cap?: number
}

/** Default cap if the caller does not override it. */
export const DEFAULT_DEFERRED_CAP = 1000

interface Entry {
  readonly handle: DeferredHandle
  status: Status
  readonly controller: AbortController
  /** Waiters resolved on the next terminal transition. */
  readonly waiters: Array<(s: Status) => void>
}

/** ADR-0286 default in-memory implementation. */
export class DefaultDeferredResultRegistry implements DeferredResultRegistry {
  readonly #entries = new Map<string, Entry>()
  /** Once an entry is evicted by the LRU cap, we keep a tombstone here so a
   *  later `poll()` against that id returns the `handle-evicted` reason
   *  instead of `unknown-handle`. The map is itself bounded by the cap to
   *  avoid unbounded growth across long sessions. */
  readonly #evicted = new Set<string>()
  readonly #cap: number
  #seq = 0

  constructor(opts: DefaultRegistryOptions = {}) {
    const rawCap = opts.cap ?? DEFAULT_DEFERRED_CAP
    // Defensive: a non-positive cap would deadlock LRU (eviction loop never
    // finds room). Clamp to 1 so the registry stays usable for the test seam.
    this.#cap = rawCap > 0 ? rawCap : 1
  }

  register(work: DeferredWork): DeferredHandle {
    this.#seq += 1
    const handle: DeferredHandle = {
      id: `deferred-${this.#seq}`,
      createdAt: Date.now(),
    }
    const controller = new AbortController()
    const entry: Entry = {
      handle,
      status: { kind: "pending" },
      controller,
      waiters: [],
    }
    this.#entries.set(handle.id, entry)
    // LRU enforcement BEFORE scheduling so a back-pressure burst can't grow
    // unbounded inside the same tick.
    this.#enforceCap()
    // Schedule the worker on a microtask so the caller's tick observes the
    // `pending` status (invariant #2).
    queueMicrotask(() => {
      // The entry may have been cancelled BETWEEN register() and this
      // microtask — honor cancel without ever starting the work.
      if (entry.controller.signal.aborted) {
        this.#transition(entry, { kind: "cancelled", error: { kind: "cancelled" } })
        return
      }
      this.#transition(entry, { kind: "running" })
      // Run the worker. We do NOT pass a Promise.race against the
      // controller's signal here — that would synthesize a completion the
      // worker doesn't know about. The worker honors the signal; we observe
      // whichever transition happens first.
      const promise = (async (): Promise<ToolResult> => work(controller.signal))()
      promise.then(
        (result) => {
          // The worker resolved. If a cancel already committed a `cancelled`
          // status, the late resolve overwrites it per spec invariant #1 —
          // we use a single transition path that does not branch on the
          // current status (last writer wins). This is observable and
          // tested in the hellgate (cancel then late-resolve → completed).
          this.#transition(entry, { kind: "completed", result })
        },
        (err: unknown) => {
          // Distinguish abort-triggered throws from real worker throws so
          // the surfaced reason matches what the caller did. AbortError per
          // DOM-spec sets `name === "AbortError"`; Node also uses
          // `code === "ABORT_ERR"`.
          if (controller.signal.aborted) {
            this.#transition(entry, { kind: "cancelled", error: { kind: "cancelled" } })
            return
          }
          const message =
            err instanceof Error ? err.message : typeof err === "string" ? err : String(err)
          this.#transition(entry, {
            kind: "failed",
            error: { kind: "worker-threw", message },
          })
        },
      )
    })
    return handle
  }

  poll(handle: DeferredHandle): Status {
    const entry = this.#entries.get(handle.id)
    if (entry === undefined) {
      if (this.#evicted.has(handle.id)) {
        return {
          kind: "failed",
          error: { kind: "handle-evicted", id: handle.id },
        }
      }
      return {
        kind: "failed",
        error: { kind: "unknown-handle", id: handle.id },
      }
    }
    return entry.status
  }

  async await(handle: DeferredHandle, timeoutMs?: number): Promise<Status> {
    const initial = this.poll(handle)
    if (isTerminal(initial)) return initial
    const entry = this.#entries.get(handle.id)
    if (entry === undefined) {
      // Could only happen if the entry was evicted between poll() and here
      // — return the same handle-evicted classification the poll path uses.
      return {
        kind: "failed",
        error: { kind: "handle-evicted", id: handle.id },
      }
    }
    return new Promise<Status>((resolve) => {
      let settled = false
      const waiter = (s: Status): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(s)
      }
      entry.waiters.push(waiter)
      const timer: ReturnType<typeof setTimeout> | undefined =
        typeof timeoutMs === "number" && timeoutMs >= 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              // Detach this waiter so a later genuine transition does not
              // double-resolve (invariant #6 — no zombie Promise).
              const ix = entry.waiters.indexOf(waiter)
              if (ix >= 0) entry.waiters.splice(ix, 1)
              const err: DeferredError = { kind: "await-timeout", timeoutMs }
              resolve({ kind: "failed", error: err })
            }, timeoutMs)
          : undefined
    })
  }

  cancel(handle: DeferredHandle): void {
    const entry = this.#entries.get(handle.id)
    if (entry === undefined) return
    // Abort the per-handle controller; the worker's then/catch handler will
    // commit the `cancelled` transition (or the late resolve will overwrite
    // it per invariant #1). If the worker hasn't started yet, the microtask
    // observes the abort before invoking work() and commits immediately.
    if (!entry.controller.signal.aborted) entry.controller.abort()
    // If the worker is already past the microtask boundary but hasn't
    // settled yet (e.g. awaiting an I/O the signal can't interrupt), we
    // proactively commit a `cancelled` status so synchronous `poll()` after
    // `cancel()` reflects the cancel intent — the late resolve will
    // overwrite if the worker eventually returns a result.
    if (entry.status.kind === "pending" || entry.status.kind === "running") {
      this.#transition(entry, { kind: "cancelled", error: { kind: "cancelled" } })
    }
  }

  list(): readonly DeferredHandle[] {
    return [...this.#entries.values()].map((e) => e.handle)
  }

  #transition(entry: Entry, next: Status): void {
    entry.status = next
    if (!isTerminal(next)) return
    // Drain waiters under a copy — a waiter callback could theoretically
    // call back into the registry; the spec disallows that but we still
    // protect the iteration.
    const waiters = entry.waiters.splice(0)
    for (const w of waiters) {
      try {
        w(next)
      } catch {
        // Waiter errors must never escape the registry (would break the
        // dispatch promise chain). Swallow + continue.
      }
    }
  }

  #enforceCap(): void {
    if (this.#entries.size <= this.#cap) return
    // Walk entries in insertion order (Map preserves it) and evict the FIRST
    // non-pending/non-running one we find. Pending/running are never evicted
    // — that would orphan a worker's eventual result.
    for (const [id, entry] of this.#entries) {
      if (entry.status.kind === "pending" || entry.status.kind === "running") continue
      this.#entries.delete(id)
      this.#evicted.add(id)
      // Bound the evicted-marker set so a long session never grows it
      // unbounded. We keep at most `cap` markers — same ceiling as live
      // entries — by dropping the OLDEST marker when over.
      if (this.#evicted.size > this.#cap) {
        const first = this.#evicted.values().next().value
        if (first !== undefined) this.#evicted.delete(first)
      }
      return
    }
    // Every live entry is pending/running — we have NO non-terminal entry
    // to evict. Accept the over-cap state silently rather than dropping a
    // worker mid-flight.
  }
}

const isTerminal = (s: Status): boolean =>
  s.kind === "completed" || s.kind === "failed" || s.kind === "cancelled"
