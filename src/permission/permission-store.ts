/**
 * Permission state store (ADR-0046).
 *
 * File-backed JSON store for per-thread permissions, per-host agent modes,
 * and post-denial precedence records. Single file at `~/.quanta/permission-
 * state.json` (override via `QUANTA_PERMISSION_STATE`). Both env vars are
 * read via `runtimeConfig()` — the single legitimate `process.env` owner.
 *
 * Slice rules: pure `node:`-stdlib only (plus the slice-internal
 * `@/shared/runtime-config` ADR-frozen env reader). NO `@/storage`, NO
 * `@/memory` — `@/permission` MUST keep its dependency surface at the
 * minimum (see biome `noRestrictedImports` config). Persistence is a
 * deliberately simple read-modify-write of one JSON file with debounced
 * flush; no SQLite, no transactions. The whole state is bounded:
 *   - perThread     — one record per active thread (small N)
 *   - perHost       — one record per known host (smaller N)
 *   - deniedActions — keyed by `(threadId, actionSignature)` so a thread's
 *                     denial state is independent from its siblings'.
 *
 * Failure model:
 *   - Missing file at load    → start empty, no warning (cold-start).
 *   - Corrupt JSON            → start empty + write `.corrupt` sidecar so the
 *                               user can recover; never crash.
 *   - Schema-version mismatch → start empty + write `.unsupported-vN` sidecar
 *                               so future migration code has the prior bytes.
 *   - Write failure           → swallowed + warned (in-memory state is still
 *                               authoritative for the rest of the process).
 *   - Orphan `.tmp` from a crashed prior write → unlinked at next successful
 *                               `writeToDisk()` (cleanup-on-write).
 *
 * Concurrency:
 *   - Single in-process: writes go through `pendingFlush` serialization so a
 *     burst of mutations produces at most ONE rename per debounce window.
 *   - Multi-process (e.g. CLI + Tauri Desktop on the same `~/.quanta`):
 *     atomic `tmp + rename` prevents torn-write but NOT last-write-wins races.
 *     ADR-0046 §Trade-offs documents this as accepted (v3 = single-process);
 *     follow-up lockfile ADR queued when a multi-process surface ships.
 *
 * Tests can mint an isolated instance via `createPermissionStore({ filePath })`.
 * The production singleton is created by `getDefaultPermissionStore()`.
 */

import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { runtimeConfig } from "@/shared/runtime-config"

/** Current on-disk schema version. Bump when the JSON shape changes; add a
 *  parallel branch in {@link parseState} so older versions can be migrated
 *  in-place. A mismatch quarantines the file to `.unsupported-vN` and starts
 *  empty rather than corrupting data. */
const STATE_VERSION = 1 as const

/** Per-thread permission overrides (Codex's `heartbeat-thread-permissions-by-id`
 *  mapping). When the admissibility-gate sees a thread id with a record here,
 *  the record's `approvalPolicy` + `sandboxPolicy` take precedence over the
 *  global default and the per-host mode. */
export interface ThreadPermission {
  readonly approvalPolicy: "never" | "on-request" | "on-failure" | "always"
  readonly approvalsReviewer: "user" | "agent"
  readonly sandboxPolicy:
    | { type: "danger-full-access" }
    | { type: "read-only" }
    | { type: "workspace-write"; writableRoots?: string[]; networkAccess?: boolean }
}

/** Per-host agent-mode default (Codex's `agent-mode-by-host-id`). `host-id`
 *  resolution is the caller's responsibility — see `per-host-mode.ts`. */
export type HostAgentMode = "full-access" | "read-only" | "custom"

/** Post-denial precedence record. Keyed by `(threadId, actionSignature)` so
 *  a denial in one thread doesn't bleed into a sibling thread.
 *
 *  State machine: `recordDenial` → optional `recordRiskSeen` → optional
 *  `recordUserOverride`. `hasPostDenialOverride` only returns true when ALL
 *  three timestamps exist AND `seenRiskAt >= deniedAt` AND
 *  `userOverrideAt >= seenRiskAt` (sequence enforcement — see ADR-0046
 *  §Risks: the "user saw the risk" gate is what stops a malicious prompt
 *  from auto-overriding a denial). */
