/**
 * RFC-05 E2 — durable posture PERSISTENCE domain (versioned section + validators).
 *
 * This is the versioned extension the permission-store composes in (mirrors the
 * `createThreadStore`/`createDenialLedger` domain-module pattern). It owns:
 *   - the posture SCHEMA VERSION and the on-disk section shape;
 *   - the fail-closed validators that REJECT a corrupt/unknown-version record
 *     (RFC-05 E2 requirement #3: "corrupt/unknown schema is REJECTED");
 *   - the per-thread bound record store AND the SEPARATE future-thread default
 *     entry (RFC-05: "Future-thread defaults are a separate named store entry,
 *     not a mutable process global"); and
 *   - the current-behavior default record a missing field migrates to.
 *
 * It lives in its own file (not inlined into `permission-store.ts`) so the store
 * stays under the god-module ceiling AND so the E2 write-set is a clean, small
 * diff. Value dependencies point ONE way — `permission-store.ts` imports THIS
 * module; this module imports only TYPES from the store/posture model (erased at
 * runtime, so no value cycle / TDZ hazard).
 *
 * Slice rules: `@/permission` + `@/shared` (leaf) only. No IO, no env — the file
 * engine (atomic write / debounce / quarantine) is the store's, not ours.
 *
 * exactOptionalPropertyTypes: optional fields are OMITTED when absent.
 */

import { isRecord } from "@/shared"
import { APPROVAL_LADDER } from "./approval-ladder"
import type { ThreadPermission } from "./permission-store"
import type { PosturePersistedRecord } from "./posture/ports"
import {
  CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
  CURRENT_BEHAVIOR_MODE,
  type PosturePatch,
  type PostureRecord,
} from "./posture/types"
import { isPermissionMode } from "./types"

/** Current on-disk posture-section schema version. This is INDEPENDENT of the
 *  store's top-level `STATE_VERSION`: the posture section is an ADDITIVE arm, so
 *  a legacy file that predates E2 (no posture section) still loads and migrates
 *  to current behavior. A record whose `schemaVersion` is not this value is
 *  REJECTED (fail-closed), never trusted. Bump + add a migration arm when the
 *  record shape changes. */
export const POSTURE_SCHEMA_VERSION = 1 as const

/* ------------------------------------------------------------------------- *
 * On-disk section shape.
 * ------------------------------------------------------------------------- */

/** Live-mutable posture section held inside the store's `MutableState`. The
 *  per-thread map is the operator's durable bound record (delta patch + bound
 *  question value + revision); `default` is the SEPARATE future-thread default
 *  (null when the operator never set one ⇒ current behavior). */
export interface MutablePostureSection {
  perThread: Record<string, PosturePersistedRecord>
  default: PostureRecord | null
}

/** Frozen snapshot of {@link MutablePostureSection} for the store's public
 *  read model. */
export interface PosturePersistedSection {
  readonly perThread: Readonly<Record<string, PosturePersistedRecord>>
  readonly default: PostureRecord | null
}

export const emptyPostureSection = (): MutablePostureSection => ({ perThread: {}, default: null })

export const clonePostureSection = (s: PosturePersistedSection): MutablePostureSection => ({
  perThread: { ...s.perThread },
  default: s.default,
})

export const freezePostureSection = (s: MutablePostureSection): PosturePersistedSection =>
  Object.freeze({
    perThread: Object.freeze({ ...s.perThread }),
    default: s.default,
  })

/* ------------------------------------------------------------------------- *
 * Fail-closed shape guards (small, local — no value import from the store, to
 * avoid a runtime cycle; the store's own `validateThreadPermission` stays
 * private there).
 * ------------------------------------------------------------------------- */

const isApprovalPolicy = (v: unknown): v is ThreadPermission["approvalPolicy"] =>
  v === "never" || v === "on-request" || v === "on-failure" || v === "always"

const isApprovalsReviewer = (v: unknown): v is ThreadPermission["approvalsReviewer"] =>
  v === "user" || v === "agent"

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === "string")

/** Validate a sandbox policy value, returning the canonical value or `null`
 *  (fail-closed) for any malformed shape. */
