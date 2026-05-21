/**
 * Permission state store (ADR-0046).
 *
 * File-backed JSON store for per-thread permissions, per-host agent modes,
 * and post-denial precedence records. Single file at `~/.quanta/permission-
 * state.json` (override via `QUANTA_PERMISSION_STATE` env var — read directly,
 * not via runtime-config, because @/permission slice is depended on by very
 * early bootstrap paths and the runtime-config singleton may not yet be
 * frozen when the first permission probe fires; this is OK because the env
 * var is only ever read once at store construction).
 *
 * Slice rules: pure `node:`-stdlib only. NO `@/shared`, NO `@/storage`, NO
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
 *   - Missing file at load    → start empty, log via `stderrWarn`.
 *   - Corrupt JSON            → start empty + write `.corrupt` sidecar so the
 *                               user can recover; never crash.
 *   - Write failure           → swallowed + warned (in-memory state is still
 *                               authoritative for the rest of the process).
 *
 * Concurrency: the store is a single in-process singleton. Tests can mint
 * an isolated instance via `createPermissionStore({ filePath })`. The
 * production singleton is created by `getDefaultPermissionStore()`.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { runtimeConfig } from "@/shared/runtime-config"

const STATE_VERSION = 1

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

/** Validate a parsed JSON payload — soft-fail to an empty state when the
 *  shape is wrong rather than crash. */
const parseState = (raw: unknown): PermissionState | null => {
  if (raw === null || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  if (obj["version"] !== STATE_VERSION) return null
  const perThread = (obj["perThread"] as Record<string, ThreadPermission> | undefined) ?? {}
  const perHost = (obj["perHost"] as Record<string, HostAgentMode> | undefined) ?? {}
  const deniedActions = (obj["deniedActions"] as Record<string, DenialRecord> | undefined) ?? {}
  if (
    typeof perThread !== "object" ||
    typeof perHost !== "object" ||
    typeof deniedActions !== "object"
  ) {
    return null
  }
  return Object.freeze({
    version: STATE_VERSION,
    perThread: Object.freeze({ ...perThread }),
    perHost: Object.freeze({ ...perHost }),
    deniedActions: Object.freeze({ ...deniedActions }),
  })
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

  const writeToDisk = async (): Promise<void> => {
    try {
      await mkdir(dirname(filePath), { recursive: true })
      // Atomic write: write to tmp then rename. Avoids torn-write on crash.
      const tmp = `${filePath}.tmp`
      const payload = JSON.stringify(snapshot(state), null, 2)
      await writeFile(tmp, payload, "utf8")
      await rename(tmp, filePath)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      stderrWarn(`flush failed (${filePath}): ${message}`)
    }
  }

  const flush = async (): Promise<void> => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    if (pendingFlush !== null) {
      await pendingFlush
    }
    pendingFlush = writeToDisk()
    await pendingFlush
    pendingFlush = null
  }

  const flushDebounced = (): void => {
    if (debounceMs <= 0) {
      // Fire-and-forget; test code awaits `flush()` directly.
      void writeToDisk()
      return
    }
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      pendingFlush = writeToDisk()
    }, debounceMs)
    // Don't keep the event loop alive solely for the flush.
    if (typeof (pendingTimer as { unref?: () => void }).unref === "function") {
      ;(pendingTimer as { unref?: () => void }).unref?.()
    }
  }

  const load = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(filePath, "utf8")
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        stderrWarn(`state file corrupt JSON (${filePath}): ${message} — starting empty`)
        // Save the corrupt content alongside so the user can recover.
        try {
          await writeFile(`${filePath}.corrupt`, raw, "utf8")
        } catch {
          // best-effort
        }
        state = cloneAsMutable(emptyState())
        return
      }
      const validated = parseState(parsed)
      if (validated === null) {
        stderrWarn(`state file shape invalid (${filePath}) — starting empty`)
        state = cloneAsMutable(emptyState())
        return
      }
      state = cloneAsMutable(validated)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        // First run — no warning, just start empty.
        state = cloneAsMutable(emptyState())
        return
      }
      const message = e instanceof Error ? e.message : String(e)
      stderrWarn(`load failed (${filePath}): ${message} — starting empty`)
      state = cloneAsMutable(emptyState())
    }
  }

  // -- Read API ---------------------------------------------------------------
  const getThread = (threadId: string): ThreadPermission | undefined => state.perThread[threadId]
  const getHost = (hostId: string): HostAgentMode | undefined => state.perHost[hostId]
  const getDenial = (threadId: string, actionSignature: string): DenialRecord | undefined =>
    state.deniedActions[denialKey(threadId, actionSignature)]

  // -- Write API --------------------------------------------------------------
  const setThread = (threadId: string, perm: ThreadPermission): void => {
    state.perThread[threadId] = perm
    flushDebounced()
  }
  const clearThread = (threadId: string): void => {
    delete state.perThread[threadId]
    flushDebounced()
  }
  const setHost = (hostId: string, mode: HostAgentMode): void => {
    state.perHost[hostId] = mode
    flushDebounced()
  }
  const clearHost = (hostId: string): void => {
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
    state = cloneAsMutable(emptyState())
    loaded = false
    try {
      const { unlink } = await import("node:fs/promises")
      await unlink(filePath)
    } catch {
      // best-effort
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