export interface DenialRecord {
  readonly threadId: string
  readonly actionSignature: string
  readonly deniedAt: number
  readonly deniedReason: string
  readonly seenRiskAt?: number
  readonly userOverrideAt?: number
}

/** Composite key for `deniedActions`. Stored as a single string so the JSON
 *  serialization is flat (objects-as-keys would round-trip lossily). */
const denialKey = (threadId: string, actionSignature: string): string =>
  `${threadId}::${actionSignature}`

export interface PermissionState {
  readonly version: typeof STATE_VERSION
  readonly perThread: Readonly<Record<string, ThreadPermission>>
  readonly perHost: Readonly<Record<string, HostAgentMode>>
  readonly deniedActions: Readonly<Record<string, DenialRecord>>
}

const emptyState = (): PermissionState => ({
  version: STATE_VERSION,
  perThread: Object.freeze({}),
  perHost: Object.freeze({}),
  deniedActions: Object.freeze({}),
})

/** Canonical JSON: object keys sorted lexicographically at every level so
 *  two structurally-equal payloads produce byte-identical bytes (the
 *  actionSignature must be stable across runs / processes / machines). */
const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    out[k] = canonicalize((value as Record<string, unknown>)[k])
  }
  return out
}

/** Stable action signature. The caller passes a structurally-meaningful
 *  projection of the call ({ tool, workdir, args }); the helper canonicalizes
 *  + hashes it to a hex string. Same input ⇒ same signature on every call,
 *  so a `recordDenial` in one process can be matched by `hasPostDenialOverride`
 *  in another (or by the same process after a reload).
 *
 *  Algorithm: sha256 of `JSON.stringify(canonicalize({ tool, workdir, args }))`.
 *  Truncated to 32 hex chars (128 bits) — collision-resistant enough for the
 *  per-thread scope. */
export const computeActionSignature = (input: {
  tool: string
  workdir: string
  args: unknown
}): string => {
  const canonical = JSON.stringify(
    canonicalize({ tool: input.tool, workdir: input.workdir, args: input.args }),
  )
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32)
}

const stderrWarn = (msg: string): void => {
  process.stderr.write(`[quanta] permission-store: ${msg}\n`)
}

/** Resolve the default state file path. `QUANTA_PERMISSION_STATE` overrides;
 *  otherwise `<QUANTA_HOME>/permission-state.json` (or `~/.quanta/permission-
 *  state.json` if `QUANTA_HOME` is unset — mirrors the Codex convention).
 *
 *  Both env vars are read via `runtimeConfig()` (ADR-frozen — single
 *  legitimate `process.env` owner). */
export const defaultStateFilePath = (): string => {
  const cfg = runtimeConfig()
  if (cfg.permissionStateFile !== undefined) return cfg.permissionStateFile
  const home = cfg.quantaHome ?? join(homedir(), ".quanta")
  return join(home, "permission-state.json")
}

/** Live mutable state. Public API returns frozen snapshots so the caller
 *  cannot corrupt the in-memory map by reference. */
interface MutableState {
  version: typeof STATE_VERSION
  perThread: Record<string, ThreadPermission>
  perHost: Record<string, HostAgentMode>
  deniedActions: Record<string, DenialRecord>
}

const cloneAsMutable = (state: PermissionState): MutableState => ({
  version: STATE_VERSION,
  perThread: { ...state.perThread },
  perHost: { ...state.perHost },
  deniedActions: { ...state.deniedActions },
})

const snapshot = (state: MutableState): PermissionState =>
  Object.freeze({
    version: STATE_VERSION,
    perThread: Object.freeze({ ...state.perThread }),
    perHost: Object.freeze({ ...state.perHost }),
    deniedActions: Object.freeze({ ...state.deniedActions }),
  })

/** Distinguished outcomes of `parseState`. The caller takes the right action
 *  per outcome — schema mismatch quarantines to a versioned sidecar so a
 *  future migration can recover, while malformed-shape just starts empty. */