const parseSandboxPolicy = (v: unknown): ThreadPermission["sandboxPolicy"] | null => {
  if (!isRecord(v)) return null
  switch (v.type) {
    case "danger-full-access":
      return { type: "danger-full-access" }
    case "read-only":
      return { type: "read-only" }
    case "workspace-write": {
      if (v.writableRoots !== undefined && !isStringArray(v.writableRoots)) return null
      if (v.networkAccess !== undefined && typeof v.networkAccess !== "boolean") return null
      return {
        type: "workspace-write",
        ...(v.writableRoots !== undefined ? { writableRoots: [...v.writableRoots] } : {}),
        ...(v.networkAccess !== undefined ? { networkAccess: v.networkAccess } : {}),
      }
    }
    default:
      return null
  }
}

/** Validate a lossless posture PATCH (every field optional). Returns the
 *  canonical patch, or `null` when any PRESENT field is malformed (fail-closed:
 *  a bad patch is never partially trusted). */
const parsePosturePatch = (v: unknown): PosturePatch | null => {
  if (!isRecord(v)) return null
  const out: {
    approvalPolicy?: ThreadPermission["approvalPolicy"]
    approvalsReviewer?: ThreadPermission["approvalsReviewer"]
    sandboxPolicy?: ThreadPermission["sandboxPolicy"]
    askOutsidePlan?: boolean
    mode?: PosturePatch["mode"]
  } = {}
  if (v.approvalPolicy !== undefined) {
    if (!isApprovalPolicy(v.approvalPolicy)) return null
    out.approvalPolicy = v.approvalPolicy
  }
  if (v.approvalsReviewer !== undefined) {
    if (!isApprovalsReviewer(v.approvalsReviewer)) return null
    out.approvalsReviewer = v.approvalsReviewer
  }
  if (v.sandboxPolicy !== undefined) {
    const sandbox = parseSandboxPolicy(v.sandboxPolicy)
    if (sandbox === null) return null
    out.sandboxPolicy = sandbox
  }
  if (v.askOutsidePlan !== undefined) {
    if (typeof v.askOutsidePlan !== "boolean") return null
    out.askOutsidePlan = v.askOutsidePlan
  }
  // The permission-mode axis (RFC-05 E2b). Absent ⇒ omitted (applyPatch fills it
  // from the base's current-behavior mode); PRESENT-but-invalid ⇒ fail-closed.
  if (v.mode !== undefined) {
    if (!isPermissionMode(v.mode)) return null
    out.mode = v.mode
  }
  return out
}

/** Validate a complete posture RECORD (the future-thread default shape). Returns
 *  the canonical record or `null` (fail-closed) for any malformed field. */
const parsePostureRecord = (v: unknown): PostureRecord | null => {
  if (!isRecord(v)) return null
  const tp = v.threadPermission
  if (!isRecord(tp)) return null
  if (!isApprovalPolicy(tp.approvalPolicy)) return null
  if (!isApprovalsReviewer(tp.approvalsReviewer)) return null
  const sandbox = parseSandboxPolicy(tp.sandboxPolicy)
  if (sandbox === null) return null
  if (typeof v.askOutsidePlan !== "boolean") return null
  // The permission-mode axis (RFC-05 E2b). Legacy-absent ⇒ current-behavior mode
  // (additive migration — a default written before the mode axis still loads);
  // PRESENT-but-invalid ⇒ fail-closed (the whole default is rejected).
  if (v.mode !== undefined && !isPermissionMode(v.mode)) return null
  const mode = v.mode === undefined ? CURRENT_BEHAVIOR_MODE : v.mode
  return {
    threadPermission: {
      approvalPolicy: tp.approvalPolicy,
      approvalsReviewer: tp.approvalsReviewer,
      sandboxPolicy: sandbox,
    },
    askOutsidePlan: v.askOutsidePlan,
    mode,
  }
}

/** Validate one persisted per-thread posture record. A record whose
 *  `schemaVersion` is unknown, or whose fields are malformed, is REJECTED
 *  (returns `null`) — the caller drops it, so the thread falls back to current
 *  behavior rather than trusting corrupt/forward-version bytes. This is the
 *  fail-closed guard RFC-05 E2 requirement #3 pins. */
