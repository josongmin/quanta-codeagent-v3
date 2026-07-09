/**
 * Ticket 18 (V1) — background-turn portal.
 *
 * The PURE state store behind Ctrl+B ("move running turn to background") and the
 * `/background` slash. When a turn is detached, its live `body` promise + the
 * turn's `AbortController` are handed here; the portal registers a 'running'
 * entry, watches the promise to a terminal state, and exposes a READ-ONLY
 * `view()` projection the slash renders. It NEVER re-enters the agent loop and
 * imports NOTHING from `@/agent` — it is a passive observer.
 *
 * V1 scope (see ticket): keybinding + portal + read-only reattach. NOT V1:
 *   - persistence across restart (V2),
 *   - weave/live reattach that re-enters the turn (V3).
 *   V1 `reattach` is print-only (buffer + result/error), never re-awaits the
 *   body nor exposes the AbortController for mutation.
 *
 * The captured buffer is BOUNDED with a HEAD+TAIL window so a runaway stream can
 * never OOM the surface: the first {@link BG_BUFFER_MAX_BYTES}/2 bytes and the
 * last {@link BG_BUFFER_MAX_BYTES}/2 bytes are retained, with an `… +N KB elided …`
 * marker for the dropped middle. Naive newest-only buffering would lose the head
 * (the part that explains what the turn was doing).
 *
 * Slice posture: lives in the existing `@/apps/cli` slice (no new tsconfig
 * path / fence). Only `node:crypto` (the task-id mint) — no `@/...` value import.
 */

import { randomBytes } from "node:crypto"

/** 50 MiB ceiling on a single backgrounded turn's retained output. Named const
 *  (no inlined magic number). The window stores HEAD + TAIL halves of this. */
export const BG_BUFFER_MAX_BYTES = 50 * 1024 * 1024

/** WS-H / UUX-3-12 — LRU cap on SETTLED entries retained for post-hoc
 *  `/background reattach`. Settle must NOT mean instant deletion (the buffer
 *  exists precisely so a finished turn can be inspected), but the registry
 *  must not grow unboundedly either: when a settle pushes the settled
 *  population over this cap, the OLDEST-settled entry is evicted. RUNNING
 *  entries are never evicted (they own a live body promise). */
export const BG_SETTLED_ENTRIES_MAX = 20

/** The single env gate for the whole background-turn surface (portal +
 *  `/background` slash + the session-setup capture tee). Exported so the TWO
 *  composition roots (surface-compose, session-setup) read the SAME name —
 *  a drifting literal would silently split the feature (portal without
 *  capture = the exact dead-wire class UUX-3-01 was). */
export const BG_TURN_ENV_GATE = "QUANTA_BG_TURN"

/** Terminal lifecycle of a backgrounded turn. */
export type BackgroundTurnState = "running" | "done" | "failed" | "cancelled"

/** A live registry entry. `appendOutput`/`readBuffer`/`bufferedBytes` are the
 *  mutable seam the surface (turn stream tee) writes into; everything else is
 *  observed by the read-only view. Generic over the body result `R` (the
 *  surface's `RunOneTurnResult`-shaped payload) so no `@/agent` type leaks. */
export interface BackgroundTurnEntry<R = unknown> {
  readonly taskId: string
  readonly label: string
  state: BackgroundTurnState
  readonly startedAt: number
  readonly promise: Promise<R>
  readonly abort: AbortController
  result?: R
  error?: unknown
  /** Wall-clock of the body's settlement (set by the portal's observer the
   *  moment the state leaves 'running'). Drives the LRU prune order. */
  settledAt?: number
  /** Append a streamed-output chunk into the bounded HEAD+TAIL window. */
  appendOutput(chunk: string): void
  /** Render the bounded window (HEAD + elision marker + TAIL). */
  readBuffer(): string
  /** Bytes currently retained (<= {@link BG_BUFFER_MAX_BYTES}). */
  bufferedBytes(): number
}

/** Args to {@link BackgroundTurnPortal.detach}. The `promise` is the SAME live
 *  body promise the turn is still running (NOT re-awaited by the caller); the
 *  `abort` is the turn's own controller (firing it cancels the background body). */
export interface DetachArgs<R = unknown> {
  readonly label: string
  readonly promise: Promise<R>
  readonly abort: AbortController
}

/** Read-only projection a `/background` reattach yields. Print-only: buffer +
 *  result/error + a `running` flag. NO promise / AbortController exposure. */
