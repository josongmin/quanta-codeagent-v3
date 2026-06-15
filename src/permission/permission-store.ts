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
 * Composition (refactor #3): `createPermissionStore` is the composition point.
 * It owns ONE live `MutableState` + ONE {@link JsonStateFile} persistence
 * engine (atomic write / debounce / quarantine / parse-migrate), and layers
 * three thin domain modules over them:
 *   - {@link createThreadStore} — per-thread permissions.
 *   - {@link createHostStore}   — per-host agent modes.
 *   - {@link createDenialLedger}— post-denial precedence (the 3-timestamp
 *     state machine, security-sensitive — preserved byte-identical).
 * The public {@link PermissionStore} interface is unchanged so all external
 * consumers keep working.
 *
 * Failure model (delegated to {@link JsonStateFile}):
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

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { runtimeConfig } from "@/shared/runtime-config"
import { createJsonStateFile, type ParseOutcome } from "./json-state-file"

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

/** Resolve the default state file path. `QUANTA_PERMISSION_STATE` overrides;
 *  otherwise `<QUANTA_HOME>/permission-state.json` (or `~/.quanta/permission-
 *  state.json` if `QUANTA_HOME` is unset — mirrors the Codex convention).
 *
 *  Both env vars are read via `runtimeConfig()` (ADR-frozen — single
 *  legitimate `process.env` owner). */
export const defaultStateFilePath = (): string => {
  const cfg = runtimeConfig()
  if (cfg.permissionStateFile !== undefined) return cfg.permissionStateFile
  // Unified home root: QUANTA_CONFIG_DIR (canonical) ?? QUANTA_HOME (alias) ??
  // ~/.quanta. Resolved from the injected `cfg` so test-injected runtime config
  // is honored (rather than the global quantaHomeDir() singleton).
  const home = cfg.centralConfigDir ?? cfg.quantaHome ?? join(homedir(), ".quanta")
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

type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string }

const validationOk = <T>(value: T): ValidationResult<T> => ({ ok: true, value })

const validationError = <T = never>(reason: string): ValidationResult<T> => ({
  ok: false,
  reason,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

const isApprovalPolicy = (value: unknown): value is ThreadPermission["approvalPolicy"] =>
  value === "never" || value === "on-request" || value === "on-failure" || value === "always"

const isApprovalsReviewer = (value: unknown): value is ThreadPermission["approvalsReviewer"] =>
  value === "user" || value === "agent"

const validateSandboxPolicy = (
  value: unknown,
  path: string,
): ValidationResult<ThreadPermission["sandboxPolicy"]> => {
  if (!isRecord(value)) {
    return validationError(`${path}.sandboxPolicy must be an object`)
  }
  switch (value.type) {
    case "danger-full-access":
      return validationOk({ type: "danger-full-access" })
    case "read-only":
      return validationOk({ type: "read-only" })
    case "workspace-write": {
      const writableRoots = value.writableRoots
      if (writableRoots !== undefined && !isStringArray(writableRoots)) {
        return validationError(`${path}.sandboxPolicy.writableRoots must be a string array`)
      }
      const networkAccess = value.networkAccess
      if (networkAccess !== undefined && typeof networkAccess !== "boolean") {
        return validationError(`${path}.sandboxPolicy.networkAccess must be boolean`)
      }
      return validationOk({
        type: "workspace-write",
        ...(writableRoots !== undefined ? { writableRoots: [...writableRoots] } : {}),
        ...(networkAccess !== undefined ? { networkAccess } : {}),
      })
    }
    default:
      return validationError(`${path}.sandboxPolicy.type must be a known sandbox policy`)
  }
}

const validateThreadPermission = (
  value: unknown,
  path: string,
): ValidationResult<ThreadPermission> => {
  if (!isRecord(value)) return validationError(`${path} must be an object`)
  const approvalPolicy = value.approvalPolicy
  if (!isApprovalPolicy(approvalPolicy)) {
    return validationError(`${path}.approvalPolicy must be a known policy string`)
  }
  const approvalsReviewer = value.approvalsReviewer
  if (!isApprovalsReviewer(approvalsReviewer)) {
    return validationError(`${path}.approvalsReviewer must be 'user' or 'agent'`)
  }
  const sandboxPolicyResult = validateSandboxPolicy(value.sandboxPolicy, path)
  if (!sandboxPolicyResult.ok) return sandboxPolicyResult

  return validationOk({
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy: sandboxPolicyResult.value,
  })
}

const validateHostAgentMode = (value: unknown, path: string): ValidationResult<HostAgentMode> => {
  if (value !== "full-access" && value !== "read-only" && value !== "custom") {
    return validationError(`${path} must be a known host mode`)
  }
  return validationOk(value)
}

const validateDenialRecord = (
  value: unknown,
  path: string,
  key: string,
): ValidationResult<DenialRecord> => {
  if (!isRecord(value)) return validationError(`${path} must be an object`)
  if (typeof value.threadId !== "string") {
    return validationError(`${path}.threadId must be a string`)
  }
  if (typeof value.actionSignature !== "string") {
    return validationError(`${path}.actionSignature must be a string`)
  }
  const expectedKey = denialKey(value.threadId, value.actionSignature)
  if (key !== expectedKey) {
    return validationError(`${path} key must match threadId/actionSignature`)
  }
  if (!isFiniteNumber(value.deniedAt)) {
    return validationError(`${path}.deniedAt must be a finite number`)
  }
  if (typeof value.deniedReason !== "string") {
    return validationError(`${path}.deniedReason must be a string`)
  }
  if (value.seenRiskAt !== undefined && !isFiniteNumber(value.seenRiskAt)) {
    return validationError(`${path}.seenRiskAt must be a finite number`)
  }
  if (value.userOverrideAt !== undefined && !isFiniteNumber(value.userOverrideAt)) {
    return validationError(`${path}.userOverrideAt must be a finite number`)
  }
  return validationOk({
    threadId: value.threadId,
    actionSignature: value.actionSignature,
    deniedAt: value.deniedAt,
    deniedReason: value.deniedReason,
    ...(value.seenRiskAt !== undefined ? { seenRiskAt: value.seenRiskAt } : {}),
    ...(value.userOverrideAt !== undefined ? { userOverrideAt: value.userOverrideAt } : {}),
  })
}

const validateStateMap = <T>(
  value: unknown,
  path: string,
  validateEntry: (entry: unknown, entryPath: string, key: string) => ValidationResult<T>,
): ValidationResult<Record<string, T>> => {
  if (!isRecord(value)) return validationError(`${path} must be an object`)
  const out: Record<string, T> = {}
  for (const [key, entry] of Object.entries(value)) {
    const validated = validateEntry(entry, `${path}.${key}`, key)
    if (!validated.ok) return validated
    out[key] = validated.value
  }
  return validationOk(out)
}

/** Validate a parsed JSON payload — soft-fail to an empty state when the
 *  shape is wrong rather than crash. Returns a distinguished outcome so the
 *  {@link JsonStateFile} engine can write a useful sidecar (corrupt vs
 *  unsupported-version). */
const parseState = (raw: unknown): ParseOutcome<PermissionState> => {
  if (!isRecord(raw)) {
    return { kind: "shape-invalid", reason: "root must be a JSON object" }
  }
  const v = raw.version
  if (v !== STATE_VERSION) {
    return {
      kind: "version-mismatch",
      foundVersion: typeof v === "number" || typeof v === "string" ? v : null,
    }
  }
  const perThreadValidated = validateStateMap(
    raw.perThread ?? {},
    "perThread",
    (entry, entryPath) => validateThreadPermission(entry, entryPath),
  )
  if (!perThreadValidated.ok) return { kind: "shape-invalid", reason: perThreadValidated.reason }
  const perHostValidated = validateStateMap(raw.perHost ?? {}, "perHost", (entry, entryPath) =>
    validateHostAgentMode(entry, entryPath),
  )
  if (!perHostValidated.ok) return { kind: "shape-invalid", reason: perHostValidated.reason }
  const deniedActionsValidated = validateStateMap(
    raw.deniedActions ?? {},
    "deniedActions",
    (entry, entryPath, key) => validateDenialRecord(entry, entryPath, key),
  )
  if (!deniedActionsValidated.ok) {
    return { kind: "shape-invalid", reason: deniedActionsValidated.reason }
  }
  return {
    kind: "ok",
    state: Object.freeze({
      version: STATE_VERSION,
      perThread: Object.freeze(perThreadValidated.value),
      perHost: Object.freeze(perHostValidated.value),
      deniedActions: Object.freeze(deniedActionsValidated.value),
    }),
  }
}

/** Narrow read-only view of the store — just the methods the permission
 *  policy resolver (`evaluateStack`) consults (ISP, refactor #3). Concrete
 *  {@link PermissionStore} implements this union; callers that only read
 *  (e.g. `EvaluateStackOptions.store`) accept the narrow interface so they
 *  cannot accidentally mutate the store. */
export interface PermissionReader {
  /** True when `(threadId, actionSignature)` has a complete override
   *  sequence: deniedAt ≤ seenRiskAt ≤ userOverrideAt. */
  hasPostDenialOverride(threadId: string, actionSignature: string): boolean
  getThread(threadId: string): ThreadPermission | undefined
  getHost(hostId: string): HostAgentMode | undefined
}

export interface PermissionStore extends PermissionReader {
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

/* ------------------------------------------------------------------------- *
 * Domain module: per-thread permissions.
 * ------------------------------------------------------------------------- */

/** Structural equality on `ThreadPermission`. Used by `setThread` to skip
 *  a redundant flush when the record didn't actually change — keeps the
 *  store idempotent (setting the same perm twice = single write). */
const threadPermEqual = (a: ThreadPermission, b: ThreadPermission): boolean =>
  a.approvalPolicy === b.approvalPolicy &&
  a.approvalsReviewer === b.approvalsReviewer &&
  JSON.stringify(canonicalize(a.sandboxPolicy)) === JSON.stringify(canonicalize(b.sandboxPolicy))

const createThreadStore = (
  state: () => MutableState,
  onMutate: () => void,
): {
  get(threadId: string): ThreadPermission | undefined
  list(): ReadonlyMap<string, ThreadPermission>
  set(threadId: string, perm: ThreadPermission): void
  clear(threadId: string): void
} => ({
  get: (threadId) => state().perThread[threadId],
  list: () => {
    const m = new Map<string, ThreadPermission>()
    for (const [k, v] of Object.entries(state().perThread)) m.set(k, v)
    return m
  },
  set: (threadId, perm) => {
    const existing = state().perThread[threadId]
    if (existing !== undefined && threadPermEqual(existing, perm)) return // idempotent
    state().perThread[threadId] = perm
    onMutate()
  },
  clear: (threadId) => {
    if (state().perThread[threadId] === undefined) return // idempotent
    delete state().perThread[threadId]
    onMutate()
  },
})

/* ------------------------------------------------------------------------- *
 * Domain module: per-host agent modes.
 * ------------------------------------------------------------------------- */

const createHostStore = (
  state: () => MutableState,
  onMutate: () => void,
): {
  get(hostId: string): HostAgentMode | undefined
  list(): ReadonlyMap<string, HostAgentMode>
  set(hostId: string, mode: HostAgentMode): void
  clear(hostId: string): void
} => ({
  get: (hostId) => state().perHost[hostId],
  list: () => {
    const m = new Map<string, HostAgentMode>()
    for (const [k, v] of Object.entries(state().perHost)) m.set(k, v)
    return m
  },
  set: (hostId, mode) => {
    if (state().perHost[hostId] === mode) return // idempotent
    state().perHost[hostId] = mode
    onMutate()
  },
  clear: (hostId) => {
    if (state().perHost[hostId] === undefined) return // idempotent
    delete state().perHost[hostId]
    onMutate()
  },
})

/* ------------------------------------------------------------------------- *
 * Domain module: post-denial precedence ledger.
 *
 * The 3-timestamp state machine (deniedAt → seenRiskAt → userOverrideAt) is
 * the most logic-dense + security-sensitive part of the store. Behavior is
 * preserved byte-identical: `recordDenial` resets the sequence, risk/override
 * recording is a no-op without a prior denial, and `hasPostDenialOverride`
 * enforces deniedAt ≤ seenRiskAt ≤ userOverrideAt.
 * ------------------------------------------------------------------------- */

const createDenialLedger = (
  state: () => MutableState,
  onMutate: () => void,
): {
  get(threadId: string, actionSignature: string): DenialRecord | undefined
  listForThread(threadId: string): readonly DenialRecord[]
  recordDenial(args: {
    threadId: string
    actionSignature: string
    deniedAt: number
    deniedReason: string
  }): void
  recordRiskSeen(threadId: string, actionSignature: string, seenRiskAt: number): void
  recordUserOverride(threadId: string, actionSignature: string, userOverrideAt: number): void
  clear(threadId: string, actionSignature: string): void
  hasOverride(threadId: string, actionSignature: string): boolean
} => ({
  get: (threadId, actionSignature) => state().deniedActions[denialKey(threadId, actionSignature)],
  listForThread: (threadId) => {
    const out: DenialRecord[] = []
    for (const r of Object.values(state().deniedActions)) {
      if (r.threadId === threadId) out.push(r)
    }
    return out
  },
  recordDenial: (args) => {
    const key = denialKey(args.threadId, args.actionSignature)
    // Recording a fresh denial RESETS the override sequence — once we've
    // denied again, any prior `seenRiskAt`/`userOverrideAt` is stale.
    state().deniedActions[key] = {
      threadId: args.threadId,
      actionSignature: args.actionSignature,
      deniedAt: args.deniedAt,
      deniedReason: args.deniedReason,
    }
    onMutate()
  },
  recordRiskSeen: (threadId, actionSignature, seenRiskAt) => {
    const key = denialKey(threadId, actionSignature)
    const existing = state().deniedActions[key]
    if (existing === undefined) {
      // Recording risk-seen without a prior denial is a no-op (defensive).
      return
    }
    state().deniedActions[key] = { ...existing, seenRiskAt }
    onMutate()
  },
  recordUserOverride: (threadId, actionSignature, userOverrideAt) => {
    const key = denialKey(threadId, actionSignature)
    const existing = state().deniedActions[key]
    if (existing === undefined) return
    state().deniedActions[key] = { ...existing, userOverrideAt }
    onMutate()
  },
  clear: (threadId, actionSignature) => {
    delete state().deniedActions[denialKey(threadId, actionSignature)]
    onMutate()
  },
  hasOverride: (threadId, actionSignature) => {
    const rec = state().deniedActions[denialKey(threadId, actionSignature)]
    if (rec === undefined) return false
    if (rec.seenRiskAt === undefined || rec.userOverrideAt === undefined) return false
    // Sequence enforcement: deniedAt ≤ seenRiskAt ≤ userOverrideAt.
    if (rec.seenRiskAt < rec.deniedAt) return false
    if (rec.userOverrideAt < rec.seenRiskAt) return false
    return true
  },
})

/* ------------------------------------------------------------------------- *
 * Multi-process read-reconcile-MERGE (ADR-0046 follow-up: clobber fix).
 *
 * Two agent processes sharing `~/.quanta/permission-state.json` each load once,
 * mutate in-memory, then flush via tmp+rename. The rename is atomic but a BLIND
 * overwrite — process B's flush silently discarded grants/denials A wrote in
 * between. We turn that into last-write-MERGE by re-reading the on-disk state
 * at flush time and folding it into our payload with these per-sub-store rules:
 *
 *   - perThread / perHost grants — 3-WAY merge (peer-added vs locally-deleted):
 *       · a key on disk that is NOT in our baseline ⇒ a PEER added it ⇒ adopt
 *         (UNION — never drop a peer's grant).
 *       · a key in our baseline that WE removed in-memory ⇒ our revocation wins
 *         (we do NOT resurrect a grant we deliberately cleared — fail toward
 *         MORE restriction, per the security rule).
 *       · a key we currently hold ⇒ our value wins (we are the live writer).
 *
 *   - deniedActions ledger — denials are SECURITY-CRITICAL and must NEVER be
 *     lost (losing a denial = silently re-allowing). So this is NOT a 3-way
 *     merge: it is a most-restrictive UNION that ignores local deletions of a
 *     peer's denial. Per `(threadId, actionSignature)` key:
 *       · only one side has it ⇒ keep that record.
 *       · both sides have it ⇒ keep the record whose `deniedAt` is LATEST (a
 *         fresh `recordDenial` supersedes — it intentionally resets the
 *         override sequence), then re-attach the override timestamps
 *         (`seenRiskAt`/`userOverrideAt`) ONLY when they belong to that same
 *         (latest) denial generation, taking the max of each. This guarantees
 *         neither side's denial is dropped AND a stale peer can never resurrect
 *         an override sequence that a newer denial reset.
 *
 * SINGLE-PROCESS IDENTITY LAW: when we are the only writer, the file we re-read
 * deep-equals our `baseline` (we wrote it last), so: every disk key is in
 * baseline (nothing to adopt), nothing was locally deleted that isn't already
 * gone, and every denial generation matches ⇒ the merge returns exactly the
 * in-memory state. Byte-identical to the legacy blind-overwrite. (Verified by
 * the full existing suite passing unchanged.)
 * ------------------------------------------------------------------------- */

/** Override-sequence progress of ONE denial record, ranked so the merge can
 *  pick the more-advanced side WITHOUT cross-contaminating fields. The override
 *  pair (`seenRiskAt`, `userOverrideAt`) is only ever advanced as an ATOMIC
 *  unit by a single complete state machine (`recordDenial` → `recordRiskSeen`
 *  → `recordUserOverride`), so the merge must treat it as an indivisible pair
 *  belonging to ONE writer — never assemble a sequence from halves of two.
 *
 *  Ranks (higher = more advanced, but ONLY among COHERENT progress):
 *    2 — complete + coherent: deniedAt ≤ seenRiskAt ≤ userOverrideAt.
 *    1 — risk-seen + coherent: seenRiskAt present (≥ deniedAt), no override.
 *    0 — no coherent progress: empty, OR any incoherent shape (override
 *        without a seen step, seenRiskAt < deniedAt, override < seenRiskAt).
 *
 *  An incoherent record (rank 0) MUST NOT contribute its half-fields to the
 *  fold — that is exactly the fabricated-override bypass we are closing. */
const overrideProgressRank = (rec: DenialRecord): 0 | 1 | 2 => {
  const { deniedAt, seenRiskAt, userOverrideAt } = rec
  if (userOverrideAt !== undefined) {
    // A user-override step is only real when it sits atop a coherent seen step.
    if (seenRiskAt === undefined) return 0
    if (seenRiskAt < deniedAt) return 0
    if (userOverrideAt < seenRiskAt) return 0
    return 2
  }
  if (seenRiskAt !== undefined) {
    if (seenRiskAt < deniedAt) return 0
    return 1
  }
  return 0
}

/** Pick the more-advanced denial record for a key present on BOTH sides. A
 *  newer `deniedAt` supersedes (the reset semantics of `recordDenial`); when
 *  the two denials are the same generation (equal `deniedAt`) we adopt the
 *  override pair from whichever single side holds the most-advanced COHERENT
 *  progress — never combining one side's `seenRiskAt` with the other side's
 *  `userOverrideAt`. A stale peer's override timestamps are dropped when our
 *  `deniedAt` is newer. */
const mergeDenialRecord = (a: DenialRecord, b: DenialRecord): DenialRecord => {
  // The record with the strictly-later denial wins its base fields; its
  // override timestamps belong to that generation.
  const [newer, older] = a.deniedAt >= b.deniedAt ? [a, b] : [b, a]
  if (newer.deniedAt > older.deniedAt) {
    // Different generations: the older record's seen/override are stale (the
    // newer denial reset the sequence). Keep ONLY the newer record's fields.
    return newer
  }
  // Same generation (equal deniedAt): carry the override pair as an ATOMIC unit
  // from the single side with the most-advanced COHERENT progress. Folding the
  // two pairs independently (max of each field) would fabricate a complete
  // sequence that NEITHER process actually completed — fail-closed: a partial
  // or incoherent fold must NOT yield hasPostDenialOverride=true.
  const rankA = overrideProgressRank(a)
  const rankB = overrideProgressRank(b)
  // Tie on rank ⇒ prefer `a` (the live-side record on the caller's tie
  // convention) so the choice is deterministic. Both coherent records of the
  // same rank are equivalently safe; we never blend them.
  const winner = rankB > rankA ? b : a
  const merged: DenialRecord = {
    threadId: newer.threadId,
    actionSignature: newer.actionSignature,
    deniedAt: newer.deniedAt,
    // deniedReason is informational; prefer the newer record's (a's on tie).
    deniedReason: newer.deniedReason,
    // Carry the override timestamps ONLY from the winning side, ONLY when its
    // progress is coherent (rank > 0). A rank-0 record contributes nothing —
    // the merged record stays at the bare-denial state (no override).
    ...(rankA === 0 && rankB === 0
      ? {}
      : {
          ...(winner.seenRiskAt !== undefined ? { seenRiskAt: winner.seenRiskAt } : {}),
          ...(winner.userOverrideAt !== undefined ? { userOverrideAt: winner.userOverrideAt } : {}),
        }),
  }
  return merged
}

/** 3-way merge of a grant map (perThread / perHost). `inMemory` is the live
 *  authoritative base; a disk key absent from `baseline` is peer-added (adopt);
 *  a baseline key WE removed stays removed (revocation wins). */
const mergeGrantMap = <V>(
  onDisk: Readonly<Record<string, V>>,
  inMemory: Readonly<Record<string, V>>,
  baseline: Readonly<Record<string, V>>,
): Record<string, V> => {
  // Start from our live state — our values win for keys we currently hold.
  const out: Record<string, V> = { ...inMemory }
  for (const [k, v] of Object.entries(onDisk)) {
    if (k in out) continue // we hold it ⇒ our value wins.
    if (k in baseline) continue // we knew it + dropped it ⇒ revocation wins.
    out[k] = v // peer-added since our baseline ⇒ adopt (never drop a grant).
  }
  return out
}

/** Reconcile the on-disk state with our in-memory state per the documented
 *  per-sub-store policy. Pure; satisfies the single-process identity law. */
const mergePermissionState = (args: {
  onDisk: PermissionState | null
  inMemory: PermissionState
  baseline: PermissionState | null
}): PermissionState => {
  const { onDisk, inMemory } = args
  // No readable peer state (absent / corrupt / mismatch) ⇒ write our own. A
  // corrupt peer file must NOT wipe us, and we have nothing to merge in.
  if (onDisk === null) return inMemory
  const baseline = args.baseline ?? emptyState()

  const perThread = mergeGrantMap(onDisk.perThread, inMemory.perThread, baseline.perThread)
  const perHost = mergeGrantMap(onDisk.perHost, inMemory.perHost, baseline.perHost)

  // Denials: most-restrictive UNION — start from our live ledger, then fold in
  // every disk denial (a peer's denial we don't have, or a more-advanced
  // version of one we share). We deliberately do NOT honor a local delete of a
  // denial here: a disk denial is preserved even if absent from memory.
  const deniedActions: Record<string, DenialRecord> = { ...inMemory.deniedActions }
  for (const [key, diskRec] of Object.entries(onDisk.deniedActions)) {
    const ours = deniedActions[key]
    deniedActions[key] = ours === undefined ? diskRec : mergeDenialRecord(ours, diskRec)
  }

  return Object.freeze({
    version: STATE_VERSION,
    perThread: Object.freeze(perThread),
    perHost: Object.freeze(perHost),
    deniedActions: Object.freeze(deniedActions),
  })
}

export const createPermissionStore = (opts: CreatePermissionStoreOptions = {}): PermissionStore => {
  const filePath = opts.filePath ?? defaultStateFilePath()
  const debounceMs = opts.debounceMs ?? 200
  let state: MutableState = cloneAsMutable(emptyState())
  let persistedState: PermissionState | null = null

  // ONE persistence engine + ONE file handle, shared by all three domains.
  const file = createJsonStateFile<PermissionState>({
    filePath,
    debounceMs,
    emptyState,
    serialize: (s) => JSON.stringify(s, null, 2),
    parse: parseState,
    stateVersion: STATE_VERSION,
    mergeWithDisk: ({ onDisk, inMemory }) => {
      const merged = mergePermissionState({
        onDisk,
        inMemory,
        baseline: persistedState,
      })
      // Promote the merged snapshot into live memory during the flush path so
      // current readers observe peer-adopted records without waiting for a reload.
      persistedState = merged
      state = cloneAsMutable(merged)
      return merged
    },
  })

  const getState = (): MutableState => state
  const liveSnapshot = (): PermissionState => snapshot(state)
  const onMutate = (): void => file.flushDebounced(liveSnapshot)

  // Three thin domain modules over the shared state + persistence seam.
  const threads = createThreadStore(getState, onMutate)
  const hosts = createHostStore(getState, onMutate)
  const denials = createDenialLedger(getState, onMutate)

  const load = async (): Promise<void> => {
    await file.load((s) => {
      persistedState = s
      state = cloneAsMutable(s)
    })
  }

  const reset = async (): Promise<void> => {
    await file.reset()
    persistedState = null
    state = cloneAsMutable(emptyState())
  }

  return {
    load,
    flush: () => file.flush(liveSnapshot),
    flushDebounced: () => file.flushDebounced(liveSnapshot),
    snapshot: liveSnapshot,
    getThread: threads.get,
    getHost: hosts.get,
    getDenial: denials.get,
    listThreads: threads.list,
    listHosts: hosts.list,
    listThreadDenials: denials.listForThread,
    setThread: threads.set,
    clearThread: threads.clear,
    setHost: hosts.set,
    clearHost: hosts.clear,
    recordDenial: denials.recordDenial,
    recordRiskSeen: denials.recordRiskSeen,
    recordUserOverride: denials.recordUserOverride,
    clearDenial: denials.clear,
    hasPostDenialOverride: denials.hasOverride,
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
  const prior = defaultStore
  defaultStore = null
  void prior?.reset().catch(() => undefined)
}
