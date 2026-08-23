/**
 * RFC-05 E3 — the SINGLE production posture-authority builder + the behavior-live
 * permission-mode ADAPTER (`@/runner/assemble/session-authorities`).
 *
 * This is E3's half of the shared session-authorities owner lock (board §5:
 * A2 -> D4 -> C2 -> E2/E3 -> F1). It mirrors RFC-03 C2's `build-objective.ts`:
 * one place production code constructs the per-session posture authority, over
 * E2's durable authority (`@/permission`), so no surface mints its own
 * permission-mode state cell.
 *
 * It closes the E3 "behavior-live cutover":
 *   1. `buildPostureAuthority` / `buildThreadPostureBinding` — construct the E2
 *      authority DURING RESTORE (a fresh runtime reads the durable persistence
 *      and reconstructs the last effective mode without event replay), COPYING
 *      the future-thread default at thread creation (thread-copy boundary).
 *   2. `deriveManagedMode` — resolve the effective mode against the CURRENT
 *      managed `ControlPolicy` (restrict-only/forced, deterministic): an
 *      enterprise-managed policy forces the restrictive floor; an unmanaged/user
 *      policy leaves the operator's requested mode standing. Aligned with the
 *      existing `managed_policy` lock producer (same `managedBy` admission).
 *   3. `createPermissionModeAdapter` — the delegating adapter every direct mode
 *      writer routes through: `get()` reads the authority's LIVE effectiveMode;
 *      `set()` delegates to `authority.set({ mode }, revision)` so a mode change
 *      is a durable POSTURE mutation (advances the revision), never an
 *      out-of-band cell poke. It retires the standalone mode cell.
 *
 * `runner/assemble` is the Layer-2 composition seam, so it MAY import the
 * `@/permission` domain (construction). exactOptionalPropertyTypes: optional
 * fields are OMITTED when absent.
 */

import type { ControlPolicy } from "@/permission/permission-profile"
import type { PermissionStore } from "@/permission/permission-store"
import {
  createPostureAuthority,
  createStorePosturePersistence,
  createThreadPostureBinding,
  type PostureAuthority,
} from "@/permission/posture/authority"
import type {
  ManagedPolicyPort,
  PermissionDefaultsPort,
  PosturePersistedRecord,
  PosturePersistencePort,
} from "@/permission/posture/ports"
import {
  CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
  INITIAL_REVISION,
  type ReviewerAvailability,
} from "@/permission/posture/types"
import { POSTURE_SCHEMA_VERSION } from "@/permission/posture-persistence"
import type { PermissionMode } from "@/permission/types"

/* ------------------------------------------------------------------------- *
 * Managed-mode derivation (restrict-only, deterministic).
 * ------------------------------------------------------------------------- */

/**
 * Resolve the mode the live managed policy FORCES on the effective view, from
 * the current {@link ControlPolicy}. RESTRICT-ONLY: an enterprise-managed policy
 * (`managedBy` of `admin`/`team`) forces the restrictive floor mode `default`
 * (the mode that always asks — a managed org cannot leave a session running in
 * an elevated `acceptEdits`/`bypass`/`auto` mode); an unmanaged/`user`/absent
 * policy yields `undefined` so the operator's requested mode stands.
 *
 * Deterministic and producer-aligned: the admission condition is EXACTLY the
 * `managed_policy` lock producer's (`managedPolicyLock`), so the forced mode and
 * the surfaced lock come from the same managed-policy source. This is the E2b
 * `managedMode` clamp input — no new mode value, no PID/cwd/prose inference.
 */
export const deriveManagedMode = (
  control: ControlPolicy | undefined,
): PermissionMode | undefined =>
  control?.managedBy === "admin" || control?.managedBy === "team" ? "default" : undefined

/* ------------------------------------------------------------------------- *
 * Posture-authority construction (the single production owner).
 * ------------------------------------------------------------------------- */

export interface BuildPostureAuthorityInput {
  /** The per-thread persistence key the authority restores/persists under. */
  readonly threadId: string
  /** Durable persistence read at construction — a fresh runtime reconstructs the
   *  restored effective view from it (no event replay). */
  readonly persistence: PosturePersistencePort
  /** Reviewer-availability flags for the effective reviewer route. Does not feed
   *  `effectiveMode` (the canonical split keeps the route a separate axis). */
  readonly reviewerAvailability: ReviewerAvailability
  /** The live managed-policy producer. Its `read()` drives BOTH the admitted
   *  `managed_policy` lock AND the forced-mode clamp (via {@link deriveManagedMode}). */
  readonly managedPolicy?: ManagedPolicyPort | undefined
}

/**
 * Construct THE per-session posture authority over E2's durable authority,
 * binding it DURING RESTORE: the persistence port is read at construction so a
 * fresh runtime's effective mode equals the restored posture's effectiveMode.
 * The managed clamp is derived from the live policy so a managed-policy change
 * on resume takes effect. This is the one production posture constructor owner
 * (mirrors `buildObjectiveAuthority`).
 */
