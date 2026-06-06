/**
 * Background subagent fork+detach scheduler (ADR-0130).
 *
 * SOTA absorption: Cursor's `force_background_subagent` + `subagent_await` is
 * the SOLE industry pattern for true detached subagent execution. Claude Code
 * 2.1 / Codex / v0.dev all run subagents sequentially — the parent BLOCKS
 * until the child returns. This module is quanta's closed-port equivalent:
 * `fork()` returns an opaque handle id immediately and the run proceeds in
 * the background; `await()` (or `poll()`) harvests the result later. Cancel
 * is first-class via the per-handle AbortController.
 *
 * Plane-clean: imports ONLY `@/subagent` (types) + `node:crypto`. NO
 * `@/agent/loop`, `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool` — this
 * is a PURE bookkeeping primitive. The injected {@link SubagentRunner} is the
 * sole bridge to the actual agent loop; the host wires it (see
 * `src/agent/subagent-runner.ts` for the @/agent-side bridge).
 *
 * Default-OFF (helper-only deferred-wire, voice-match ADR-0124 / ADR-0128):
 *   - This module's `defaultBackgroundSubagentScheduler` is NEVER instantiated
 *     by the loop today. Callers (apps/agent bootstrap, future CLI command)
 *     opt in by constructing it and threading the scheduler into
 *     `AgentConfig.subagentBackground?: { scheduler }` (the slot is added by
 *     the caller in a sibling PR — this module exposes only the type).
 *   - `src/agent/tier1/subagent-bg.ts` reads `config.subagentBackground` in a
 *     duck-typed way; when absent the tier1 builder returns `[]` and the
 *     ToolRegistry stays byte-identical.
 *
 * Contract (6):
 *   1. PURE STORE: in-memory `Map<handleId, entry>`; no I/O, no SQLite.
 *      Persistence across restart is Phase 2.
 *   2. NO-THROW on the AWAIT/POLL/CANCEL/LIST/PRUNE surface — a subagent
 *      failure is surfaced via `result.status === "failed"` + `errorMessage`,
 *      NEVER a thrown error. `fork()` throws ONLY for cap-exceeded (typed
 *      `SubagentBackgroundError` so the caller can branch deterministically).
 *   3. exactOptionalPropertyTypes: optional input fields are OMITTED when
 *      absent, never `undefined`-set.
 *   4. CANCELLATION: each handle owns its own AbortController; `cancel()`
 *      fires it and the in-flight promise resolves with
 *      `status="cancelled"`. Idempotent.
 *   5. LRU eviction: when `maxRetained` is exceeded the OLDEST COMPLETED
 *      (= non-running) handle is dropped first; running handles are NEVER
 *      auto-dropped (they have an in-flight promise the caller may still
 *      `await`).
 *   6. AWAIT SIGNAL: when `await(id, {signal})` is passed an AbortSignal,
 *      racing it returns the CURRENT snapshot WITHOUT cancelling the
 *      underlying subagent — the caller can decide whether to `cancel()`
 *      explicitly. (Differentiates "I got bored waiting" from "kill it".)
 */

import { randomBytes } from "node:crypto"
import { errMessage } from "@/shared"
import type {
  SubagentResult as SliceRunnerOutcome,
  SubagentRequest,
  SubagentRunner,
} from "@/subagent"
/** Opaque handle id — `bg-<16hex>`. Stable for the scheduler's lifetime. */
export type SubagentHandleId = string

/** 5-arm lifecycle status (ADR-0487 force_background). `running` and `queued`
 *  are the two NON-terminal states; `completed | failed | cancelled` terminal.
 *
 *  `queued` ONLY exists when the scheduler was constructed with
 *  `admissionQueue: true` (default-OFF). With the queue off, `fork()` throws
 *  `cap-exceeded` at the cap exactly as before and no `queued` entry can ever
 *  be created — the 4-arm behavior is byte-identical for every existing
 *  caller. */
export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

/** Closed outcome of {@link BackgroundSubagentScheduler.forceBackground} —
 *  mirrors `CancelSubagentOutcome`'s no-throw 3-way posture. Adding a new arm
 *  MUST extend this union AND the matching control-op / AgentEvent surface.
 *
 *   - `promoted_now`    — a slot was free (or `allowBurst` granted a +1 burst);
 *                          the queued entry started running immediately.
 *   - `moved_to_front`  — no free slot and no burst granted; the queued entry
 *                          was re-ordered to the FIFO head and runs the instant
 *                          the next slot frees (ahead of all other waiters).
 *   - `already_running` — the handle was already running OR terminal — no-op.
 *   - `not_found`       — unknown handle id.
 *   - `queue_disabled`  — the scheduler has no admission queue (default path);
 *                          nothing can be queued, so nothing to promote. */
