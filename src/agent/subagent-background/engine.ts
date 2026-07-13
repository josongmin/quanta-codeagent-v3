/**
 * Engine builder for {@link defaultBackgroundSubagentScheduler} — the closed-over
 * mutable state (`store` Map) plus the lifecycle behavior, decomposed out of the
 * god-factory. Behavior-preserving: the only closures that REMAIN closures are
 * the mutually-recursive run triad (`promote → startRun → drainQueue → promote`)
 * which must capture `runner` + each other by reference; every leaf helper is a
 * module-level pure function taking the `store` / config explicitly.
 *
 * The returned {@link SchedulerEngine} is the public-facing slice the
 * `methods.ts` helpers consume.
 */

import { randomBytes } from "node:crypto"
import { errMessage } from "@/shared"
import type { SubagentResult as SliceRunnerOutcome, SubagentRunner } from "@/subagent"
import {
  type BackgroundSubagentSchedulerOpts,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_RETAINED,
  type Entry,
  isTerminal,
  oneLine,
  restoreHandles,
  SubagentBackgroundError,
  type SubagentHandleId,
  specToRequest,
} from "../subagent-background"

type Store = Map<SubagentHandleId, Entry>

/** The closed-over state + behavior the returned scheduler methods consume.
 *  Bundled so each method becomes a pure function of `(engine, ...args)`. The
 *  `store` Map and the closures are shared BY REFERENCE with the factory. */
export interface SchedulerEngine {
  readonly store: Store
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly admissionQueue: boolean
  readonly now: () => number
  readonly idGen: () => string
  readonly countRunning: () => number
  readonly countQueued: () => number
  readonly startRun: (entry: Entry) => Promise<void>
  readonly promote: (entry: Entry) => void
  readonly moveToFront: (targetId: SubagentHandleId) => void
  readonly awaitTerminal: (entry: Entry) => Promise<void>
  readonly awaitTerminalOrAbort: (entry: Entry, signal: AbortSignal) => Promise<void>
  readonly restoreHandles: (
    json: string,
    store: Store,
    now: () => number,
    maxAgeMs: number | undefined,
  ) => number
  /** Factory for the typed cap/queue error — injected so the methods module
   *  stays free of the class' construction site quirks. */
  readonly makeError: (
    code: "cap-exceeded" | "queue-full",
    message: string,
  ) => SubagentBackgroundError
}

const countRunning = (store: Store): number => {
  let n = 0
  for (const e of store.values()) if (e.result.status === "running") n += 1
  return n
}

/** Count `queued` (parked, not-yet-started) entries — only these count against
 *  `maxQueued`. */
const countQueued = (store: Store): number => {
  let n = 0
  for (const e of store.values()) if (e.result.status === "queued") n += 1
  return n
}

/** Count TERMINAL entries — only these count against `maxRetained`. */
const countTerminal = (store: Store): number => {
  let n = 0
  for (const e of store.values()) if (isTerminal(e.result.status)) n += 1
  return n
}

/** Find the oldest (insertion-order first) TERMINAL handle in the store, or
 *  undefined if none. Used by LRU eviction. */
const findOldestTerminalKey = (store: Store): SubagentHandleId | undefined => {
  for (const [k, e] of store.entries()) {
    if (isTerminal(e.result.status)) return k
  }
  return undefined
}

/** Find the FIRST (insertion-order = FIFO) `queued` entry, or undefined.
 *  `force_background`'s `moved_to_front` re-orders an entry to the head of this
 *  FIFO so it is the one this returns next. */
const firstQueuedEntry = (store: Store): Entry | undefined => {
  for (const e of store.values()) if (e.result.status === "queued") return e
  return undefined
}

/** LRU drop of TERMINAL entries when the retained cap is exceeded. Running
 *  entries are skipped — they have an in-flight promise the caller may still
 *  await; auto-dropping them would corrupt the await surface. */
const evictIfOver = (store: Store, maxRetained: number): void => {
  let terminalCount = countTerminal(store)
  while (terminalCount > maxRetained) {
    const oldestKey = findOldestTerminalKey(store)
    if (oldestKey === undefined) break
    store.delete(oldestKey)
    terminalCount -= 1
  }
}

/** Move a `queued` entry to the FIFO HEAD (it becomes `firstQueuedEntry`).
 *  Re-inserts at the front by rebuilding the Map preserving order with the
 *  target first. Strictly last-forcer-wins-the-head (LIFO at head) so a
 *  `moved_to_front` storm cannot livelock (R4). */
