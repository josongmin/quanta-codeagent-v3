/**
 * ADR-0408 — Observability emitter.
 *
 * Polls (or hooks) the three closed ports — `ObjectivePort`, `RunLedgerPort`,
 * `ApprovalStateMachinePort` — diffs against the last sent state, and emits
 * `observability.snapshot` / `observability.delta` frames over an injected
 * WS-like transport.
 *
 * Default-OFF semantics:
 *   - All three ports are OPTIONAL. With none injected the emitter is a
 *     compile-time-noop: `start()` returns a stop handle but the timer
 *     never fires anything onto the wire.
 *   - The first emit after `start()` is always a SNAPSHOT (synthetic on the
 *     first tick) so a fresh client renders state without replaying deltas.
 *     `requestSnapshot()` (exposed for reconnect) re-emits a snapshot.
 *   - Subsequent ticks emit DELTAs when the captured state differs from the
 *     last sent state. When nothing differs, no message is emitted.
 *   - A port that THROWS during polling is treated as "no data this tick".
 *     The emitter logs at most once per port per tick (via the optional
 *     `log` seam) and keeps the previous captured state for that port.
 *
 * Slice fence: imports allowed are the three closed port TYPES from
 * `@/agent/run-ledger`, `@/agent/objective`, `@/agent/approval-state-machine`
 * (types only — these ports own their own runtime stores), the protocol
 * codec from `@/protocol/observability`, and node-built-ins. NO `@/agent/loop`,
 * `@/agent/dispatch`, `@/apps/agent` runtime imports.
 */

