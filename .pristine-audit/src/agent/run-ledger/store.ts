/**
 * ADR-0395 — In-memory `RunLedgerPort` adapter.
 *
 * Zero-dep reference store. Pure model: no I/O, no imports from any peer slice.
 * Lives for the process — not persisted (a host may snapshot/restore via
 * `toSnapshot`/`fromSnapshot`).
 *
 * Design notes:
 *   - Frozen returns: every public method returns a frozen `RunEntry` (or a
 *     frozen array) so a reader cannot corrupt ledger state by mutating a
 *     returned reference.
 *   - NO-THROW: malformed input, unknown ids, and a throwing `now()` are all
 *     swallowed; the method returns `null` / the existing entry / `[]`.
 *   - Retention: settled entries are LRU-evicted (oldest `lastEventAt` first)
 *     once their count exceeds `maxRetained`. Active entries (running/waiting)
 *     never count toward the cap and are never evicted — mirrors TaskRegistry.
 *
 * Each public method stays under the cognitive-complexity cap by delegating
 * input-normalisation to the module-private pure helpers below.
 */

import type {
  RunArtifact,
  RunEntry,
  RunKind,
  RunLedgerPort,
  RunLedgerSnapshot,
  RunStatus,
  WaitingOn,
} from "./types"

/** Default cap on retained SETTLED entries before LRU eviction kicks in.
 *  Active (running/waiting) entries never count toward this and are never
 *  evicted. 256 fits typical long sessions without unbounded growth. */
const DEFAULT_MAX_RETAINED = 256

/** Closed allow-lists used by the NO-THROW guards. Anything outside these is
 *  silently ignored (we never throw on a bad enum value). */
const RUN_STATUS = new Set<RunStatus>(["running", "waiting", "completed", "failed", "stopped"])
const RUN_KIND = new Set<RunKind>(["shell", "subagent", "mcp_task", "exec"])
const WAITING_ON = new Set<WaitingOn>(["user", "tool", "network", "child_agent"])
const TERMINAL = new Set<RunStatus>(["completed", "failed", "stopped"])

const isActive = (s: RunStatus): boolean => s === "running" || s === "waiting"
const isTerminal = (s: RunStatus): boolean => TERMINAL.has(s)

/** Defensive artifact normaliser — only accepts a well-formed artifact. */
const cleanArtifact = (a: unknown): RunArtifact | null => {
  if (a === null || typeof a !== "object") return null
  const rec = a as Record<string, unknown>
  const { kind, ref } = rec
  if (kind !== "log" && kind !== "stdout" && kind !== "summary" && kind !== "file") return null
  if (typeof ref !== "string") return null
  return Object.freeze({ kind, ref })
}

/** Append an artifact to a list iff well-formed; otherwise return the list. */
const appendArtifact = (list: readonly RunArtifact[], raw: unknown): readonly RunArtifact[] => {
  if (raw === undefined) return list
  const art = cleanArtifact(raw)
  return art ? [...list, art] : list
}

/** Freeze an entry + its artifacts so a returned reference cannot mutate state. */
const freezeEntry = (e: RunEntry): RunEntry =>
  Object.freeze({ ...e, artifacts: Object.freeze([...e.artifacts]) })