export type ForceBackgroundOutcome =
  | "promoted_now"
  | "moved_to_front"
  | "already_running"
  | "not_found"
  | "queue_disabled"

/** Snapshot of a single background subagent's state. Returned by `poll` /
 *  `await` / `list`. All fields readonly — mutating the snapshot does not
 *  affect the store (callers always receive a fresh frozen copy). */
export interface SubagentResult {
  readonly status: SubagentStatus
  /** Short one-liner suitable for surfacing in a status bar / tool output. */
  readonly outputSummary: string
  /** Full transcript or final answer; absent for `running`. */
  readonly outputDetail?: string
  /** Set on `status === "failed"`. */
  readonly errorMessage?: string
  /** Epoch ms when `fork()` was called. */
  readonly startedAt: number
  /** Epoch ms when the run reached a terminal state; absent while running. */
  readonly endedAt?: number
  /** Number of model turns the child consumed (0 when not yet known). */
  readonly turns: number
}

/** Caller's specification of a single background subagent. Mirrors the
 *  fields the LLM-facing tool will surface; the host-side bridge translates
 *  this into a full {@link SubagentRequest} when invoking the runner. */
export interface SubagentSpec {
  /** The prompt handed to the child agent. Required. */
  readonly task: string
  /** Optional model swap; the bridge interprets this. */
  readonly modelOverride?: string
  /** Optional bound on turns. */
  readonly maxTurns?: number
  /** Optional override of the child's working directory. */
  readonly workspace?: string
  /** Free-form metadata pairs — caller-controlled (e.g. {origin: "ci"}). */
  readonly metadata?: Readonly<Record<string, string>>
}

/** Public surface — every method NO-THROW except `fork()` cap-exceeded. */
export interface BackgroundSubagentScheduler {
  /** Fork a subagent into the background. Returns immediately with an opaque
   *  handle id; the actual run starts asynchronously via the injected runner.
   *  Throws {@link SubagentBackgroundError} (code `"cap-exceeded"`) when the
   *  running-count is at `maxConcurrent`. */
  fork(spec: SubagentSpec): SubagentHandleId
  /** Look up current status without awaiting. Returns `null` for unknown id. */
  poll(id: SubagentHandleId): SubagentResult | null
  /** Block until completion (or return immediately if already terminal). When
   *  `opts.signal` aborts, returns the CURRENT snapshot without cancelling
   *  the underlying subagent. Returns `null` for unknown id. */
  await(id: SubagentHandleId, opts?: { signal?: AbortSignal }): Promise<SubagentResult | null>
  /** Request cancellation. Idempotent. Returns true when the handle exists. */
  cancel(id: SubagentHandleId): boolean
  /** Enumerate all known handles (running + terminal). Newest first. */
  list(): ReadonlyArray<{
    id: SubagentHandleId
    result: SubagentResult
    spec: SubagentSpec
  }>
  /** Drop terminal (completed | failed | cancelled) handles older than
   *  `maxAgeMs`. Running handles are NEVER pruned. Returns drop count. */
  prune(maxAgeMs: number): number
  /** Serialize ALL handles (running + completed + cancelled + failed) for
   *  cross-restart persistence. Returns JSON string. The `abortCtrl` and
   *  in-flight `promise` are non-serializable and OMITTED — `hydrate` reborn
   *  "running" entries as `failed` with `errorMessage="lost across restart"`. */
  serialize(): string
  /** Hydrate from a prior `serialize()` output. Running handles whose runner
   *  was lost become `failed` with `errorMessage="lost across restart"` since
   *  the Promise object cannot be reconstructed. Returns count restored.
   *  On parse failure or wrong shape returns 0 (NO-THROW). */
  hydrate(json: string): number
  /** Auto-prune on hydrate — drop terminal entries older than `maxAgeMs` at
   *  hydrate time, and running entries whose `startedAt` is older than
   *  `maxAgeMs`. Returns {restored, pruned}. NO-THROW on garbage input. */
  hydrateWithPrune(json: string, maxAgeMs: number): { restored: number; pruned: number }
  /** ADR-0487 — promote a `queued` handle to run NOW (or to the FIFO head).
   *  NO-THROW: every input (unknown / running / terminal / queue-disabled)
   *  maps to a closed {@link ForceBackgroundOutcome}, never an exception, so
   *  the parent turn keeps running (sibling of `cancel_subagent`).
   *
   *   - queue disabled              → `queue_disabled`
   *   - unknown id                  → `not_found`
   *   - running or terminal handle  → `already_running`
   *   - queued + free slot          → start now → `promoted_now`
   *   - queued + no slot + burst     → start now (transiently +1 over the cap,
   *                                    NEVER +2) → `promoted_now`
   *   - queued + no slot + no burst  → re-order to FIFO head → `moved_to_front`
   */
  forceBackground(id: SubagentHandleId, opts?: { allowBurst?: boolean }): ForceBackgroundOutcome
}