import type { ApprovalRequest, ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import type { Objective, ObjectivePort } from "@/agent/objective"
import type { RunEntry, RunLedgerPort } from "@/agent/run-ledger"
import {
  type ApprovalChange,
  encodeObservabilityFrame,
  type ObservabilityDeltaMessage,
  type ObservabilityMessage,
  type ObservabilitySnapshotMessage,
  type RunChange,
} from "@/protocol/observability"

import { errMessage } from "@/shared"
/** WS-like send sink — every existing daemon transport (Bun.serve socket /
 *  unit test stub) satisfies this. The emitter never reads from the wire. */
export interface ObservabilitySink {
  send(frame: string): void
}

/** Optional timer seam so tests can drive the loop deterministically. */
export interface TimerSeam {
  setInterval(cb: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface ObservabilityEmitterOptions {
  /** Either: WS-like sink (recommended — encoder runs inside) ... */
  readonly ws?: ObservabilitySink
  /** ... or: pre-encoded frame sink (for transports that want to add their
   *  own envelope). Tested but not used by the daemon today. */
  readonly send?: (msg: ObservabilityMessage) => void
  readonly objective?: ObjectivePort
  /** Thread the objective pane should reflect. Default: `"default"`. The
   *  emitter reads exactly this thread's objective via `objective.get(...)`. */
  readonly threadId?: string
  readonly runLedger?: RunLedgerPort
  readonly approvalSM?: ApprovalStateMachinePort
  /** Poll cadence in ms. Default 250ms — fast enough to feel live, slow
   *  enough to keep the encode/decode cost negligible. */
  readonly intervalMs?: number
  /** Optional clock seam (default `Date.now`). */
  readonly now?: () => number
  /** Optional timer seam (default global setInterval/clearInterval). */
  readonly timer?: TimerSeam
  /** Optional logger — captured throws / dropped emits surface here. */
  readonly log?: (level: "info" | "warn", msg: string) => void
}

export interface ObservabilityEmitterHandle {
  /** Force the next emit to be a snapshot (use on reconnect / re-attach). */
  requestSnapshot(): void
  /** Manually pump one tick — convenience for tests; production uses the
   *  internal timer. */
  tick(): void
  /** Stop the timer + free state. Idempotent. */
  stop(): void
}

interface CapturedState {
  readonly runsById: Map<string, RunEntry>
  readonly objective: Objective | null
  readonly approvalsById: Map<string, ApprovalRequest>
}

const EMPTY_STATE: CapturedState = {
  runsById: new Map(),
  objective: null,
  approvalsById: new Map(),
}

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_THREAD_ID = "default"

const defaultTimer: TimerSeam = {
  setInterval(cb, ms) {
    return setInterval(cb, ms)
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

const safeNow = (now: () => number): number => {
  try {
    const t = now()
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

/** Wrap a port read in try/catch. On throw the previous value wins.
 *  Closure type: a thunk that may return T or null; on throw, returns the
 *  fallback parameter. */
const safeRead = <T>(read: () => T, fallback: T, onWarn: () => void): T => {
  try {
    return read()
  } catch {
    onWarn()
    return fallback
  }
}

const cloneRunsToMap = (runs: readonly RunEntry[]): Map<string, RunEntry> => {
  const out = new Map<string, RunEntry>()
  for (const r of runs) {
    if (typeof r?.id === "string" && r.id.length > 0) {
      out.set(r.id, r)
    }
  }
  return out
}

const cloneApprovalsToMap = (list: readonly ApprovalRequest[]): Map<string, ApprovalRequest> => {
  const out = new Map<string, ApprovalRequest>()
  for (const a of list) {
    if (typeof a?.id === "string" && a.id.length > 0) {
      out.set(a.id, a)
    }
  }
  return out
}

/** Compute additions + mutations + removals between two id-keyed maps.
 *  Uses STRUCTURAL equality for the value comparison — every store in this
 *  emitter returns a freshly frozen object on every read, so identity
 *  comparison would mark every entry as "changed" on every tick. */
const diffMap = <T>(
  prev: Map<string, T>,
  next: Map<string, T>,
): Array<{ id: string; entry: T | null }> => {
  const out: Array<{ id: string; entry: T | null }> = []
  for (const [id, entry] of next) {
    const prior = prev.get(id)
    if (prior === undefined || !valuesStructurallyEqual(prior, entry)) {
      out.push({ id, entry })
    }
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) out.push({ id, entry: null })
  }
  return out
}

/** Structural equality via `JSON.stringify` — adequate for the Objective /
 *  RunEntry / ApprovalRequest data shapes (no functions, no cycles, no
 *  symbols; every field is a primitive / array / plain object).
 *
 *  We use this instead of reference equality because the upstream stores
 *  return a FRESHLY frozen copy on every read (`objective.get`,
 *  `runLedger.list`, `approvalSM.pending`). Identity would diff on every
 *  tick and flood the wire with no-op deltas. */
const stringifyForEq = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

const valuesStructurallyEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null) return false
  return stringifyForEq(a) === stringifyForEq(b)
}

const objectivesEqual = (a: Objective | null, b: Objective | null): boolean => {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return valuesStructurallyEqual(a, b)
}

export const createObservabilityEmitter = (
  options: ObservabilityEmitterOptions,
): ObservabilityEmitterHandle => {
  const interval = Math.max(1, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS))
  const now = options.now ?? Date.now
  const timer = options.timer ?? defaultTimer
  const threadId = options.threadId ?? DEFAULT_THREAD_ID
  const log = options.log ?? ((): void => undefined)

  // Early-out: nothing wired ⇒ no-op handle. We still install a timer-less
  // shell so callers don't have to special-case the disabled path.
  const hasAnyPort =
    options.objective !== undefined ||
    options.runLedger !== undefined ||
    options.approvalSM !== undefined
  const hasAnySink = options.ws !== undefined || options.send !== undefined

  let lastSent: CapturedState = EMPTY_STATE
  let pendingFullSnapshot = true
  let stopped = false
  let timerHandle: unknown = null

  const sendMessage = (msg: ObservabilityMessage): void => {
    if (options.ws !== undefined) {
      try {
        options.ws.send(encodeObservabilityFrame(msg))
      } catch (err) {
        log("warn", `observability: ws.send threw: ${errMessage(err)}`)
      }
      return
    }
    if (options.send !== undefined) {
      try {
        options.send(msg)
      } catch (err) {
        log("warn", `observability: send seam threw: ${errMessage(err)}`)
      }
    }
  }

  const captureState = (): CapturedState => {
    const runs =
      options.runLedger === undefined
        ? lastSent.runsById
        : cloneRunsToMap(
            safeRead(
              () =>
                // We only need every CURRENT entry — `list()` (no filter) returns
                // everything the ledger retains.
                options.runLedger?.list() ?? [],
              [] as readonly RunEntry[],
              () => log("warn", "observability: runLedger.list threw"),
            ),
          )
    const obj =
      options.objective === undefined
        ? lastSent.objective
        : safeRead(
            () => options.objective?.get(threadId) ?? null,
            lastSent.objective,
            () => log("warn", "observability: objective.get threw"),
          )
    const approvals =
      options.approvalSM === undefined
        ? lastSent.approvalsById
        : cloneApprovalsToMap(
            safeRead(
              () => options.approvalSM?.pending() ?? [],
              [] as readonly ApprovalRequest[],
              () => log("warn", "observability: approvalSM.pending threw"),
            ),
          )
    return { runsById: runs, objective: obj, approvalsById: approvals }
  }

  const snapshotOf = (state: CapturedState): ObservabilitySnapshotMessage => ({
    kind: "observability.snapshot",
    runs: [...state.runsById.values()],
    objective: state.objective,
    approvals: [...state.approvalsById.values()],
    emittedAt: safeNow(now),
  })

  const buildDelta = (
    prev: CapturedState,
    next: CapturedState,
  ): ObservabilityDeltaMessage | null => {
    const runChanges: RunChange[] = diffMap(prev.runsById, next.runsById).map((c) => ({
      id: c.id,
      entry: c.entry,
    }))
    // Approvals use a different field name (`approval`, not `entry`) to keep
    // the wire shape human-scannable. We re-key here.
    const approvalChanges: ApprovalChange[] = diffMap(prev.approvalsById, next.approvalsById).map(
      (c) => ({ id: c.id, approval: c.entry }),
    )
    const objectiveDiffers = !objectivesEqual(prev.objective, next.objective)
    if (runChanges.length === 0 && approvalChanges.length === 0 && !objectiveDiffers) {
      return null
    }
    const out: ObservabilityDeltaMessage = {
      kind: "observability.delta",
      ...(runChanges.length > 0 ? { runChanges } : {}),
      ...(approvalChanges.length > 0 ? { approvalChanges } : {}),
      ...(objectiveDiffers ? { objectiveChanged: next.objective } : {}),
      emittedAt: safeNow(now),
    }
    return out
  }

  const tick = (): void => {
    if (stopped) return
    if (!hasAnyPort || !hasAnySink) return
    const next = captureState()
    if (pendingFullSnapshot) {
      sendMessage(snapshotOf(next))
      lastSent = next
      pendingFullSnapshot = false
      return
    }
    const delta = buildDelta(lastSent, next)
    if (delta === null) return
    sendMessage(delta)
    lastSent = next
  }

  if (hasAnyPort && hasAnySink) {
    timerHandle = timer.setInterval(tick, interval)
  }

  return {
    requestSnapshot(): void {
      pendingFullSnapshot = true
    },
    tick,
    stop(): void {
      if (stopped) return
      stopped = true
      if (timerHandle !== null) {
        try {
          timer.clearInterval(timerHandle)
        } catch {
          // ignore — clearInterval on a settled handle is a no-op anyway
        }
        timerHandle = null
      }
    },
  }
}