type ParseOutcome =
  | { kind: "ok"; state: PermissionState }
  | { kind: "version-mismatch"; foundVersion: number | string | null }
  | { kind: "shape-invalid"; reason: string }

/** Validate a parsed JSON payload — soft-fail to an empty state when the
 *  shape is wrong rather than crash. Returns a distinguished outcome so the
 *  caller can write a useful sidecar (corrupt vs unsupported-version). */
const parseState = (raw: unknown): ParseOutcome => {
  if (raw === null || typeof raw !== "object") {
    return { kind: "shape-invalid", reason: "root must be a JSON object" }
  }
  const obj = raw as Record<string, unknown>
  const v = obj.version
  if (v !== STATE_VERSION) {
    return {
      kind: "version-mismatch",
      foundVersion: typeof v === "number" || typeof v === "string" ? v : null,
    }
  }
  const perThread = (obj.perThread as Record<string, ThreadPermission> | undefined) ?? {}
  const perHost = (obj.perHost as Record<string, HostAgentMode> | undefined) ?? {}
  const deniedActions = (obj.deniedActions as Record<string, DenialRecord> | undefined) ?? {}
  if (
    typeof perThread !== "object" ||
    typeof perHost !== "object" ||
    typeof deniedActions !== "object"
  ) {
    return {
      kind: "shape-invalid",
      reason: "perThread / perHost / deniedActions must each be objects",
    }
  }
  return {
    kind: "ok",
    state: Object.freeze({
      version: STATE_VERSION,
      perThread: Object.freeze({ ...perThread }),
      perHost: Object.freeze({ ...perHost }),
      deniedActions: Object.freeze({ ...deniedActions }),
    }),
  }
}

export interface PermissionStore {
  /** Initialize from disk. Safe to call multiple times — second call is a
   *  no-op once `load()` has resolved. */
  load(): Promise<void>
  /** Flush in-memory state to disk. Tests call this synchronously; production
   *  code relies on `flushDebounced()`. */
  flush(): Promise<void>
  /** Debounced flush (200ms). Each mutation schedules one. */
  flushDebounced(): void

  // -- Read API -------------------------------------------------------------
  snapshot(): PermissionState
  getThread(threadId: string): ThreadPermission | undefined
  getHost(hostId: string): HostAgentMode | undefined
  getDenial(threadId: string, actionSignature: string): DenialRecord | undefined
  /** Frozen list of every per-thread record. Order unspecified. */
  listThreads(): ReadonlyMap<string, ThreadPermission>
  /** Frozen list of every per-host mode. Order unspecified. */
  listHosts(): ReadonlyMap<string, HostAgentMode>
  /** Every denial record for `threadId` (empty when none). Order unspecified. */
  listThreadDenials(threadId: string): readonly DenialRecord[]

  // -- Write API ------------------------------------------------------------
  setThread(threadId: string, perm: ThreadPermission): void
  clearThread(threadId: string): void
  setHost(hostId: string, mode: HostAgentMode): void
  clearHost(hostId: string): void
  recordDenial(args: {
    threadId: string
    actionSignature: string
    deniedAt: number
    deniedReason: string
  }): void
  recordRiskSeen(threadId: string, actionSignature: string, seenRiskAt: number): void
  recordUserOverride(threadId: string, actionSignature: string, userOverrideAt: number): void
  clearDenial(threadId: string, actionSignature: string): void

  /** True when `(threadId, actionSignature)` has a complete override
   *  sequence: deniedAt ≤ seenRiskAt ≤ userOverrideAt. */
  hasPostDenialOverride(threadId: string, actionSignature: string): boolean

  /** Test seam: drop all in-memory state + remove the file. */
  reset(): Promise<void>
}

export interface CreatePermissionStoreOptions {
  /** Override the default state file path (test isolation). */
  filePath?: string
  /** Debounce window in ms (default 200). 0 ⇒ every mutation flushes
   *  immediately (test ergonomics). */
  debounceMs?: number
  /** Inject a fake clock (test). Defaults to `Date.now`. */
  now?: () => number
}

