/**
 * RFC-05 E2 — the durable posture AUTHORITY: validate/resolve a candidate,
 * CAS-persist it, and only THEN atomically publish an immutable live view.
 *
 * This is the packet's behavior owner (still un-wired to any host/surface — E3
 * does the live cutover). It closes the four E2 REDs:
 *
 *   1. CAS on E1's domain revision. Writes SERIALIZE through an internal chain
 *      so the revision check-and-bump is atomic w.r.t. the async persist: of two
 *      writers targeting revision N, exactly ONE commits (N→N+1); the other is
 *      stale-rejected. No producer-free lock is minted — the concurrency guard
 *      is a write chain, and the only POSTURE locks in the view come from E1's
 *      admitted `resolveLocks` producers.
 *   2. PERSIST BEFORE PUBLISH. The candidate is persisted (awaited) FIRST; only
 *      on a durable write does the in-memory view swap. A persist failure leaves
 *      the OLD revision/view live — never a published-but-unpersisted posture
 *      (§8 stop rule).
 *   3. Corrupt/unknown persisted schema is REJECTED at construction (fail-closed
 *      to current behavior), never trusted.
 *   4. A changed future-thread default has a THREAD-COPY boundary: creation
 *      COPIES the default into an immutable per-thread binding, so a later
 *      default change does not retroactively mutate existing/resumed threads.
 *
 * Slice rules: `@/permission` (siblings) + `@/shared` only. No `@/tool`, no host
 * references. exactOptionalPropertyTypes: optional fields are OMITTED / typed
 * `x?: T | undefined`.
 */

import type { PermissionStore } from "../permission-store"
import { currentBehaviorDefaultRecord, POSTURE_SCHEMA_VERSION } from "../posture-persistence"
import { buildResolvedPosture } from "./availability"
import type {
  ManagedPolicyPort,
  PermissionDefaultsPort,
  PosturePersistedRecord,
  PosturePersistencePort,
} from "./ports"
import { applyPatch, migrateLegacy, toCustomPatch } from "./presets"
import {
  INITIAL_REVISION,
  nextRevision,
  type PosturePatch,
  type PostureRecord,
  type ResolvedPermissionPosture,
  type ReviewerAvailability,
} from "./types"

/* ------------------------------------------------------------------------- *
 * Public result / rejection surface.
 * ------------------------------------------------------------------------- */

/** Why a posture mutation was refused. Every arm is a TYPED denial with no live
 *  mutation and no publish (RFC-05 security-model #4). */
export type PostureRejection =
  | { readonly kind: "stale_revision"; readonly expected: number; readonly actual: number }
  | { readonly kind: "persist_failed"; readonly detail: string }

export type PostureMutationResult =
  | { readonly ok: true; readonly posture: ResolvedPermissionPosture }
  | { readonly ok: false; readonly rejection: PostureRejection }

/** The live posture authority for one thread. `read()` returns the current
 *  immutable view; `set()` is the ONLY writer. */
export interface PostureAuthority {
  readonly threadId: string
  read(): ResolvedPermissionPosture
  set(patch: PosturePatch, expectedRevision: number): Promise<PostureMutationResult>
}

export interface PostureAuthorityDeps {
  readonly threadId: string
  readonly persistence: PosturePersistencePort
  readonly reviewerAvailability: ReviewerAvailability
  /** Managed-policy producer for the view's admitted locks. Absent ⇒ no locks. */
  readonly managedPolicy?: ManagedPolicyPort | undefined
}

/** Raised when a durable write does not reach disk. The authority converts it
 *  to a `persist_failed` rejection (never a published view). */
export class PosturePersistError extends Error {
  constructor(reason: string) {
    super(`PosturePersistError: ${reason}`)
    this.name = "PosturePersistError"
  }
}

/* ------------------------------------------------------------------------- *
 * Decode a persisted record to a live record+revision (fail-closed).
 * ------------------------------------------------------------------------- */

/** Reconstruct the live record + revision from a persisted record. A record
 *  that is ABSENT, or whose `schemaVersion` is unknown/corrupt, fails CLOSED to
 *  the current-behavior default — the corrupt bytes are REJECTED, never trusted
 *  (RFC-05 E2 requirement #3). A valid record's lossless full patch reconstructs
 *  the effective record exactly; `boundAskOutsidePlan` is authoritative for the
 *  orthogonal question knob. */
const decodePersisted = (
  rec: PosturePersistedRecord | undefined,
): { record: PostureRecord; revision: number } => {
  const base = currentBehaviorDefaultRecord()
  if (rec === undefined || rec.schemaVersion !== POSTURE_SCHEMA_VERSION) {
    const migrated = migrateLegacy({ threadPermission: base.threadPermission })
    return { record: migrated.record, revision: migrated.revision }
  }
  const applied = applyPatch(base, rec.requestedPatch)
  return {
    record: { threadPermission: applied.threadPermission, askOutsidePlan: rec.boundAskOutsidePlan },
    revision: rec.revision,
  }
}

/** Encode a live record + revision to its durable form: a LOSSLESS full patch
 *  (so reload reconstructs it without a second stored copy of the base), the
 *  bound question value, the revision, and the schema version. */
const encodeRecord = (record: PostureRecord, revision: number): PosturePersistedRecord => ({
  requestedPatch: toCustomPatch(record),
  boundAskOutsidePlan: record.askOutsidePlan,
  revision,
  schemaVersion: POSTURE_SCHEMA_VERSION,
})

/* ------------------------------------------------------------------------- *
 * The authority.
 * ------------------------------------------------------------------------- */