export interface BackgroundSubagentSchedulerOpts {
  /** Caller-injected: how to actually run a subagent. Wraps `runAgent` upstream. */
  readonly runner: SubagentRunner
  /** Cap on concurrent in-flight subagents — when at cap, `fork()` throws with
   *  `SubagentBackgroundError("cap-exceeded")`. Default 3. */
  readonly maxConcurrent?: number
  /** Cap on retained TERMINAL handles (LRU). Running handles are not counted
   *  against this cap. Default 32. */
  readonly maxRetained?: number
  /** Injected clock; default `Date.now`. */
  readonly now?: () => number
  /** Injected id generator; default `randomBytes(8).toString("hex")`. */
  readonly idGen?: () => string
  /** Auto-hydrate from this JSON string at construction (ADR-0153). When set,
   *  the scheduler is populated from prior state BEFORE the constructor
   *  returns. Voice-match ADR-0124's `restoreFrom`. */
  readonly hydrateFrom?: string
  /** When auto-hydrating, drop entries older than this (ms). Triggers
   *  `hydrateWithPrune` instead of `hydrate`. Absent ⇒ no auto-prune. */
  readonly hydrateMaxAgeMs?: number
  /** ADR-0487 — opt into the admission wait-queue (default-OFF). When FALSE
   *  (the default), `fork()` throws `cap-exceeded` at `maxConcurrent` exactly
   *  as before and no `queued` entry can ever exist — byte-identical to the
   *  pre-queue behavior for every existing caller. When TRUE, an over-cap
   *  `fork()` parks the spec as a `queued` handle (FIFO) instead of throwing;
   *  the queue auto-drains on each slot-free. */
  readonly admissionQueue?: boolean
  /** ADR-0487 — hard ceiling on the number of `queued` (parked) entries. The
   *  queue MUST be bounded so a runaway producer cannot grow it without limit
   *  (DoS). When the queue is full, an over-cap `fork()` throws `queue-full`
   *  (typed). Only consulted when `admissionQueue` is on. Default 64. */
  readonly maxQueued?: number
  /** Injected MACROTASK yield used by `await()` while an entry is still
   *  `queued` (its placeholder promise settles synchronously). It MUST schedule
   *  on the macrotask queue (default `setTimeout(resolve, 0)`) — a microtask
   *  yield (`Promise.resolve()`) would starve timers/IO, hanging the loop while
   *  a queued-forever entry is awaited. Injectable so tests can drive it. */
  readonly yieldMacrotask?: () => Promise<void>
}

/** Typed error class — exposes a closed `code` union the caller can branch
 *  on deterministically (no prose parsing). */
export class SubagentBackgroundError extends Error {
  constructor(
    public readonly code: "cap-exceeded" | "unknown-handle" | "queue-full",
    message: string,
  ) {
    super(message)
    this.name = "SubagentBackgroundError"
  }
}

const DEFAULT_MAX_CONCURRENT = 3
const DEFAULT_MAX_RETAINED = 32
/** Default hard ceiling on parked `queued` entries (ADR-0487). Bounded so a
 *  runaway producer cannot grow the wait-queue without limit. */
const DEFAULT_MAX_QUEUED = 64

const ONE_LINE_LIMIT = 200

/** Take the first line of `text`, capped at `ONE_LINE_LIMIT` chars. Used to
 *  derive a `outputSummary` from a longer `finalText`. */
const oneLine = (text: string): string => {
  const idx = text.indexOf("\n")
  const head = idx >= 0 ? text.slice(0, idx) : text
  return head.length > ONE_LINE_LIMIT ? `${head.slice(0, ONE_LINE_LIMIT - 1)}…` : head
}

/** Internal mutable entry — never escapes the store. Snapshots are built
 *  from this via {@link snapshotResult} which projects to the readonly
 *  external shape and OMITS absent optional fields (exactOptional). */
