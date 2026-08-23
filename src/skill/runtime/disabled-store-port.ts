/**
 * RFC-06 F1 — the durable user-disabled-set PORT (versioned, fail-closed).
 *
 * The disabled set persists `{ schemaVersion, revision, names }` (RFC-06
 * "Persistence, policy and protocol"). This module owns only the CONTRACT and
 * the fail-closed decode of a raw persisted payload; the concrete fs adapter is
 * `./adapters/json-disabled-store` (the `@/skill` slice may not import
 * `@/storage`, so the adapter reaches node:fs through an injected callback,
 * mirroring `admin-policy-loader-fs`).
 *
 * Fail-closed decode mirrors RFC-05 E2 (`parsePosturePersistedRecord`): a
 * payload that is ABSENT, non-object, wrong `schemaVersion`, or malformed is
 * REJECTED — never trusted — and decodes to the EMPTY set at revision 0. Empty
 * is the conservative "current behavior" for a USER-disabled set: nothing the
 * user hid is trusted from corrupt bytes, while admin bans still apply via the
 * separate admin policy. A published-but-unpersisted disable is forbidden, so
 * {@link DisabledStorePort.write} THROWS on a non-durable write and the authority
 * refuses to publish (persist-before-publish).
 *
 * Slice rules: `@/skill` siblings + `@/shared` only. exactOptionalPropertyTypes.
 */

import { isRecord } from "@/shared"

/** Current on-disk disabled-set schema version. A payload whose `schemaVersion`
 *  is not this value is REJECTED (fail-closed), never trusted. Bump + add a
 *  migration arm when the shape changes. */
export const DISABLED_SET_SCHEMA_VERSION = 1 as const

/** The durable disabled-set record. `names` are canonical skill names the USER
 *  disabled; `revision` is the monotonic durable counter (the authority seeds
 *  its unified revision from it). */
export interface PersistedDisabledSet {
  readonly schemaVersion: number
  readonly revision: number
  readonly names: readonly string[]
}

/** The empty set at revision 0 — the fail-closed / absent default. */
export const emptyDisabledSet = (): PersistedDisabledSet => ({
  schemaVersion: DISABLED_SET_SCHEMA_VERSION,
  revision: 0,
  names: [],
})

/**
 * Fail-closed decode of a raw parsed JSON value into a {@link PersistedDisabledSet}.
 * Any of: undefined, non-object, wrong/missing `schemaVersion`, non-finite /
 * negative `revision`, or a `names` that is not a string[] ⇒ the EMPTY set
 * (corrupt bytes are dropped, never trusted). Duplicate names are de-duped and
 * the result is sorted for a deterministic on-disk shape.
 */
export const decodeDisabledSet = (raw: unknown): PersistedDisabledSet => {
  if (!isRecord(raw)) return emptyDisabledSet()
  if (raw.schemaVersion !== DISABLED_SET_SCHEMA_VERSION) return emptyDisabledSet()
  if (typeof raw.revision !== "number" || !Number.isFinite(raw.revision) || raw.revision < 0) {
    return emptyDisabledSet()
  }
  if (!Array.isArray(raw.names) || !raw.names.every((n) => typeof n === "string" && n.length > 0)) {
    return emptyDisabledSet()
  }
  const names = [...new Set(raw.names as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: raw.revision, names }
}

/** A pure name-set transform for a {@link DisabledStorePort.mutate}: given the
 *  disabled names read FRESH under the cross-process lock, return the next set
 *  (add to disable, remove to enable). Called INSIDE the critical section so it
 *  always composes onto the current on-disk truth — never a stale in-process
 *  snapshot. The passed set is a private copy; mutate-and-return or return a new
 *  one, either is fine. */
export type DisabledSetTransform = (currentNames: Set<string>) => Set<string>

/** The committed result of a {@link DisabledStorePort.mutate}. `record` is the
 *  durably-written set (its `revision` is the fresh on-disk revision + 1, which
 *  may jump past the caller's `basedOnRevision` when a concurrent writer landed
 *  while we waited for the lock). `resynced` is that optimistic-check signal:
 *  `true` iff the on-disk revision differed from `basedOnRevision` — i.e. the
 *  transform was re-applied onto another process's newer state. */
export interface DisabledSetMutateOutcome {
  readonly record: PersistedDisabledSet
  readonly resynced: boolean
}

/**
 * Durable versioned disabled-set store. `read()` fail-closes a corrupt payload to
 * the empty set; `write()` THROWS on a non-durable write so the authority's
 * persist-before-publish barrier can refuse to publish.
 *
 * `mutate()` is the CONCURRENCY-SAFE mutation path (RFC-06 R1): it runs the
 * read→transform→write as a single critical section under a cross-process
 * exclusive lock, so two processes sharing the file can never lost-update each
 * other. It bumps the revision from the FRESH on-disk value (re-sync + re-apply),
 * preserves the persist-observing throw (a non-durable write propagates so the
 * authority refuses to publish), and ALWAYS releases the lock — including on a
 * persist failure. `write()` remains the raw/seed primitive (absolute record, no
 * lock); production mutations go through `mutate()`.
 */
export interface DisabledStorePort {
  read(): Promise<PersistedDisabledSet>
  write(next: PersistedDisabledSet): Promise<void>
  mutate(
    basedOnRevision: number,
    transform: DisabledSetTransform,
  ): Promise<DisabledSetMutateOutcome>
}