export interface BackgroundReattach<R = unknown> {
  readonly taskId: string
  readonly label: string
  readonly state: BackgroundTurnState
  readonly running: boolean
  readonly buffer: string
  readonly result?: R
  readonly error?: unknown
}

/** A read-only row for the `/background list` table. */
export interface BackgroundTurnRow {
  readonly taskId: string
  readonly label: string
  readonly state: BackgroundTurnState
  readonly startedAt: number
  readonly bufferedBytes: number
}

/** The READ-ONLY surface threaded into `SlashContext.background`. It can list,
 *  inspect, reattach (print-only) and cancel — but it cannot detach a new turn
 *  nor re-enter the loop (those live on the full {@link BackgroundTurnPortal}). */
export interface BackgroundPortalView {
  list(): readonly BackgroundTurnRow[]
  get(id: string): BackgroundTurnRow | undefined
  /** Print-only reattach: the buffer + result/error. Does NOT re-enter the loop. */
  reattach(id: string): BackgroundReattach | undefined
  /** Fire the entry's AbortController (NO-THROW on unknown id). */
  cancel(id: string): void
}

/** The full (write-capable) portal the surface owns. */
export interface BackgroundTurnPortal {
  detach<R>(args: DetachArgs<R>): string
  list(): readonly BackgroundTurnEntry[]
  get(id: string): BackgroundTurnEntry | undefined
  reattach(id: string): BackgroundReattach | undefined
  cancel(id: string): void
  view(): BackgroundPortalView
}

/** Short, human-scannable task id (`task abcd`-style): a 4-hex `randomBytes`
 *  slice + a monotone counter so two detaches in the same ms never collide.
 *  `randomBytes` (not `Math.random`) per the repo's no-weak-rng id-mint rule. */
const makeTaskId = (seq: number): string => {
  const rand = randomBytes(2).toString("hex")
  return `${rand}${seq.toString(36)}`
}

/** Project an entry to its read-only table row. */
const toRow = (e: BackgroundTurnEntry): BackgroundTurnRow => ({
  taskId: e.taskId,
  label: e.label,
  state: e.state,
  startedAt: e.startedAt,
  bufferedBytes: e.bufferedBytes(),
})

/** Build the bounded HEAD+TAIL output buffer for one entry. Retains at most
 *  {@link BG_BUFFER_MAX_BYTES}: the first half as HEAD, the most-recent half as
 *  a ring TAIL. `readBuffer` stitches them with an elision marker. NO-THROW. */
/** UTF-8 byte length — the buffer cap is specified in BYTES, not UTF-16 units. */
const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8")

/** Keep the LAST `maxBytes` UTF-8 bytes of `s`. Buffer decode replaces a
 *  multibyte sequence split at the cut with U+FFFD instead of emitting a lone
 *  surrogate, so the result is always well-formed (no split surrogate pair). */
const keepLastBytes = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, "utf8")
  return buf.length <= maxBytes ? s : buf.subarray(buf.length - maxBytes).toString("utf8")
}

/** Split `s` after the FIRST `maxBytes` UTF-8 bytes ⇒ `{ head, rest }`. Both
 *  sides are well-formed; a char straddling the cut decodes to U+FFFD per side. */
const splitAtBytes = (s: string, maxBytes: number): { head: string; rest: string } => {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return { head: s, rest: "" }
  return {
    head: buf.subarray(0, maxBytes).toString("utf8"),
    rest: buf.subarray(maxBytes).toString("utf8"),
  }
}

export const makeBoundedBuffer = (
  maxBytes: number = BG_BUFFER_MAX_BYTES,
): {
  append(chunk: string): void
  read(): string
  bytes(): number
} => {
  const HALF = Math.floor(maxBytes / 2)
  let head = ""
  let tail = ""
  // Total bytes EVER appended — used to compute the elided middle for the marker.
  let totalAppended = 0
  return {
    append(chunk: string): void {
      if (chunk.length === 0) return
      totalAppended += utf8Len(chunk)
      // Fill HEAD up to HALF first (the start of the turn never gets dropped).
      // All accounting + slicing is in UTF-8 BYTES (surrogate-safe), matching
      // the byte cap the buffer advertises.
      if (utf8Len(head) < HALF) {
        const { head: take, rest: overflow } = splitAtBytes(chunk, HALF - utf8Len(head))
        head += take
        if (overflow.length > 0) tail = keepLastBytes(tail + overflow, HALF)
        return
      }
      // HEAD full ⇒ everything else rides the TAIL ring (newest HALF retained).
      tail = keepLastBytes(tail + chunk, HALF)
    },
    read(): string {
      const retained = utf8Len(head) + utf8Len(tail)
      const elided = totalAppended - retained
      if (elided <= 0) return head + tail
      const kb = Math.round(elided / 1024)
      return `${head}\n… +${kb} KB elided …\n${tail}`
    },
    bytes(): number {
      return utf8Len(head) + utf8Len(tail)
    },
  }
}