export const createPermissionStore = (opts: CreatePermissionStoreOptions = {}): PermissionStore => {
  const filePath = opts.filePath ?? defaultStateFilePath()
  const debounceMs = opts.debounceMs ?? 200
  let state: MutableState = cloneAsMutable(emptyState())
  let loaded = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFlush: Promise<void> | null = null

  /** Per-instance unique tmp suffix. Two stores sharing the same `filePath`
   *  (multi-process scenario) use DIFFERENT tmp paths so they don't clobber
   *  each other's in-flight write. The final `rename` is still last-write-
   *  wins (atomic), but neither write tears the JSON. */
  const tmpSuffix = `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  const tmpPath = `${filePath}${tmpSuffix}`

  /**
   * Atomic write: write to per-instance `.tmp.<pid>.<rand>`, then `rename`
   * over the final path. Avoids torn-write on crash AND prevents two
   * processes from clobbering each other's tmp file. On the unhappy path
   * the `.tmp` is unlinked so a crashed previous attempt can never linger.
   *
   * Concurrency:
   *   - Intra-process: serialized externally via {@link enqueueWrite} so two
   *     back-to-back mutations never `rename` over each other.
   *   - Multi-process: per-instance tmp suffix avoids tmp clobber; the final
   *     rename is still last-write-wins (see module comment).
   */
  const writeToDisk = async (): Promise<void> => {
    try {
      await mkdir(dirname(filePath), { recursive: true })
      const payload = JSON.stringify(snapshot(state), null, 2)
      await writeFile(tmpPath, payload, "utf8")
      await rename(tmpPath, filePath)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      stderrWarn(`flush failed (${filePath}): ${message}`)
      // Best-effort cleanup: remove a partial `.tmp` so the next write
      // starts from a clean slate (no orphan-tmp accumulation).
      try {
        await unlink(tmpPath)
      } catch {
        // tmp may not exist — that's fine.
      }
    }
  }

  /** True ⇨ a mutation since the last successful write is awaiting flush.
   *  Set by every mutating API, cleared right before `writeToDisk` is called.
   *  Used to skip "write nothing" rewrites in `flush()` so idempotent set*()
   *  cannot bump the file's mtime. */
  let dirty = false

  /**
   * Serialize writes through `pendingFlush`. A second mutation that arrives
   * while the first is in flight does NOT race a second `rename` — it queues
   * to run after the in-flight one resolves. Returns the promise of the
   * write that captured this mutation, so callers awaiting `flush()` see
   * their bytes hit disk.
   *
   * Behavior:
   *   - dirty + idle ⇒ start a fresh write, clear dirty.
   *   - dirty + in-flight ⇒ chain a new write after the current one
   *     (captures the latest state on the chained `writeToDisk` callback).
   *   - clean + in-flight ⇒ just return the in-flight promise (no double-write).
   *   - clean + idle ⇒ no-op (returns resolved promise).
   */
  const enqueueWrite = (): Promise<void> => {
    if (!dirty) return pendingFlush ?? Promise.resolve()
    const prior = pendingFlush ?? Promise.resolve()
    // Capture the dirty bit at queue time so a NEW mutation arriving while
    // we're awaiting `prior` still gets its own write (it re-sets dirty).
    dirty = false
    const next = prior.then(writeToDisk)
    pendingFlush = next.finally(() => {
      // Clear the slot ONLY if we were the most recent enqueue. A later
      // enqueue would have overwritten `pendingFlush` already.
      if (pendingFlush === next) pendingFlush = null
    })
    return next
  }

  const flush = async (): Promise<void> => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    // If a debounced write was queued but not yet started, run it now
    // (combined with any new mutations since). Also waits on any in-flight
    // write so `await flush()` is a true "bytes are durable" barrier.
    await enqueueWrite()
  }

  const flushDebounced = (): void => {
    dirty = true
    if (debounceMs <= 0) {
      // Tests with debounceMs:0 still serialize through the queue — fixes
      // the prior "fire-and-forget hits a deleted tmpdir during teardown"
      // noise by ensuring `await flush()` drains all queued writes.
      void enqueueWrite()
      return
    }
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      void enqueueWrite()
    }, debounceMs)
    // Don't keep the event loop alive solely for the flush.
    if (typeof (pendingTimer as { unref?: () => void }).unref === "function") {
      ;(pendingTimer as { unref?: () => void }).unref?.()
    }
  }

  /** Quarantine bytes to a versioned sidecar (`.corrupt`, `.unsupported-vN`).
   *  Best-effort — if the sidecar write fails we keep going with an empty
   *  state in memory. */
  const quarantine = async (suffix: string, raw: string): Promise<void> => {
    try {
      await writeFile(`${filePath}.${suffix}`, raw, "utf8")
    } catch {
      // best-effort — the in-memory state is still safe.
    }
  }

  /** Read bytes from disk OR signal "not present yet" via `null`. Surfaces
   *  unexpected IO errors (permission denied, EISDIR, …) to the caller as a
   *  warning rather than crashing the process. */
  const readRawState = async (): Promise<string | null> => {
    try {
      return await readFile(filePath, "utf8")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOENT") return null
      const message = e instanceof Error ? e.message : String(e)
      stderrWarn(`load failed (${filePath}): ${message} — starting empty`)
      return null
    }
  }

  /** Parse bytes already known to exist. Splits the three terminal cases so
   *  `load()` stays well under the complexity ceiling. */
  const parseRawState = async (raw: string): Promise<PermissionState | null> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      stderrWarn(`state file corrupt JSON (${filePath}): ${message} — starting empty`)
      await quarantine("corrupt", raw)
      return null
    }
    const outcome = parseState(parsed)
    if (outcome.kind === "ok") return outcome.state
    if (outcome.kind === "version-mismatch") {
      stderrWarn(
        `state file schema mismatch (${filePath}) — found version=${String(outcome.foundVersion)}, expected ${STATE_VERSION} — starting empty (quarantined)`,
      )
      await quarantine(`unsupported-v${String(outcome.foundVersion)}`, raw)
      return null
    }
    stderrWarn(`state file shape invalid (${filePath}): ${outcome.reason} — starting empty`)
    return null
  }

  const load = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    const raw = await readRawState()
    if (raw === null) {
      state = cloneAsMutable(emptyState())
      return
    }
    const validated = await parseRawState(raw)
    state = cloneAsMutable(validated ?? emptyState())
  }

  // -- Read API ---------------------------------------------------------------
  const getThread = (threadId: string): ThreadPermission | undefined => state.perThread[threadId]
  const getHost = (hostId: string): HostAgentMode | undefined => state.perHost[hostId]
  const getDenial = (threadId: string, actionSignature: string): DenialRecord | undefined =>
    state.deniedActions[denialKey(threadId, actionSignature)]

  const listThreads = (): ReadonlyMap<string, ThreadPermission> => {
    const m = new Map<string, ThreadPermission>()
    for (const [k, v] of Object.entries(state.perThread)) m.set(k, v)
    return m
  }
  const listHosts = (): ReadonlyMap<string, HostAgentMode> => {
    const m = new Map<string, HostAgentMode>()
    for (const [k, v] of Object.entries(state.perHost)) m.set(k, v)
    return m
  }
  const listThreadDenials = (threadId: string): readonly DenialRecord[] => {
    const out: DenialRecord[] = []
    for (const r of Object.values(state.deniedActions)) {
      if (r.threadId === threadId) out.push(r)
    }
    return out
  }

  /** Structural equality on `ThreadPermission`. Used by `setThread` to skip
   *  a redundant flush when the record didn't actually change — keeps the
   *  store idempotent (setting the same perm twice = single write). */
  const threadPermEqual = (a: ThreadPermission, b: ThreadPermission): boolean =>
    a.approvalPolicy === b.approvalPolicy &&
    a.approvalsReviewer === b.approvalsReviewer &&
    JSON.stringify(canonicalize(a.sandboxPolicy)) === JSON.stringify(canonicalize(b.sandboxPolicy))

  // -- Write API --------------------------------------------------------------
  const setThread = (threadId: string, perm: ThreadPermission): void => {
    const existing = state.perThread[threadId]
    if (existing !== undefined && threadPermEqual(existing, perm)) return // idempotent
    state.perThread[threadId] = perm
    flushDebounced()
  }
  const clearThread = (threadId: string): void => {
    if (state.perThread[threadId] === undefined) return // idempotent
    delete state.perThread[threadId]
    flushDebounced()
  }
  const setHost = (hostId: string, mode: HostAgentMode): void => {
    if (state.perHost[hostId] === mode) return // idempotent
    state.perHost[hostId] = mode
    flushDebounced()
  }
  const clearHost = (hostId: string): void => {
    if (state.perHost[hostId] === undefined) return // idempotent
    delete state.perHost[hostId]
    flushDebounced()
  }

  const recordDenial = (args: {
    threadId: string
    actionSignature: string
    deniedAt: number
    deniedReason: string
  }): void => {
    const key = denialKey(args.threadId, args.actionSignature)
    // Recording a fresh denial RESETS the override sequence — once we've
    // denied again, any prior `seenRiskAt`/`userOverrideAt` is stale.
    state.deniedActions[key] = {
      threadId: args.threadId,
      actionSignature: args.actionSignature,
      deniedAt: args.deniedAt,
      deniedReason: args.deniedReason,
    }
    flushDebounced()
  }

  const recordRiskSeen = (threadId: string, actionSignature: string, seenRiskAt: number): void => {
    const key = denialKey(threadId, actionSignature)
    const existing = state.deniedActions[key]
    if (existing === undefined) {
      // Recording risk-seen without a prior denial is a no-op (defensive).
      return
    }
    state.deniedActions[key] = { ...existing, seenRiskAt }
    flushDebounced()
  }

  const recordUserOverride = (
    threadId: string,
    actionSignature: string,
    userOverrideAt: number,
  ): void => {
    const key = denialKey(threadId, actionSignature)
    const existing = state.deniedActions[key]
    if (existing === undefined) return
    state.deniedActions[key] = { ...existing, userOverrideAt }
    flushDebounced()
  }

  const clearDenial = (threadId: string, actionSignature: string): void => {
    delete state.deniedActions[denialKey(threadId, actionSignature)]
    flushDebounced()
  }

  const hasPostDenialOverride = (threadId: string, actionSignature: string): boolean => {
    const rec = state.deniedActions[denialKey(threadId, actionSignature)]
    if (rec === undefined) return false
    if (rec.seenRiskAt === undefined || rec.userOverrideAt === undefined) return false
    // Sequence enforcement: deniedAt ≤ seenRiskAt ≤ userOverrideAt.
    if (rec.seenRiskAt < rec.deniedAt) return false
    if (rec.userOverrideAt < rec.seenRiskAt) return false
    return true
  }

  const reset = async (): Promise<void> => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    // Wait on any in-flight write so we don't unlink mid-rename — without
    // this, a flush queued by a recent set*() could resurrect the file we
    // just deleted (Heisenbug seen in stress tests).
    if (pendingFlush !== null) {
      try {
        await pendingFlush
      } catch {
        // Surfaced via stderrWarn already.
      }
    }
    state = cloneAsMutable(emptyState())
    loaded = false
    try {
      await unlink(filePath)
    } catch {
      // best-effort — file may not exist yet.
    }
  }

  return {
    load,
    flush,
    flushDebounced,
    snapshot: (): PermissionState => snapshot(state),
    getThread,
    getHost,
    getDenial,
    listThreads,
    listHosts,
    listThreadDenials,
    setThread,
    clearThread,
    setHost,
    clearHost,
    recordDenial,
    recordRiskSeen,
    recordUserOverride,
    clearDenial,
    hasPostDenialOverride,
    reset,
  }
}

// --- Process-wide singleton ------------------------------------------------

let defaultStore: PermissionStore | null = null

/** Singleton accessor. Tests must NOT use this — instead create an isolated
 *  store via `createPermissionStore({ filePath })`. */
export const getDefaultPermissionStore = (): PermissionStore => {
  if (defaultStore === null) defaultStore = createPermissionStore()
  return defaultStore
}

/** Test-only reset of the singleton (does not touch any on-disk file). */
export const __resetDefaultPermissionStore = (): void => {
  defaultStore = null
}