export const buildPostureAuthority = (input: BuildPostureAuthorityInput): PostureAuthority => {
  const managedMode = deriveManagedMode(input.managedPolicy?.read())
  return createPostureAuthority({
    threadId: input.threadId,
    persistence: input.persistence,
    reviewerAvailability: input.reviewerAvailability,
    ...(input.managedPolicy !== undefined ? { managedPolicy: input.managedPolicy } : {}),
    ...(managedMode !== undefined ? { managedMode } : {}),
  })
}

export interface BuildThreadPostureBindingInput extends BuildPostureAuthorityInput {
  /** The future-thread default store. A NEW thread COPIES this default into an
   *  immutable per-thread binding; an EXISTING/resumed thread reads its own bound
   *  record. Two threads created across a default change retain distinct values. */
  readonly defaults: PermissionDefaultsPort
}

/**
 * Construct the authority for a thread whose default must be COPIED at creation
 * (the thread-copy boundary). A new thread persists a copy of the current
 * default now; a later default change never reaches back into it. Async because
 * the copy is a durable write (persist-before-bind).
 */
export const buildThreadPostureBinding = async (
  input: BuildThreadPostureBindingInput,
): Promise<PostureAuthority> => {
  const managedMode = deriveManagedMode(input.managedPolicy?.read())
  return createThreadPostureBinding({
    threadId: input.threadId,
    persistence: input.persistence,
    defaults: input.defaults,
    reviewerAvailability: input.reviewerAvailability,
    ...(input.managedPolicy !== undefined ? { managedPolicy: input.managedPolicy } : {}),
    ...(managedMode !== undefined ? { managedMode } : {}),
  })
}

/* ------------------------------------------------------------------------- *
 * In-memory / seeded persistence ports.
 * ------------------------------------------------------------------------- */

/** A process-local, non-durable posture persistence port (a `Map`). Used for
 *  the live session's authority when there is no durable posture store to key
 *  by yet: the mode axis is authoritative within the process, and byte-identical
 *  to legacy behavior across a restart (nothing persisted). Writes are async to
 *  honor the port's persist-before-publish contract. */
export const createInMemoryPosturePersistence = (): PosturePersistencePort => {
  const store = new Map<string, PosturePersistedRecord>()
  return {
    readRequested: (threadId) => store.get(threadId),
    writeRequested: async (threadId, record) => {
      store.set(threadId, record)
    },
  }
}

/**
 * An in-memory persistence port PRE-SEEDED so the authority's restored effective
 * mode equals `initialMode` (byte-identical to the legacy `runtime.mode` seed).
 * The seed is a lossless requested patch carrying the mode; a legacy-absent
 * `default` seed round-trips to the current-behavior default. Seeded
 * synchronously so `createPostureAuthority` reads it at construction.
 */
export const createSeededPosturePersistence = (
  threadId: string,
  initialMode: PermissionMode,
): PosturePersistencePort => {
  const store = new Map<string, PosturePersistedRecord>([
    [
      threadId,
      {
        requestedPatch: { mode: initialMode },
        boundAskOutsidePlan: CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
        revision: INITIAL_REVISION,
        schemaVersion: POSTURE_SCHEMA_VERSION,
      },
    ],
  ])
  return {
    readRequested: (id) => store.get(id),
    writeRequested: async (id, record) => {
      store.set(id, record)
    },
  }
}

/**
 * A durable, STORE-backed posture persistence port that SEEDS `initialMode` on an
 * ABSENT record. E2's {@link createStorePosturePersistence} returns `undefined`
 * for a thread with no persisted record, which the authority would decode to the
 * current-behavior default — LOSING the `initialMode` seed (a default-mode
 * REGRESSION on a clean machine). This wrapper injects the SAME lossless
 * `{ mode: initialMode }` seed {@link createSeededPosturePersistence} uses, so a
 * fresh machine is byte-identical to the legacy in-memory seed; only a PERSISTED
 * record overrides. A CORRUPT record never reaches the seed branch — the store
 * DROPS it at load (`getPosture` returns `undefined`), so the current-behavior
 * seed stands (fail-closed to current behavior). Writes/durability delegate to the
 * store adapter (persist-before-publish barrier preserved). The seed is scoped to
 * the authority's own `threadId` so it never fabricates a record for a sibling
 * (concurrent) session that legitimately has none.
 */
export const createStoreSeededPosturePersistence = (
  store: PermissionStore,
  threadId: string,
  initialMode: PermissionMode,
): PosturePersistencePort => {
  const backing = createStorePosturePersistence(store)
  return {
    readRequested: (id) =>
      backing.readRequested(id) ??
      (id === threadId
        ? {
            requestedPatch: { mode: initialMode },
            boundAskOutsidePlan: CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
            revision: INITIAL_REVISION,
            schemaVersion: POSTURE_SCHEMA_VERSION,
          }
        : undefined),
    writeRequested: backing.writeRequested,
  }
}

