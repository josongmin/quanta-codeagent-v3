/**
 * Returned-object method bodies for {@link defaultBackgroundSubagentScheduler}
 * (decomposed out of the god-function — behavior-preserving).
 *
 * Each helper here is the EXACT body of one scheduler method, parameterized by
 * the closed-over engine state via {@link SchedulerEngine}. The factory builds
 * the engine (the mutually-recursive closures + the shared `store` Map + config
 * scalars) and the returned object delegates to these helpers — the closures
 * and the Map are passed BY REFERENCE so cancel/await/promote still observe the
 * same mutable entries.
 */

import {
  type BackgroundSubagentScheduler,
  type Entry,
  type ForceBackgroundOutcome,
  isTerminal,
  parseHandle,
  type SerializedHandle,
  type SerializedScheduler,
  type SubagentHandleId,
  type SubagentResult,
  type SubagentSpec,
  safeJsonParse,
  serializeResult,
  snapshotResult,
  validateSerializedPayload,
} from "../subagent-background"
import type { SchedulerEngine } from "./engine"

export type { SchedulerEngine } from "./engine"

export const forkMethod = (engine: SchedulerEngine, spec: SubagentSpec): SubagentHandleId => {
  const { store, maxConcurrent, maxQueued, admissionQueue, now, idGen } = engine
  const atCap = engine.countRunning() >= maxConcurrent
  if (atCap && !admissionQueue) {
    // DEFAULT PATH (queue off) — byte-identical to the pre-queue behavior:
    // over-cap fork is REJECTED, not parked.
    throw engine.makeError(
      "cap-exceeded",
      `cap-exceeded: ${engine.countRunning()} running >= maxConcurrent ${maxConcurrent}`,
    )
  }
  if (atCap && engine.countQueued() >= maxQueued) {
    // Queue ON but BOUNDED — a runaway producer cannot grow it forever.
    throw engine.makeError(
      "queue-full",
      `queue-full: ${engine.countQueued()} queued >= maxQueued ${maxQueued}`,
    )
  }
  const id = `bg-${idGen()}` as SubagentHandleId
  const abortCtrl = new AbortController()
  // When at cap (queue on), PARK as `queued` — the runner is NOT started.
  const queued = atCap
  const result: Entry["result"] = {
    status: queued ? "queued" : "running",
    outputSummary: queued ? "(queued)" : "(running)",
    startedAt: now(),
    turns: 0,
  }
  // Build the entry FIRST without the promise (promise needs entry).
  const entry: Entry = {
    id,
    spec,
    abortCtrl,
    promise: Promise.resolve(),
    result,
  }
  if (!queued) {
    // Replace `promise` with the real one — kicks off the runner. The
    // ASYNC body in `startRun` reads `entry.result` and `entry.abortCtrl`
    // through this same closure-captured reference.
    const realPromise = engine.startRun(entry)
    ;(entry as { promise: Promise<void> }).promise = realPromise
  }
  // A `queued` entry keeps the placeholder `Promise.resolve()` until
  // `promote()` (auto-drain or force_background) wires the real one.
  store.set(id, entry)
  // Note: not calling evictIfOver here — only terminal entries count
  // against maxRetained, and a newly-running/queued entry adds zero to
  // that count. evictIfOver runs after each terminal transition (inside
  // startRun's finally).
  return id
}

export const pollMethod = (
  engine: SchedulerEngine,
  id: SubagentHandleId,
): SubagentResult | null => {
  const entry = engine.store.get(id)
  if (entry === undefined) return null
  return snapshotResult(entry.result)
}

export const awaitMethod = async (
  engine: SchedulerEngine,
  id: SubagentHandleId,
  opts?: { signal?: AbortSignal },
): Promise<SubagentResult | null> => {
  const entry = engine.store.get(id)
  if (entry === undefined) return null
  // Fast path: already terminal.
  if (isTerminal(entry.result.status)) return snapshotResult(entry.result)
  const signal = opts?.signal
  // No signal: block until terminal (queued entries block until promoted).
  // With signal: block until terminal OR abort — we do NOT cancel the
  // subagent when the await-signal fires (the caller separated "I got bored
  // waiting" from "kill the work").
  if (signal === undefined) await engine.awaitTerminal(entry)
  else if (!signal.aborted) await engine.awaitTerminalOrAbort(entry, signal)
  return snapshotResult(entry.result)
}

export const cancelMethod = (engine: SchedulerEngine, id: SubagentHandleId): boolean => {
  const entry = engine.store.get(id)
  if (entry === undefined) return false
  if (isTerminal(entry.result.status)) {
    // Already done — cancel is a no-op (idempotent posture). Return
    // `true` because the handle exists; the caller's question "is this
    // a known id" is answered yes.
    return true
  }
  // Mutate status synchronously so a follow-up `poll` sees `cancelled`
  // even before the runner observes its signal. The runner's await
  // path inside `startRun` will see this and keep the cancelled
  // posture (it explicitly checks `entry.result.status === "cancelled"`).
  entry.result.status = "cancelled"
  entry.result.outputSummary = "(cancelled)"
  entry.result.endedAt = engine.now()
  entry.abortCtrl.abort()
  return true
}