export const parsePosturePersistedRecord = (v: unknown): PosturePersistedRecord | null => {
  if (!isRecord(v)) return null
  if (v.schemaVersion !== POSTURE_SCHEMA_VERSION) return null
  const patch = parsePosturePatch(v.requestedPatch)
  if (patch === null) return null
  if (typeof v.boundAskOutsidePlan !== "boolean") return null
  if (typeof v.revision !== "number" || !Number.isFinite(v.revision) || v.revision < 0) return null
  return {
    requestedPatch: patch,
    boundAskOutsidePlan: v.boundAskOutsidePlan,
    revision: v.revision,
    schemaVersion: POSTURE_SCHEMA_VERSION,
  }
}

/** Parse the raw posture section from a loaded JSON payload. Bad/unknown-version
 *  per-thread records and a malformed default are DROPPED (fail-closed) rather
 *  than crashing the whole-file parse — a corrupt posture record must never
 *  become a live posture, and dropping it preserves the sibling thread grants
 *  the store already validated. Absent section ⇒ empty (legacy migration). */
export const parsePostureSection = (
  rawPerThread: unknown,
  rawDefault: unknown,
): MutablePostureSection => {
  const perThread: Record<string, PosturePersistedRecord> = {}
  if (isRecord(rawPerThread)) {
    for (const [key, entry] of Object.entries(rawPerThread)) {
      const record = parsePosturePersistedRecord(entry)
      if (record !== null) perThread[key] = record
    }
  }
  const def = rawDefault === undefined ? null : parsePostureRecord(rawDefault)
  return { perThread, default: def }
}

/* ------------------------------------------------------------------------- *
 * Current-behavior default.
 * ------------------------------------------------------------------------- */

/** The posture record a MISSING field migrates to — the fail-closed
 *  current-behavior base. The `ThreadPermission` is the most-restrictive named
 *  rung (`read-only`: user reviewer, on-request, read-only sandbox); the
 *  question knob is {@link CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN} (today's
 *  unrestricted behavior). E3 owns resolving the live managed base; for E2 this
 *  is the durable-store seed and the gap-filler for a partial legacy patch. */
export const currentBehaviorDefaultRecord = (): PostureRecord => ({
  threadPermission: APPROVAL_LADDER["read-only"],
  askOutsidePlan: CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
  mode: CURRENT_BEHAVIOR_MODE,
})

/* ------------------------------------------------------------------------- *
 * Domain module (operates on the store's live section by reference).
 * ------------------------------------------------------------------------- */

/** Structural equality of two persisted records (skip a redundant flush). */
const recordEqual = (a: PosturePersistedRecord, b: PosturePersistedRecord): boolean =>
  a.revision === b.revision &&
  a.schemaVersion === b.schemaVersion &&
  a.boundAskOutsidePlan === b.boundAskOutsidePlan &&
  JSON.stringify(a.requestedPatch) === JSON.stringify(b.requestedPatch)

export interface PostureDomain {
  getPosture(threadId: string): PosturePersistedRecord | undefined
  setPosture(threadId: string, record: PosturePersistedRecord): void
  clearPosture(threadId: string): void
  getDefault(): PostureRecord | undefined
  setDefault(record: PostureRecord): void
}

/** Thin domain module over the shared, live posture section — mirrors
 *  `createThreadStore`. Every mutation calls `onMutate` (debounced flush). */
export const createPostureDomain = (
  section: () => MutablePostureSection,
  onMutate: () => void,
): PostureDomain => ({
  getPosture: (threadId) => section().perThread[threadId],
  setPosture: (threadId, record) => {
    const existing = section().perThread[threadId]
    if (existing !== undefined && recordEqual(existing, record)) return // idempotent
    section().perThread[threadId] = record
    onMutate()
  },
  clearPosture: (threadId) => {
    if (section().perThread[threadId] === undefined) return // idempotent
    delete section().perThread[threadId]
    onMutate()
  },
  getDefault: () => section().default ?? undefined,
  setDefault: (record) => {
    section().default = record
    onMutate()
  },
})
