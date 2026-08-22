/**
 * RFC-05 E1 — posture PORT contracts (interfaces only, no implementation).
 *
 * Forward contracts that E2 (durable authority/store) implements over the
 * existing `permission-store.ts` and a separate future-thread-default entry.
 * E1 declares them so the authority packet has a stable surface; E1 itself
 * binds none of them. Pure type declarations — no IO, no host references.
 *
 * Slice rules: imports only sibling `@/permission` types.
 */

import type { ControlPolicy } from "../permission-profile"
import type { PosturePatch, PostureRecord } from "./types"

/** The versioned posture section E2 adds to the existing per-thread
 *  permission-store record (RFC-05 "Persistence, resume and future-thread
 *  defaults"). Stores the operator's LOSSLESS requested patch, the bound
 *  question value, the domain revision, and a schema version for migration.
 *  It deliberately does NOT store a resolved record — the effective view is
 *  recomputed on load so a later managed-policy change is honored. */
export interface PosturePersistedRecord {
  readonly requestedPatch: PosturePatch
  readonly boundAskOutsidePlan: boolean
  readonly revision: number
  readonly schemaVersion: number
}

/** Durable per-thread posture store. Keyed by thread id; read during host
 *  construction (E2/E3), never replayed from the kernel event log. */
export interface PosturePersistencePort {
  readRequested(threadId: string): PosturePersistedRecord | undefined
  writeRequested(threadId: string, record: PosturePersistedRecord): Promise<void>
}

/** Managed-policy source — the PRODUCER input for the `managed_policy` lock.
 *  Returns the existing {@link ControlPolicy} (or `undefined` when unmanaged).
 *  A lock is emitted only when this returns a genuinely managed policy; there
 *  is no synthetic/config/cloud lock producer (those are PARKED per RFC-05). */
export interface ManagedPolicyPort {
  read(): ControlPolicy | undefined
}

/** Future-thread default store. SEPARATE from the per-thread bound record: new
 *  thread creation COPIES this default into an immutable per-thread binding, so
 *  a later default change does not retroactively alter existing/resumed
 *  threads. E2 owns the implementation. */
export interface PermissionDefaultsPort {
  readDefault(): PostureRecord
  writeDefault(record: PostureRecord): Promise<void>
}