export const listMethod = (
  engine: SchedulerEngine,
): ReadonlyArray<{ id: SubagentHandleId; result: SubagentResult; spec: SubagentSpec }> => {
  const arr = Array.from(engine.store.entries())
  // Newest-first — matches `shadow_snapshots`/`conversation-checkpoint`
  // surface convention. Map is insertion-ordered (oldest-front); reverse.
  arr.reverse()
  return arr.map(([id, e]) => ({
    id,
    result: snapshotResult(e.result),
    spec: e.spec,
  }))
}

export const pruneMethod = (engine: SchedulerEngine, maxAgeMs: number): number => {
  const threshold = engine.now() - Math.max(0, maxAgeMs)
  let removed = 0
  for (const [id, e] of engine.store.entries()) {
    // RUNNING entries are NEVER pruned — they have an in-flight promise a
    // caller may still await. TERMINAL entries age by `endedAt`. QUEUED
    // entries (ADR-0487) age by `startedAt` — a parked task abandoned past
    // `maxAgeMs` is almost certainly stale (RFC §8 R4); dropping it never
    // double-executes since the runner never started.
    if (e.result.status === "running") continue
    const ageRef = e.result.endedAt ?? e.result.startedAt
    if (ageRef < threshold) {
      engine.store.delete(id)
      removed += 1
    }
  }
  return removed
}

export const serializeMethod = (engine: SchedulerEngine): string => {
  // Snapshot every handle — running entries' result.status stays
  // "running" so hydrate can detect them and reborn as failed.
  const handles: SerializedHandle[] = []
  for (const [id, e] of engine.store.entries()) {
    handles.push({ id, spec: e.spec, result: serializeResult(e.result) })
  }
  const payload: SerializedScheduler = { v: 1, handles }
  return JSON.stringify(payload)
}

export const hydrateMethod = (engine: SchedulerEngine, json: string): number => {
  return engine.restoreHandles(json, engine.store, engine.now, undefined)
}

export const hydrateWithPruneMethod = (
  engine: SchedulerEngine,
  json: string,
  maxAgeMs: number,
): { restored: number; pruned: number } => {
  // Pre-parse so we can count {pruned} BEFORE the surviving entries
  // are restored — pruned = total parseable handles minus survivors.
  const parsed = safeJsonParse(json)
  if (parsed === undefined) return { restored: 0, pruned: 0 }
  const rawHandles = validateSerializedPayload(parsed)
  if (rawHandles === undefined) return { restored: 0, pruned: 0 }
  let totalValid = 0
  for (const raw of rawHandles) {
    if (parseHandle(raw) !== undefined) totalValid += 1
  }
  const restored = engine.restoreHandles(json, engine.store, engine.now, maxAgeMs)
  const pruned = Math.max(0, totalValid - restored)
  return { restored, pruned }
}

export const forceBackgroundMethod = (
  engine: SchedulerEngine,
  id: SubagentHandleId,
  forceOpts?: { allowBurst?: boolean },
): ForceBackgroundOutcome => {
  // Queue OFF ⇒ nothing can be queued ⇒ nothing to promote. Default path.
  if (!engine.admissionQueue) return "queue_disabled"
  const entry = engine.store.get(id)
  if (entry === undefined) return "not_found"
  // Running or terminal ⇒ no-op (no-throw sibling of cancel_subagent).
  if (entry.result.status !== "queued") return "already_running"

  const slotFree = engine.countRunning() < engine.maxConcurrent
  if (slotFree) {
    // A real slot is free — promote immediately, cap untouched.
    engine.promote(entry)
    return "promoted_now"
  }

  const allowBurst = forceOpts?.allowBurst === true
  // R2 fail-closed: burst is a ONE-SLOT courtesy, never a bypass. We allow
  // a transient +1 over `maxConcurrent` but NEVER +2 — a second burst
  // while already over-cap degrades to `moved_to_front`.
  if (allowBurst && engine.countRunning() <= engine.maxConcurrent) {
    engine.promote(entry)
    return "promoted_now"
  }

  // No slot, no (admissible) burst ⇒ re-order to the FIFO head so this
  // entry runs the instant the next slot frees, ahead of all other
  // waiters.
  engine.moveToFront(id)
  return "moved_to_front"
}

/** Assemble the public scheduler object from a built engine — every method
 *  delegates to the matching module-level helper. */
export const buildScheduler = (engine: SchedulerEngine): BackgroundSubagentScheduler => ({
  fork: (spec) => forkMethod(engine, spec),
  poll: (id) => pollMethod(engine, id),
  await: (id, opts) => awaitMethod(engine, id, opts),
  cancel: (id) => cancelMethod(engine, id),
  list: () => listMethod(engine),
  prune: (maxAgeMs) => pruneMethod(engine, maxAgeMs),
  serialize: () => serializeMethod(engine),
  hydrate: (json) => hydrateMethod(engine, json),
  hydrateWithPrune: (json, maxAgeMs) => hydrateWithPruneMethod(engine, json, maxAgeMs),
  forceBackground: (id, opts) => forceBackgroundMethod(engine, id, opts),
})