const moveToFront = (store: Store, targetId: SubagentHandleId): void => {
  const target = store.get(targetId)
  if (target === undefined) return
  const rest: Array<[SubagentHandleId, Entry]> = []
  for (const [k, e] of store.entries()) {
    if (k !== targetId) rest.push([k, e])
  }
  store.clear()
  store.set(targetId, target)
  for (const [k, e] of rest) store.set(k, e)
}

/** Apply a successful runner outcome to the entry. Honors cancel-race (cancel()
 *  may have flipped status to "cancelled" while runner was in-flight; that
 *  intent wins). */
const applyRunnerSuccess = (entry: Entry, out: SliceRunnerOutcome, now: () => number): void => {
  if (entry.result.status === "cancelled") return
  const finalText = out.finalText ?? ""
  entry.result.status = out.ok ? "completed" : "failed"
  entry.result.outputSummary = oneLine(finalText) || (out.ok ? "(completed)" : "(failed)")
  entry.result.outputDetail = finalText
  entry.result.turns = out.turns
  entry.result.endedAt = now()
  if (!out.ok) {
    entry.result.errorMessage = finalText || "subagent reported ok=false"
  }
}

/** Apply a runner failure (throw) to the entry. Differentiates 3 cases:
 *  already-cancelled (keep cancelled posture), abort-driven (→ cancelled), and
 *  genuine error (→ failed). */
const applyRunnerFailure = (entry: Entry, e: unknown, now: () => number): void => {
  if (entry.result.status === "cancelled") return
  const msg = errMessage(e)
  if (entry.abortCtrl.signal.aborted) {
    entry.result.status = "cancelled"
    entry.result.outputSummary = "(cancelled)"
    entry.result.errorMessage = msg
    entry.result.endedAt = now()
    return
  }
  entry.result.status = "failed"
  entry.result.outputSummary = `(failed) ${oneLine(msg)}`
  entry.result.errorMessage = msg
  entry.result.endedAt = now()
}

/** Block until `entry` reaches a terminal state. A `queued` entry's `promise`
 *  is a synchronous placeholder; `promote()` swaps in the real runner promise,
 *  so re-read it each pass. A MACROTASK yield (never a microtask) between passes
 *  lets timers / `drainQueue` / runner-IO make progress — a microtask spin would
 *  starve the loop on a queued-forever entry. */
const awaitTerminal = async (entry: Entry, yieldMacrotask: () => Promise<void>): Promise<void> => {
  while (!isTerminal(entry.result.status)) {
    await entry.promise
    if (isTerminal(entry.result.status)) break
    await yieldMacrotask()
  }
}

/** One abort-vs-promise race pass: resolve when the live `entry.promise` settles
 *  OR the signal aborts, cleaning up the listener either way. */
const raceAbortOrSettle = (entry: Entry, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
    // Runner never rejects (startRun catches); the rejection arm is defense in
    // depth so a stray rejection still unblocks the await.
    entry.promise.then(onAbort, onAbort)
  })

/** Block until terminal OR the await-signal aborts. Loops so a `queued`
 *  placeholder settle does not return the parked snapshot before promotion. */
const awaitTerminalOrAbort = async (
  entry: Entry,
  signal: AbortSignal,
  yieldMacrotask: () => Promise<void>,
): Promise<void> => {
  while (!isTerminal(entry.result.status) && !signal.aborted) {
    await raceAbortOrSettle(entry, signal)
    if (isTerminal(entry.result.status) || signal.aborted) break
    await yieldMacrotask()
  }
}

/** Resolved config + injected deps shared by the recursive run triad. */
interface RunCtx {
  readonly store: Store
  readonly runner: SubagentRunner
  readonly maxConcurrent: number
  readonly maxRetained: number
  readonly now: () => number
  /** Depth of the parent agent (0 = root). Every forked child's `req.depth` is
   *  `parentDepth + 1` (Phase 0-a, jul-13 nesting-control RFC §6.5). */
  readonly parentDepth: number
}

/** The mutually-recursive run triad (`promote → startRun → drainQueue →
 *  promote`). Kept as closures because they reference `ctx` AND each other; the
 *  graph is wired in a single object so each can call the others by reference. */
interface RunTriad {
  readonly startRun: (entry: Entry) => Promise<void>
  readonly promote: (entry: Entry) => void
}