/**
 * Build a fresh portal. Each {@link detach} registers a 'running' entry and
 * attaches a NO-THROW `.then/.catch` that swallows the body outcome into the
 * entry's terminal state (`done`/`failed`/`cancelled`) — the original promise
 * keeps running, owned now by the portal, and a rejection NEVER escapes as an
 * unhandled rejection.
 */
export const createBackgroundTurnPortal = (
  opts: {
    /** Per-entry output-buffer byte cap. Default: {@link BG_BUFFER_MAX_BYTES}.
     *  Injectable so tests exercise the backpressure window without 50 MiB. */
    readonly bufferMaxBytes?: number
    /** Settled-entry LRU cap. Default: {@link BG_SETTLED_ENTRIES_MAX}. */
    readonly settledEntriesMax?: number
  } = {},
): BackgroundTurnPortal => {
  const entries = new Map<string, BackgroundTurnEntry>()
  const bufferMaxBytes = opts.bufferMaxBytes ?? BG_BUFFER_MAX_BYTES
  const settledEntriesMax = opts.settledEntriesMax ?? BG_SETTLED_ENTRIES_MAX
  let seq = 0

  /** UUX-3-12 — evict the oldest-SETTLED entries beyond the cap. Running
   *  entries never count and are never evicted. Called on every settle. */
  const pruneSettled = (): void => {
    const settled = [...entries.values()].filter((e) => e.state !== "running")
    if (settled.length <= settledEntriesMax) return
    settled.sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0))
    for (const evict of settled.slice(0, settled.length - settledEntriesMax)) {
      entries.delete(evict.taskId)
    }
  }

  const detach = <R>(args: DetachArgs<R>): string => {
    seq += 1
    const taskId = makeTaskId(seq)
    const buffer = makeBoundedBuffer(bufferMaxBytes)
    const entry: BackgroundTurnEntry<R> = {
      taskId,
      label: args.label,
      state: "running",
      startedAt: Date.now(),
      promise: args.promise,
      abort: args.abort,
      appendOutput: (chunk) => buffer.append(chunk),
      readBuffer: () => buffer.read(),
      bufferedBytes: () => buffer.bytes(),
    }
    entries.set(taskId, entry as unknown as BackgroundTurnEntry)
    // NO-THROW swallow: the body keeps running; we only OBSERVE its settlement.
    args.promise
      .then((r) => {
        entry.state = "done"
        entry.result = r
        entry.settledAt = Date.now()
        pruneSettled()
      })
      .catch((e: unknown) => {
        // An AbortError means the user backgrounded then cancelled (the body
        // unwound via its signal) — distinct from a genuine failure.
        entry.state = e instanceof Error && e.name === "AbortError" ? "cancelled" : "failed"
        entry.error = e
        entry.settledAt = Date.now()
        pruneSettled()
      })
    return taskId
  }

  const get = (id: string): BackgroundTurnEntry | undefined => entries.get(id)

  const reattach = (id: string): BackgroundReattach | undefined => {
    const e = entries.get(id)
    if (e === undefined) return undefined
    return {
      taskId: e.taskId,
      label: e.label,
      state: e.state,
      running: e.state === "running",
      buffer: e.readBuffer(),
      ...(e.result !== undefined ? { result: e.result } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
    }
  }

  const cancel = (id: string): void => {
    const e = entries.get(id)
    // NO-THROW on unknown id; abort() is idempotent on an already-aborted ctrl.
    if (e !== undefined && !e.abort.signal.aborted) e.abort.abort()
  }

  const list = (): readonly BackgroundTurnEntry[] => [...entries.values()]

  const view = (): BackgroundPortalView => ({
    list: () => list().map(toRow),
    get: (id) => {
      const e = entries.get(id)
      return e !== undefined ? toRow(e) : undefined
    },
    reattach,
    cancel,
  })

  return { detach, list, get, reattach, cancel, view }
}