/** A finite `Date.now()` with a 0 floor — used when the injected clock blows up. */
const safeDateNow = (): number => {
  try {
    const t = Date.now()
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

/** Minimal valid running entry used when `start` is handed garbage. */
const makeFallbackEntry = (at: number): RunEntry =>
  Object.freeze({
    id: "",
    kind: "exec" as RunKind,
    owner: "",
    title: "",
    status: "running" as RunStatus,
    startedAt: at,
    lastEventAt: at,
    artifacts: Object.freeze([]),
  })

/** Build the next entry for a `touch` patch (pure; clock value passed in). */
const applyTouch = (
  cur: RunEntry,
  patch: { status?: RunStatus; waitingOn?: WaitingOn; artifact?: RunArtifact },
  at: number,
): RunEntry => {
  const p = patch && typeof patch === "object" ? patch : {}
  const status = p.status !== undefined && RUN_STATUS.has(p.status) ? p.status : cur.status
  const waitingOn =
    p.waitingOn !== undefined && WAITING_ON.has(p.waitingOn) ? p.waitingOn : cur.waitingOn
  return {
    ...cur,
    status,
    lastEventAt: at,
    ...(waitingOn !== undefined ? { waitingOn } : {}),
    artifacts: appendArtifact(cur.artifacts, p.artifact),
  }
}

/** Build the next entry for a `settle` (pure; clock value passed in). */
const applySettle = (
  cur: RunEntry,
  status: "completed" | "failed" | "stopped",
  opts: { error?: string; artifact?: RunArtifact } | undefined,
  at: number,
): RunEntry => {
  const finalStatus = isTerminal(status) ? status : "completed"
  const o = opts && typeof opts === "object" ? opts : {}
  return {
    ...cur,
    status: finalStatus,
    lastEventAt: at,
    ...(typeof o.error === "string" ? { error: o.error } : {}),
    artifacts: appendArtifact(cur.artifacts, o.artifact),
  }
}

/** Build the running entry for a `start` (pure; clock value passed in). */
const applyStart = (
  init: { id: string; kind: RunKind; owner: string; title: string; resumeAction?: string },
  at: number,
): RunEntry => ({
  id: typeof init.id === "string" ? init.id : "",
  kind: RUN_KIND.has(init.kind) ? init.kind : "exec",
  owner: typeof init.owner === "string" ? init.owner : "",
  title: typeof init.title === "string" ? init.title : "",
  status: "running",
  startedAt: at,
  lastEventAt: at,
  artifacts: [],
  ...(typeof init.resumeAction === "string" ? { resumeAction: init.resumeAction } : {}),
})

/** Defensive snapshot-entry normaliser — only accepts a well-formed RunEntry. */
const cleanEntry = (e: unknown): RunEntry | null => {
  if (e === null || typeof e !== "object") return null
  const r = e as Record<string, unknown>
  if (typeof r.id !== "string") return null
  if (!RUN_KIND.has(r.kind as RunKind)) return null
  if (typeof r.owner !== "string" || typeof r.title !== "string") return null
  if (!RUN_STATUS.has(r.status as RunStatus)) return null
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) return null
  if (typeof r.lastEventAt !== "number" || !Number.isFinite(r.lastEventAt)) return null
  const artifacts = Array.isArray(r.artifacts)
    ? r.artifacts.map(cleanArtifact).filter((a): a is RunArtifact => a !== null)
    : []
  return Object.freeze({
    id: r.id,
    kind: r.kind as RunKind,
    owner: r.owner,
    title: r.title,
    status: r.status as RunStatus,
    startedAt: r.startedAt,
    lastEventAt: r.lastEventAt,
    artifacts: Object.freeze(artifacts),
    ...(WAITING_ON.has(r.waitingOn as WaitingOn) ? { waitingOn: r.waitingOn as WaitingOn } : {}),
    ...(typeof r.resumeAction === "string" ? { resumeAction: r.resumeAction } : {}),
    ...(typeof r.error === "string" ? { error: r.error } : {}),
  })
}

const matchesFilter = (
  e: RunEntry,
  f: { status?: RunStatus; kind?: RunKind; owner?: string },
): boolean => {
  if (f.status !== undefined && e.status !== f.status) return false
  if (f.kind !== undefined && e.kind !== f.kind) return false
  if (f.owner !== undefined && e.owner !== f.owner) return false
  return true
}

export const createRunLedger = (opts?: {
  now?: () => number
  maxRetained?: number
}): RunLedgerPort => {
  const entries = new Map<string, RunEntry>()
  const maxRetained =
    typeof opts?.maxRetained === "number" && opts.maxRetained >= 0
      ? opts.maxRetained
      : DEFAULT_MAX_RETAINED

  /** Defensive clock: a host-supplied `now` that throws or returns a
   *  non-finite value falls back to `Date.now()`, then to 0 — start/touch must
   *  never throw because the clock misbehaved. */
  const clock = (): number => {
    try {
      const t = opts?.now ? opts.now() : Date.now()
      return Number.isFinite(t) ? t : safeDateNow()
    } catch {
      return safeDateNow()
    }
  }

  const store = (e: RunEntry): RunEntry => {
    const frozen = freezeEntry(e)
    entries.set(frozen.id, frozen)
    return frozen
  }

  /** Drop oldest-`lastEventAt` SETTLED entries until the settled count is under
   *  the cap. Active entries are never considered. O(N log N) only on overflow. */
  const evictIfOverCap = (): void => {
    const settled: RunEntry[] = []
    for (const e of entries.values()) if (!isActive(e.status)) settled.push(e)
    if (settled.length <= maxRetained) return
    settled.sort((a, b) => a.lastEventAt - b.lastEventAt)
    const drop = settled.length - maxRetained
    for (let i = 0; i < drop; i++) {
      const e = settled[i]
      if (e) entries.delete(e.id)
    }
  }

  return {
    start(init): RunEntry {
      try {
        if (init === null || typeof init !== "object") return makeFallbackEntry(clock())
        return store(applyStart(init, clock()))
      } catch {
        return makeFallbackEntry(safeDateNow())
      }
    },

    touch(id, patch): RunEntry | null {
      try {
        const cur = entries.get(id)
        if (cur === undefined) return null
        // Settled entries are immutable — a stray touch must not resurrect.
        if (isTerminal(cur.status)) return cur
        const result = store(applyTouch(cur, patch, clock()))
        if (isTerminal(result.status)) evictIfOverCap()
        return result
      } catch {
        return null
      }
    },

    settle(id, status, opts2): RunEntry | null {
      try {
        const cur = entries.get(id)
        if (cur === undefined) return null
        // Idempotent: settling an already-settled entry is a no-op.
        if (isTerminal(cur.status)) return cur
        const result = store(applySettle(cur, status, opts2, clock()))
        evictIfOverCap()
        return result
      } catch {
        return null
      }
    },

    get(id): RunEntry | null {
      try {
        return entries.get(id) ?? null
      } catch {
        return null
      }
    },

    list(filter): readonly RunEntry[] {
      try {
        const f = filter && typeof filter === "object" ? filter : {}
        const out: RunEntry[] = []
        for (const e of entries.values()) if (matchesFilter(e, f)) out.push(e)
        return Object.freeze(out)
      } catch {
        return Object.freeze([])
      }
    },

    running(): readonly RunEntry[] {
      return this.list({ status: "running" })
    },

    waiting(): readonly RunEntry[] {
      return this.list({ status: "waiting" })
    },

    toSnapshot(): RunLedgerSnapshot {
      try {
        return Object.freeze({ entries: Object.freeze([...entries.values()]) })
      } catch {
        return Object.freeze({ entries: Object.freeze([]) })
      }
    },

    fromSnapshot(snap): void {
      try {
        if (snap === null || typeof snap !== "object") return
        const raw = (snap as RunLedgerSnapshot).entries
        if (!Array.isArray(raw)) return
        entries.clear()
        for (const e of raw) {
          const clean = cleanEntry(e)
          if (clean) entries.set(clean.id, clean)
        }
      } catch {
        // leave whatever survived; never throw
      }
    },
  }
}