interface Entry {
  readonly id: SubagentHandleId
  readonly spec: SubagentSpec
  /** Per-handle abort controller — fired by `cancel()`. */
  readonly abortCtrl: AbortController
  /** The in-flight `runner` promise; resolves with the final `Entry.result`
   *  (after the runner's promise settled OR was cancelled). Never rejects:
   *  rejections are caught and surfaced as `status === "failed"`. */
  readonly promise: Promise<void>
  /** Current MUTABLE result — updated as the run progresses. The external
   *  snapshot is built fresh from this on every `poll`/`await`/`list` call
   *  via {@link snapshotResult}. */
  result: {
    status: SubagentStatus
    outputSummary: string
    outputDetail?: string
    errorMessage?: string
    startedAt: number
    endedAt?: number
    turns: number
  }
}

/** Project an internal `Entry.result` to the external readonly shape.
 *  Optional fields are OMITTED (not set to `undefined`) when absent. */
const snapshotResult = (r: Entry["result"]): SubagentResult => {
  const base = {
    status: r.status,
    outputSummary: r.outputSummary,
    startedAt: r.startedAt,
    turns: r.turns,
  }
  return {
    ...base,
    ...(r.outputDetail !== undefined ? { outputDetail: r.outputDetail } : {}),
    ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
  }
}

/** `running` and `queued` are the two NON-terminal states; everything else
 *  (completed | failed | cancelled) is terminal. A `queued` entry has NOT
 *  started its runner yet, so — like `running` — it must NEVER be LRU-evicted
 *  or pruned-as-stale-terminal. */
const isTerminal = (s: SubagentStatus): boolean => s !== "running" && s !== "queued"

/** Build the {@link SubagentRequest} the runner consumes from a caller-side
 *  {@link SubagentSpec}. The two surfaces are intentionally distinct:
 *  `SubagentSpec` is what the LLM-facing tool surfaces; `SubagentRequest` is
 *  the slice's port type. Background scheduler always passes `depth: 0` —
 *  the host bridge upstream of `runner` is responsible for any depth+1
 *  bookkeeping if it forks the agent loop. */
const specToRequest = (spec: SubagentSpec, signal: AbortSignal): SubagentRequest => {
  const req: SubagentRequest = { prompt: spec.task, depth: 0, signal }
  const withTurns =
    spec.maxTurns !== undefined ? { ...req, budget: { maxTurns: spec.maxTurns } } : req
  // `modelOverride` / `workspace` / `metadata` are NOT part of SubagentRequest
  // today — they are caller-side hints the bridge surfaces if/when the
  // underlying runner grows model-swap support. We keep them in the spec for
  // observability via `list()` without forcing the slice to grow new fields.
  return withTurns
}

/** Internal: on-the-wire shape of one persisted handle (ADR-0153). The
 *  `result.status` may be `running` — those entries reborn as `failed` with
 *  `errorMessage="lost across restart"` on hydrate because the Promise object
 *  cannot be reconstructed (the runner has no way to resume a torn-down
 *  process's in-flight work). */
interface SerializedHandle {
  readonly id: SubagentHandleId
  readonly spec: SubagentSpec
  readonly result: {
    readonly status: SubagentStatus
    readonly outputSummary: string
    readonly outputDetail?: string
    readonly errorMessage?: string
    readonly startedAt: number
    readonly endedAt?: number
    readonly turns: number
  }
}

interface SerializedScheduler {
  readonly v: 1
  readonly handles: ReadonlyArray<SerializedHandle>
}

/** Honest message for handles whose runner was torn down by a process
 *  restart — they were `running` on `serialize()` and cannot be resumed. */
const LOST_ACROSS_RESTART = "lost across restart"

/** Safe JSON.parse — returns `undefined` on failure (caller branches). */
const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** Project an `Entry.result` to its serialized JSON shape. Optional fields
 *  OMITTED when absent (exactOptionalPropertyTypes). */
const serializeResult = (r: Entry["result"]): SerializedHandle["result"] => {
  const base = {
    status: r.status,
    outputSummary: r.outputSummary,
    startedAt: r.startedAt,
    turns: r.turns,
  }
  return {
    ...base,
    ...(r.outputDetail !== undefined ? { outputDetail: r.outputDetail } : {}),
    ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
  }
}

/** Narrow one of the 5 valid status arms; `undefined` on miss. */
const parseStatus = (s: unknown): SubagentStatus | undefined => {
  if (s === "queued" || s === "running" || s === "completed" || s === "failed" || s === "cancelled")
    return s
  return undefined
}