/** Recursively freeze a value so a consumer cannot mutate the published view in
 *  place — not the top-level object, its lock array, NOR a nested field such as
 *  `effective.threadPermission.approvalPolicy` (which `applyPatch` builds as a
 *  fresh, unfrozen literal). */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

export const createPostureAuthority = (deps: PostureAuthorityDeps): PostureAuthority => {
  const managed = deps.managedPolicy

  /** Build the immutable, published resolved view. Locks are recomputed from
   *  the CURRENT managed policy each time (so a later managed-policy change is
   *  honored on the next resolve) and come only from E1's admitted producers.
   *  The whole value is DEEP-frozen so the live view is truly immutable. */
  const buildView = (record: PostureRecord, revision: number): ResolvedPermissionPosture =>
    deepFreeze(
      buildResolvedPosture({
        record,
        revision,
        requestedPatch: toCustomPatch(record),
        availability: deps.reviewerAvailability,
        ...(managed !== undefined ? { managedPolicy: managed.read() } : {}),
      }),
    )

  // Live state — a single {record, revision} cell + the currently published
  // immutable view. Only the serialized writer mutates these.
  const decoded = decodePersisted(deps.persistence.readRequested(deps.threadId))
  let current: { record: PostureRecord; revision: number } = decoded
  let view: ResolvedPermissionPosture = buildView(decoded.record, decoded.revision)

  // Write serialization: chains async writes so the CAS check + persist + swap
  // run to completion before the next write's revision check reads `current`.
  // This is what makes "of two writers at revision N, exactly one commits" true.
  let writeChain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn)
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const set = (patch: PosturePatch, expectedRevision: number): Promise<PostureMutationResult> =>
    serialize(async (): Promise<PostureMutationResult> => {
      // CAS on E1's domain revision. Stale ⇒ typed reject, NO persist, NO swap.
      if (expectedRevision !== current.revision) {
        return {
          ok: false,
          rejection: {
            kind: "stale_revision",
            expected: expectedRevision,
            actual: current.revision,
          },
        }
      }
      const candidate = applyPatch(current.record, patch)
      const newRevision = nextRevision(current.revision)

      // PERSIST FIRST. A failure here MUST leave the old view live — we do NOT
      // touch `current`/`view` until the write is durable.
      try {
        await deps.persistence.writeRequested(deps.threadId, encodeRecord(candidate, newRevision))
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { ok: false, rejection: { kind: "persist_failed", detail } }
      }

      // Durable ⇒ NOW publish the new immutable view atomically.
      current = { record: candidate, revision: newRevision }
      view = buildView(candidate, newRevision)
      return { ok: true, posture: view }
    })

  return {
    threadId: deps.threadId,
    read: () => view,
    set,
  }
}

/* ------------------------------------------------------------------------- *
 * Future-thread default → immutable per-thread binding (thread-copy boundary).
 * ------------------------------------------------------------------------- */

export interface ThreadPostureBindingDeps {
  readonly threadId: string
  readonly persistence: PosturePersistencePort
  readonly defaults: PermissionDefaultsPort
  readonly reviewerAvailability: ReviewerAvailability
  readonly managedPolicy?: ManagedPolicyPort | undefined
}

/**
 * Bind a thread's posture authority, enforcing the future-thread-default
 * THREAD-COPY boundary:
 *
 *   - a NEW thread (no persisted binding yet) COPIES the CURRENT default into an
 *     immutable per-thread binding and persists it, so a later default change
 *     never reaches back into this thread;
 *   - an EXISTING/RESUMED thread reads its own bound record and ignores the
 *     current default entirely.
 *
 * Two threads created across a default change therefore retain distinct values.
 */
export const createThreadPostureBinding = async (
  deps: ThreadPostureBindingDeps,
): Promise<PostureAuthority> => {
  const existing = deps.persistence.readRequested(deps.threadId)
  if (existing === undefined) {
    const def = deps.defaults.readDefault()
    // COPY the default NOW (not a lazy read at construction) so the binding is
    // immutable against later default changes.
    await deps.persistence.writeRequested(deps.threadId, encodeRecord(def, INITIAL_REVISION))
  }
  return createPostureAuthority({
    threadId: deps.threadId,
    persistence: deps.persistence,
    reviewerAvailability: deps.reviewerAvailability,
    ...(deps.managedPolicy !== undefined ? { managedPolicy: deps.managedPolicy } : {}),
  })
}

/* ------------------------------------------------------------------------- *
 * Store-backed port adapters (the durable persistence + default entries).
 * ------------------------------------------------------------------------- */

/** Persistence port over the permission-store's versioned posture section. The
 *  write is PERSIST-OBSERVING: it forces a durable flush and THROWS when the
 *  bytes did not reach disk, so the authority's persist-before-publish barrier
 *  can refuse to publish. */
export const createStorePosturePersistence = (store: PermissionStore): PosturePersistencePort => ({
  readRequested: (threadId) => store.getPosture(threadId),
  writeRequested: async (threadId, record) => {
    store.setPosture(threadId, record)
    const outcome = await store.flushDurable()
    if (!outcome.durable) throw new PosturePersistError(outcome.reason)
  },
})

/** Future-thread default port over the store's SEPARATE default entry. An unset
 *  default reads as the current-behavior record. */
export const createStorePermissionDefaults = (store: PermissionStore): PermissionDefaultsPort => ({
  readDefault: () => store.getPostureDefault() ?? currentBehaviorDefaultRecord(),
  writeDefault: async (record) => {
    store.setPostureDefault(record)
    const outcome = await store.flushDurable()
    if (!outcome.durable) throw new PosturePersistError(outcome.reason)
  },
})