const buildRunTriad = (ctx: RunCtx): RunTriad => {
  const { store, runner, maxConcurrent, maxRetained, now, parentDepth } = ctx

  /** Promote a `queued` entry into a `running` one — the deferred half of
   *  `fork`'s body. Flips status, wires the real runner promise in place of the
   *  placeholder, and re-stamps `startedAt` to the actual start time. */
  const promote = (entry: Entry): void => {
    entry.result.status = "running"
    entry.result.startedAt = now()
    const realPromise = startRun(entry)
    ;(entry as { promise: Promise<void> }).promise = realPromise
  }

  /** Auto-drain the FIFO when a slot frees: while there is a free slot and a
   *  `queued` entry, promote the OLDEST queued entry. Runs from `startRun`'s
   *  `finally` after `evictIfOver` — the EXACT point a slot frees. No-op when
   *  the queue is off (nothing is queued). */
  const drainQueue = (): void => {
    while (countRunning(store) < maxConcurrent) {
      const next = firstQueuedEntry(store)
      if (next === undefined) break
      promote(next)
    }
  }

  /** Start the actual run via the injected runner. Resolves the entry's promise
   *  once the runner settles OR the abort fires. Never rejects: every failure
   *  path mutates `entry.result` and resolves cleanly. */
  const startRun = (entry: Entry): Promise<void> => {
    return (async (): Promise<void> => {
      try {
        const req = specToRequest(entry.spec, entry.abortCtrl.signal, parentDepth)
        const out = await runner(req)
        applyRunnerSuccess(entry, out, now)
      } catch (e) {
        applyRunnerFailure(entry, e, now)
      } finally {
        evictIfOver(store, maxRetained)
        // ADR-0487 — a slot just freed; pull the next FIFO waiter (if any).
        // No-op when the admission queue is off (nothing is ever `queued`).
        drainQueue()
      }
    })()
  }

  return { startRun, promote }
}

/** Build the engine: resolve the injected config defaults, allocate the store
 *  Map, wire the recursive run triad, and bind the leaf helpers to the store.
 *  Auto-hydrates from `opts.hydrateFrom` BEFORE returning (matching the inline
 *  factory order). */
export const createEngine = (opts: BackgroundSubagentSchedulerOpts): SchedulerEngine => {
  const runner = opts.runner
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))
  const maxRetained = Math.max(1, Math.floor(opts.maxRetained ?? DEFAULT_MAX_RETAINED))
  const now = opts.now ?? Date.now
  const idGen = opts.idGen ?? ((): string => randomBytes(8).toString("hex"))
  // Phase 0-a (jul-13 nesting-control RFC §6.5): the parent's depth (0 = root).
  // Every child forked here runs at `parentDepth + 1` — reviving the runner's
  // `req.depth > maxDepth` reject that the prior hardcoded `depth: 0` never hit.
  const parentDepth = Math.max(0, Math.floor(opts.parentDepth ?? 0))
  // MACROTASK yield (not microtask): lets timers/IO run while await() spins on a
  // still-`queued` entry whose placeholder promise settles synchronously.
  const yieldMacrotask =
    opts.yieldMacrotask ??
    ((): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      }))
  // ADR-0487 — admission queue. Default-OFF: when `admissionQueue` is absent the
  // queue is unreachable (no `queued` entry can be created) and the scheduler is
  // byte-identical to its pre-queue self.
  const admissionQueue = opts.admissionQueue === true
  const maxQueued = Math.max(1, Math.floor(opts.maxQueued ?? DEFAULT_MAX_QUEUED))

  // Insertion-order Map — preserves a stable LRU order. Newest-end = latest
  // fork; oldest-front = first eviction candidate.
  const store: Store = new Map()

  const { startRun, promote } = buildRunTriad({
    store,
    runner,
    maxConcurrent,
    maxRetained,
    now,
    parentDepth,
  })

  // Auto-hydrate at construction (ADR-0153). When `opts.hydrateFrom` is present,
  // populate `store` BEFORE the scheduler is handed to the caller — the choice
  // between `hydrate` and `hydrateWithPrune` is purely whether `hydrateMaxAgeMs`
  // was also supplied.
  if (opts.hydrateFrom !== undefined) {
    restoreHandles(opts.hydrateFrom, store, now, opts.hydrateMaxAgeMs)
  }

  return {
    store,
    maxConcurrent,
    maxQueued,
    admissionQueue,
    now,
    idGen,
    countRunning: () => countRunning(store),
    countQueued: () => countQueued(store),
    startRun,
    promote,
    moveToFront: (targetId) => moveToFront(store, targetId),
    awaitTerminal: (entry) => awaitTerminal(entry, yieldMacrotask),
    awaitTerminalOrAbort: (entry, signal) => awaitTerminalOrAbort(entry, signal, yieldMacrotask),
    restoreHandles,
    makeError: (code, message) => new SubagentBackgroundError(code, message),
  }
}