/** Rebuild a `SubagentSpec` with only present optional fields (exactOptional). */
const parseSpec = (raw: unknown): SubagentSpec | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<SubagentSpec>
  if (typeof r.task !== "string") return undefined
  return {
    task: r.task,
    ...(typeof r.modelOverride === "string" ? { modelOverride: r.modelOverride } : {}),
    ...(typeof r.maxTurns === "number" ? { maxTurns: r.maxTurns } : {}),
    ...(typeof r.workspace === "string" ? { workspace: r.workspace } : {}),
    ...(typeof r.metadata === "object" && r.metadata !== null ? { metadata: r.metadata } : {}),
  }
}

/** Rebuild a `SerializedHandle["result"]` with only present optional fields. */
const parseSerializedResult = (raw: unknown): SerializedHandle["result"] | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const res = raw as Partial<SerializedHandle["result"]>
  const status = parseStatus(res.status)
  if (status === undefined) return undefined
  if (typeof res.outputSummary !== "string") return undefined
  if (typeof res.startedAt !== "number") return undefined
  if (typeof res.turns !== "number") return undefined
  return {
    status,
    outputSummary: res.outputSummary,
    startedAt: res.startedAt,
    turns: res.turns,
    ...(typeof res.outputDetail === "string" ? { outputDetail: res.outputDetail } : {}),
    ...(typeof res.errorMessage === "string" ? { errorMessage: res.errorMessage } : {}),
    ...(typeof res.endedAt === "number" ? { endedAt: res.endedAt } : {}),
  }
}

/** Type-narrow one raw element from a hydrated payload. Returns
 *  `undefined` on shape mismatch (caller skips). */
const parseHandle = (raw: unknown): SerializedHandle | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<SerializedHandle>
  if (typeof r.id !== "string") return undefined
  const spec = parseSpec(r.spec)
  if (spec === undefined) return undefined
  const result = parseSerializedResult(r.result)
  if (result === undefined) return undefined
  return { id: r.id, spec, result }
}

/** Validate the outer payload shape; return the `handles` array on success. */
const validateSerializedPayload = (parsed: unknown): ReadonlyArray<unknown> | undefined => {
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as Partial<SerializedScheduler>
  if (obj.v !== 1) return undefined
  if (!Array.isArray(obj.handles)) return undefined
  return obj.handles
}