/* ------------------------------------------------------------------------- *
 * The behavior-live permission-mode ADAPTER.
 * ------------------------------------------------------------------------- */

/**
 * The delegating permission-mode adapter — the single live authority-backed
 * writer that RETIRES the standalone mode cell. Mirrors the `{ get, set }` shape
 * every surface (CLI `shift+tab`, host `permission.mode` accessor, web/agent
 * control-request appliers) already writes through, but holds NO mutable mode
 * state of its own:
 *
 *   - `get()` reads the authority's LIVE effectiveMode, so the per-turn gate
 *     reads the current value (a snapshot cell can go stale; this cannot);
 *   - `set()` delegates to `authority.set({ mode }, revision)`, so a mode write
 *     is a durable POSTURE mutation that ADVANCES the revision.
 *
 * Writes are SERIALIZED onto a chain so successive sets each read the freshly
 * bumped revision (none stale-reject) — a fire-and-forget surface write applies
 * on the next durable publish, before the next turn.
 *
 * M1 (RFC-05 E4) — CAS-loser resilience against the SECOND writer. Once the E4
 * {@link PostureControl} shares this ONE authority (a `/posture` mutation), a
 * mode-cycle (`shift+tab`) can race a `/posture` commit: the mode `set` reads
 * revision N, a posture write commits N→N+1 first, and the mode `set`'s CAS is
 * stale-rejected. A fire-and-forget adapter would DISCARD that `PostureMutationResult`
 * and SILENTLY LOSE the mode change. So `set()` RE-READS the freshly-published
 * revision and RE-APPLIES the `{ mode }` patch on top of the committed record on a
 * `stale_revision` reject — the mode write composes with the posture change (last
 * writer on the mode axis) instead of being lost or clobbering the non-mode
 * fields. Only `stale_revision` retries; a `persist_failed` is a real failure and
 * is NOT retried. Progress is guaranteed: the authority serializes writes, so each
 * retry follows a completed conflicting commit, and operator writes are finite.
 *
 * This is the moved home of the `PermissionModeSessionState` contract every
 * surface writes through (formerly the state-cell shape in `session-state.ts`,
 * re-exported from there for compatibility). It is now the delegating-adapter
 * contract — a `{ get, set }` view over the authority, holding no mutable state.
 * `defaultMode` is retained (optional, unused by the permission cell) so the
 * type stays a drop-in for existing consumers.
 */
export interface PermissionModeSessionState {
  readonly defaultMode?: PermissionMode
  get(): PermissionMode
  set(next: PermissionMode): void
}

export const createPermissionModeAdapter = (
  authority: PostureAuthority,
): PermissionModeSessionState => {
  let chain: Promise<unknown> = Promise.resolve()
  const runSet = async (next: PermissionMode): Promise<unknown> => {
    // Read the revision INSIDE the continuation so it reflects any prior set's
    // durable bump; `authority.set` never rejects (persist failure is a typed
    // result), so the chain never needs a rejection handler.
    //
    // M1 — retry ONLY on `stale_revision`: the SECOND writer (the E4 PostureControl
    // sharing this authority) committed between our read and the authority's CAS.
    // Re-read the freshly-published revision and re-apply `{ mode }` on top so the
    // mode write is never silently lost. `persist_failed` is a real failure ⇒ no
    // retry. Progress is bounded — the authority serializes writes, so each retry
    // trails a completed commit.
    for (;;) {
      const result = await authority.set({ mode: next }, authority.read().revision)
      if (result.ok || result.rejection.kind !== "stale_revision") return result
    }
  }
  return {
    get: () => authority.read().effective.effectiveMode,
    set: (next) => {
      chain = chain.then(() => runSet(next))
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Composition-root convenience: the live session's default posture mode.
 * ------------------------------------------------------------------------- */

/** The persistence key the live session's posture authority binds under. The
 *  live authority uses a PROCESS-LOCAL persistence port holding a single thread,
 *  so the key is a stable constant; the durable, session-keyed store is the
 *  resume rail's concern. */
export const LIVE_POSTURE_THREAD_ID = "session"

/**
 * Build the live session's delegating permission-mode state: the durable posture
 * authority (seeded from `initialMode` over a process-local persistence port so
 * the default path is byte-identical, unmanaged ⇒ effectiveMode == initialMode)
 * wrapped by the delegating adapter every surface writes through. This is the
 * single seam the host composition root uses to retire the standalone mode cell.
 */
export const buildLivePermissionModeState = (
  initialMode: PermissionMode,
): PermissionModeSessionState =>
  createPermissionModeAdapter(
    buildPostureAuthority({
      threadId: LIVE_POSTURE_THREAD_ID,
      persistence: createSeededPosturePersistence(LIVE_POSTURE_THREAD_ID, initialMode),
      reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
    }),
  )