export const defaultBackgroundSubagentScheduler = (
  opts: BackgroundSubagentSchedulerOpts,
): BackgroundSubagentScheduler => {
  const runner = opts.runner
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))
  const maxRetained = Math.max(1, Math.floor(opts.maxRetained ?? DEFAULT_MAX_RETAINED))
  const now = opts.now ?? Date.now
  const idGen = opts.idGen ?? ((): string => randomBytes(8).toString("hex"))
  // MACROTASK yield (not microtask): lets timers/IO run while await() spins on a
  // still-`queued` entry whose placeholder promise settles synchronously.
  const yieldMacrotask =
    opts.yieldMacrotask ??
    ((): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      }))
  // ADR-0487 — admission queue. Default-OFF: when `admissionQueue` is absent
  // the queue is unreachable (no `queued` entry can be created) and the
  // scheduler is byte-identical to its pre-queue self.
  const admissionQueue = opts.admissionQueue === true
  const maxQueued = Math.max(1, Math.floor(opts.maxQueued ?? DEFAULT_MAX_QUEUED))

  // Insertion-order Map — preserves a stable LRU order. Newest-end =
  // latest fork; oldest-front = first eviction candidate.
  const store = new Map<SubagentHandleId, Entry>()

  const countRunning = (): number => {
    let n = 0
    for (const e of store.values()) if (e.result.status === "running") n += 1
    return n
  }

  /** Find the oldest (insertion-order first) TERMINAL handle in the store,
   *  or undefined if none. Used by LRU eviction. */
  const findOldestTerminalKey = (): SubagentHandleId | undefined => {
    for (const [k, e] of store.entries()) {
      if (isTerminal(e.result.status)) return k
    }
    return undefined
  }

  /** Count TERMINAL entries — only these count against `maxRetained`. */
  const countTerminal = (): number => {
    let n = 0
    for (const e of store.values()) if (isTerminal(e.result.status)) n += 1
    return n
  }

  /** LRU drop of TERMINAL entries when the retained cap is exceeded. Running
   *  entries are skipped — they have an in-flight promise the caller may
   *  still await; auto-dropping them would corrupt the await surface. */
  const evictIfOver = (): void => {
    let terminalCount = countTerminal()
    while (terminalCount > maxRetained) {
      const oldestKey = findOldestTerminalKey()
      if (oldestKey === undefined) break
      store.delete(oldestKey)
      terminalCount -= 1
    }
  }

  /** Apply a successful runner outcome to the entry. Honors cancel-race
   *  (cancel() may have flipped status to "cancelled" while runner was
   *  in-flight; that intent wins). */
  const applyRunnerSuccess = (entry: Entry, out: SliceRunnerOutcome): void => {
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
   *  already-cancelled (keep cancelled posture), abort-driven (→ cancelled),
   *  and genuine error (→ failed). */
  const applyRunnerFailure = (entry: Entry, e: unknown): void => {
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

  /** Count `queued` (parked, not-yet-started) entries — only these count
   *  against `maxQueued`. */
  const countQueued = (): number => {
    let n = 0
    for (const e of store.values()) if (e.result.status === "queued") n += 1
    return n
  }

  /** Find the FIRST (insertion-order = FIFO) `queued` entry, or undefined.
   *  `force_background`'s `moved_to_front` re-orders an entry to the head of
   *  this FIFO so it is the one this returns next. */
  const firstQueuedEntry = (): Entry | undefined => {
    for (const e of store.values()) if (e.result.status === "queued") return e
    return undefined
  }

  /** Promote a `queued` entry into a `running` one — the deferred half of
   *  `fork`'s body. Flips status, wires the real runner promise in place of
   *  the placeholder, and re-stamps `startedAt` to the actual start time.
   *  Cancellation/eviction/serialize already handle a running entry, so no
   *  new lifecycle paths. Idempotent-safe: callers only invoke on a `queued`
   *  entry. */
  const promote = (entry: Entry): void => {
    entry.result.status = "running"
    entry.result.startedAt = now()
    const realPromise = startRun(entry)
    ;(entry as { promise: Promise<void> }).promise = realPromise
  }

  /** Auto-drain the FIFO when a slot frees: while there is a free slot and a
   *  `queued` entry, promote the OLDEST queued entry. Runs from `startRun`'s
   *  `finally` after `evictIfOver` — the EXACT point a slot frees. No new
   *  pump loop. When the queue is off this is a no-op (nothing is queued). */
  const drainQueue = (): void => {
    while (countRunning() < maxConcurrent) {
      const next = firstQueuedEntry()
      if (next === undefined) break
      promote(next)
    }
  }

  /** Move a `queued` entry to the FIFO HEAD (it becomes `firstQueuedEntry`).
   *  Re-inserts at the front by rebuilding the Map preserving order with the
   *  target first. Strictly last-forcer-wins-the-head (LIFO at head) so a
   *  `moved_to_front` storm cannot livelock (R4). */
  const moveToFront = (targetId: SubagentHandleId): void => {
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

  /** Start the actual run via the injected runner. Resolves the entry's
   *  promise once the runner settles OR the abort fires. Never rejects:
   *  every failure path mutates `entry.result` and resolves cleanly. */
  const startRun = (entry: Entry): Promise<void> => {
    return (async (): Promise<void> => {
      try {
        const req = specToRequest(entry.spec, entry.abortCtrl.signal)
        const out = await runner(req)
        applyRunnerSuccess(entry, out)
      } catch (e) {
        applyRunnerFailure(entry, e)
      } finally {
        evictIfOver()
        // ADR-0487 — a slot just freed; pull the next FIFO waiter (if any).
        // No-op when the admission queue is off (nothing is ever `queued`).
        drainQueue()
      }
    })()
  }

  /** Block until `entry` reaches a terminal state. A `queued` entry's `promise`
   *  is a synchronous placeholder; `promote()` swaps in the real runner promise,
   *  so re-read it each pass. A MACROTASK yield (never a microtask) between
   *  passes lets timers / `drainQueue` / runner-IO make progress — a microtask
   *  spin would starve the loop on a queued-forever entry. */
  const awaitTerminal = async (entry: Entry): Promise<void> => {
    while (!isTerminal(entry.result.status)) {
      await entry.promise
      if (isTerminal(entry.result.status)) break
      await yieldMacrotask()
    }
  }

  /** One abort-vs-promise race pass: resolve when the live `entry.promise`
   *  settles OR the signal aborts, cleaning up the listener either way. */
  const raceAbortOrSettle = (entry: Entry, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }
      signal.addEventListener("abort", onAbort, { once: true })
      // Runner never rejects (startRun catches); the rejection arm is defense
      // in depth so a stray rejection still unblocks the await.
      entry.promise.then(onAbort, onAbort)
    })

  /** Block until terminal OR the await-signal aborts. Loops so a `queued`
   *  placeholder settle does not return the parked snapshot before promotion. */
  const awaitTerminalOrAbort = async (entry: Entry, signal: AbortSignal): Promise<void> => {
    while (!isTerminal(entry.result.status) && !signal.aborted) {
      await raceAbortOrSettle(entry, signal)
      if (isTerminal(entry.result.status) || signal.aborted) break
      await yieldMacrotask()
    }
  }

  // Auto-hydrate at construction (ADR-0153). When `opts.hydrateFrom` is
  // present, populate `store` BEFORE the scheduler is handed to the caller —
  // matches the voice of ADR-0124's `restoreFrom` opt. The choice between
  // `hydrate` and `hydrateWithPrune` is purely whether `hydrateMaxAgeMs`
  // was also supplied.
  if (opts.hydrateFrom !== undefined) {
    restoreHandles(opts.hydrateFrom, store, now, opts.hydrateMaxAgeMs)
  }

  return {
    fork(spec) {
      const atCap = countRunning() >= maxConcurrent
      if (atCap && !admissionQueue) {
        // DEFAULT PATH (queue off) — byte-identical to the pre-queue behavior:
        // over-cap fork is REJECTED, not parked.
        throw new SubagentBackgroundError(
          "cap-exceeded",
          `cap-exceeded: ${countRunning()} running >= maxConcurrent ${maxConcurrent}`,
        )
      }
      if (atCap && countQueued() >= maxQueued) {
        // Queue ON but BOUNDED — a runaway producer cannot grow it forever.
        throw new SubagentBackgroundError(
          "queue-full",
          `queue-full: ${countQueued()} queued >= maxQueued ${maxQueued}`,
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
        const realPromise = startRun(entry)
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
    },

    poll(id) {
      const entry = store.get(id)
      if (entry === undefined) return null
      return snapshotResult(entry.result)
    },

    async await(id, opts) {
      const entry = store.get(id)
      if (entry === undefined) return null
      // Fast path: already terminal.
      if (isTerminal(entry.result.status)) return snapshotResult(entry.result)
      const signal = opts?.signal
      // No signal: block until terminal (queued entries block until promoted).
      // With signal: block until terminal OR abort — we do NOT cancel the
      // subagent when the await-signal fires (the caller separated "I got bored
      // waiting" from "kill the work").
      if (signal === undefined) await awaitTerminal(entry)
      else if (!signal.aborted) await awaitTerminalOrAbort(entry, signal)
      return snapshotResult(entry.result)
    },

    cancel(id) {
      const entry = store.get(id)
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
      entry.result.endedAt = now()
      entry.abortCtrl.abort()
      return true
    },

    list() {
      const arr = Array.from(store.entries())
      // Newest-first — matches `shadow_snapshots`/`conversation-checkpoint`
      // surface convention. Map is insertion-ordered (oldest-front); reverse.
      arr.reverse()
      return arr.map(([id, e]) => ({
        id,
        result: snapshotResult(e.result),
        spec: e.spec,
      }))
    },

    prune(maxAgeMs) {
      const threshold = now() - Math.max(0, maxAgeMs)
      let removed = 0
      for (const [id, e] of store.entries()) {
        // RUNNING entries are NEVER pruned — they have an in-flight promise a
        // caller may still await. TERMINAL entries age by `endedAt`. QUEUED
        // entries (ADR-0487) age by `startedAt` — a parked task abandoned past
        // `maxAgeMs` is almost certainly stale (RFC §8 R4); dropping it never
        // double-executes since the runner never started.
        if (e.result.status === "running") continue
        const ageRef = e.result.endedAt ?? e.result.startedAt
        if (ageRef < threshold) {
          store.delete(id)
          removed += 1
        }
      }
      return removed
    },

    serialize() {
      // Snapshot every handle — running entries' result.status stays
      // "running" so hydrate can detect them and reborn as failed.
      const handles: SerializedHandle[] = []
      for (const [id, e] of store.entries()) {
        handles.push({ id, spec: e.spec, result: serializeResult(e.result) })
      }
      const payload: SerializedScheduler = { v: 1, handles }
      return JSON.stringify(payload)
    },

    hydrate(json) {
      return restoreHandles(json, store, now, undefined)
    },

    hydrateWithPrune(json, maxAgeMs) {
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
      const restored = restoreHandles(json, store, now, maxAgeMs)
      const pruned = Math.max(0, totalValid - restored)
      return { restored, pruned }
    },

    forceBackground(id, forceOpts) {
      // Queue OFF ⇒ nothing can be queued ⇒ nothing to promote. Default path.
      if (!admissionQueue) return "queue_disabled"
      const entry = store.get(id)
      if (entry === undefined) return "not_found"
      // Running or terminal ⇒ no-op (no-throw sibling of cancel_subagent).
      if (entry.result.status !== "queued") return "already_running"

      const slotFree = countRunning() < maxConcurrent
      if (slotFree) {
        // A real slot is free — promote immediately, cap untouched.
        promote(entry)
        return "promoted_now"
      }

      const allowBurst = forceOpts?.allowBurst === true
      // R2 fail-closed: burst is a ONE-SLOT courtesy, never a bypass. We allow
      // a transient +1 over `maxConcurrent` but NEVER +2 — a second burst
      // while already over-cap degrades to `moved_to_front`.
      if (allowBurst && countRunning() <= maxConcurrent) {
        promote(entry)
        return "promoted_now"
      }

      // No slot, no (admissible) burst ⇒ re-order to the FIFO head so this
      // entry runs the instant the next slot frees, ahead of all other
      // waiters.
      moveToFront(id)
      return "moved_to_front"
    },
  }
}

/** Compare a handle's age-reference timestamp against threshold. Returns
 *  true when the handle PASSES the age filter (= should be restored). */
const passesAgeFilter = (h: SerializedHandle, threshold: number | undefined): boolean => {
  if (threshold === undefined) return true
  // Non-terminal entries (running | queued) have no `endedAt` — age them by
  // `startedAt` (a queued task abandoned past `maxAgeMs` is almost certainly
  // irrelevant, RFC §8 R4).
  const nonTerminal = h.result.status === "running" || h.result.status === "queued"
  const cutoffRef = nonTerminal ? h.result.startedAt : (h.result.endedAt ?? h.result.startedAt)
  return cutoffRef >= threshold
}

/** Build an `Entry.result` from a parsed handle. Running entries reborn as
 *  `failed` + `errorMessage="lost across restart"` (Promise object cannot
 *  be reconstructed across a process restart). */
const resurrectResult = (h: SerializedHandle, tNow: number): Entry["result"] => {
  // A `queued` entry (ADR-0487) has NO in-flight promise and never started its
  // runner; like a `running` entry it cannot resume across a process restart.
  // Reborn as `failed` "lost across restart" so a side-effecting task is NEVER
  // silently re-run (hellgate 9 / RFC §8 R5).
  if (h.result.status === "running" || h.result.status === "queued") {
    return {
      status: "failed",
      outputSummary: "(failed) lost across restart",
      errorMessage: LOST_ACROSS_RESTART,
      startedAt: h.result.startedAt,
      endedAt: tNow,
      turns: h.result.turns,
    }
  }
  return {
    status: h.result.status,
    outputSummary: h.result.outputSummary,
    startedAt: h.result.startedAt,
    turns: h.result.turns,
    ...(h.result.outputDetail !== undefined ? { outputDetail: h.result.outputDetail } : {}),
    ...(h.result.errorMessage !== undefined ? { errorMessage: h.result.errorMessage } : {}),
    ...(h.result.endedAt !== undefined ? { endedAt: h.result.endedAt } : {}),
  }
}

/** Wrap a parsed handle as a runner-less `Entry`. abortCtrl is a fresh stub
 *  (signal never observed); promise is already-resolved (no runner attached). */
const handleToEntry = (h: SerializedHandle, tNow: number): Entry => ({
  id: h.id,
  spec: h.spec,
  abortCtrl: new AbortController(),
  promise: Promise.resolve(),
  result: resurrectResult(h, tNow),
})

/** Worker for `hydrate` / `hydrateWithPrune`. Restores entries from `json`
 *  into `store`, optionally filtering by `maxAgeMs` (relative to `now()`).
 *  Running entries reborn as `failed` with `errorMessage="lost across
 *  restart"`. Returns count restored. NO-THROW on garbage input. */
const restoreHandles = (
  json: string,
  store: Map<SubagentHandleId, Entry>,
  now: () => number,
  maxAgeMs: number | undefined,
): number => {
  const parsed = safeJsonParse(json)
  if (parsed === undefined) return 0
  const rawHandles = validateSerializedPayload(parsed)
  if (rawHandles === undefined) return 0
  const tNow = now()
  const threshold = maxAgeMs !== undefined ? tNow - Math.max(0, maxAgeMs) : undefined
  let restored = 0
  for (const raw of rawHandles) {
    const h = parseHandle(raw)
    if (h === undefined) continue
    if (!passesAgeFilter(h, threshold)) continue
    store.set(h.id, handleToEntry(h, tNow))
    restored += 1
  }
  return restored
}
