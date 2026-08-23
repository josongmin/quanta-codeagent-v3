/**
 * RFC-06 F1 — the live `SkillRuntimeAuthority`: one atomic owner of the
 * registry + admin policy + durable user-disabled set + a single UNIFIED
 * revision.
 *
 * This is the packet's behavior owner (F2/F3/F4 cut the invocation / prompt /
 * surface consumers over to it). It closes the three F1 REDs:
 *
 *   1. ONE revision → THREE consistent projections. `read()` returns an
 *      immutable {@link SkillRuntimeView} whose `active`/`searchable`/`management`
 *      are derived by {@link deriveSkillProjections} from the SAME
 *      registry/policy/disabled inputs, so a persisted disable can never leave
 *      them divergent (no per-consumer frozen-map filter).
 *   2. CAS on the unified revision. `setEnabled` SERIALIZES through an internal
 *      write chain so the revision check-and-bump is atomic w.r.t. the async
 *      persist: of two writers targeting revision N, exactly ONE commits
 *      (N→N+1); the other is stale-rejected. No both-publish.
 *   3. PERSIST BEFORE PUBLISH + fail-closed policy. The next disabled set is
 *      written to the durable store (awaited) FIRST; only on a durable write does
 *      the view swap. A persist failure, a stale revision, an unknown skill, or a
 *      name-keyed policy denial (admin-required cannot be disabled; admin-banned
 *      cannot be enabled) leaves the OLD revision/view live — a typed rejection,
 *      never a publish.
 *
 * Policy is enforced by CANONICAL NAME (never `winnerScope` — F1 stop rule).
 *
 * Slice rules: `@/skill` siblings + `@/shared` only. exactOptionalPropertyTypes.
 */

import { errMessage } from "@/shared"
import type { AdminPolicy } from "../admin-policy"
import { bannedSkillNames, requiredAdminSkillNames } from "../install-enforcement"
import type { SkillSnapshot } from "../registry"
import type { Skill } from "../types"
import type { DisabledStorePort, PersistedDisabledSet } from "./disabled-store-port"
import { deriveSkillProjections } from "./projections"
import type { SkillRuntimeView } from "./types"

/** Why a `setEnabled` mutation was refused. Every arm is a TYPED denial with NO
 *  durable write and NO publish. */
export type SkillSetEnabledRejection =
  | { readonly kind: "stale_revision"; readonly expected: number; readonly actual: number }
  | { readonly kind: "unknown_skill"; readonly name: string }
  | {
      readonly kind: "policy_denied"
      readonly name: string
      readonly reason: "required" | "banned"
    }
  | { readonly kind: "persist_failed"; readonly detail: string }

export type SkillSetEnabledResult =
  | { readonly ok: true; readonly view: SkillRuntimeView }
  | { readonly ok: false; readonly rejection: SkillSetEnabledRejection }

/** The live skill runtime authority. `read()` returns the current immutable
 *  view; `setEnabled` is the ONLY writer; `resolveActive` reads the active
 *  projection for an execution-time presence check (F2 makes invocation call it
 *  immediately before executing). */
export interface SkillRuntimeAuthority {
  read(): SkillRuntimeView
  setEnabled(
    name: string,
    enabled: boolean,
    expectedRevision: number,
  ): Promise<SkillSetEnabledResult>
  resolveActive(name: string): Skill | undefined
  /** Re-read the durable disabled set and republish the projections at a fresh
   *  revision (cross-process convergence at turn/read boundaries). Never mutates
   *  the durable store. */
  sync(): Promise<SkillRuntimeView>
}

export interface SkillRuntimeAuthorityDeps {
  /** The precedence-resolved registry snapshot (the discovery authority). */
  readonly snapshot: SkillSnapshot
  /** The loaded admin policy (null ⇒ no org policy on this host). */
  readonly policy: AdminPolicy | null
  /** The durable user-disabled set store (persist-before-publish). */
  readonly disabledStore: DisabledStorePort
  /** The disabled set read at construction (seeds the unified revision). */
  readonly persisted: PersistedDisabledSet
}

/** Pure name-keyed pre-check for a mutation (after the CAS passed): unknown skill
 *  fails closed; admin-required cannot be disabled; admin-banned cannot be
 *  enabled. Returns the typed rejection, or `null` when the mutation is admitted.
 *  Policy is keyed by NAME only (never `winnerScope` — F1 stop rule). */
const precheckMutation = (
  registry: SkillSnapshot["registry"],
  required: ReadonlySet<string>,
  banned: ReadonlySet<string>,
  name: string,
  enabled: boolean,
): SkillSetEnabledRejection | null => {
  if (registry.lookup(name) === undefined) return { kind: "unknown_skill", name }
  if (enabled === false && required.has(name)) {
    return { kind: "policy_denied", name, reason: "required" }
  }
  if (enabled === true && banned.has(name)) {
    return { kind: "policy_denied", name, reason: "banned" }
  }
  return null
}

/** The pure name-set transform for an admitted mutation: disabling adds the
 *  name, enabling removes it. Applied INSIDE the store's cross-process critical
 *  section (`mutate`), so it composes onto the FRESH on-disk names — never a
 *  stale in-process snapshot — which is what makes a cross-process re-apply
 *  (rather than a lost-update clobber) possible. */
const disabledSetTransform =
  (name: string, enabled: boolean) =>
  (names: Set<string>): Set<string> => {
    if (enabled === false) names.add(name)
    else names.delete(name)
    return names
  }

export const createSkillRuntimeAuthority = (
  deps: SkillRuntimeAuthorityDeps,
): SkillRuntimeAuthority => {
  const registry = deps.snapshot.registry
  const policy = deps.policy
  const required = new Set(requiredAdminSkillNames(policy))
  const banned = new Set(bannedSkillNames(policy))

  // Live state — one {disabledNames, revision} cell + the published view. Only
  // the serialized writer mutates these.
  let current: { disabledNames: Set<string>; revision: number } = {
    disabledNames: new Set(deps.persisted.names),
    revision: deps.persisted.revision,
  }
  let view: SkillRuntimeView = deriveSkillProjections(
    registry,
    policy,
    current.disabledNames,
    current.revision,
  )

  // Write serialization: chains async writes so the CAS check + persist + swap
  // run to completion before the next writer's revision check reads `current`.
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

  const setEnabled = (
    name: string,
    enabled: boolean,
    expectedRevision: number,
  ): Promise<SkillSetEnabledResult> =>
    serialize(async (): Promise<SkillSetEnabledResult> => {
      // CAS on the unified revision. Stale ⇒ typed reject, NO persist, NO swap.
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
      // Name-keyed pre-check (unknown fails closed; required/banned by NAME).
      const rejection = precheckMutation(registry, required, banned, name, enabled)
      if (rejection !== null) return { ok: false, rejection }

      // PERSIST FIRST, under the store's CROSS-PROCESS lock. `mutate` re-reads the
      // fresh on-disk set and re-applies the transform inside the critical
      // section, so a concurrent process's disable (that landed while we waited
      // for the lock) is preserved (re-sync + re-apply) instead of clobbered —
      // the returned `record.revision` is bumped from the FRESH on-disk value and
      // may jump past `current.revision`. A failure MUST leave the old view live:
      // we do NOT touch `current`/`view` until the durable write succeeds.
      let record: PersistedDisabledSet
      try {
        const outcome = await deps.disabledStore.mutate(
          current.revision,
          disabledSetTransform(name, enabled),
        )
        record = outcome.record
      } catch (err) {
        const detail = errMessage(err)
        return { ok: false, rejection: { kind: "persist_failed", detail } }
      }

      // Durable ⇒ adopt the freshly-committed {names, revision} and rebuild all
      // three projections + publish atomically.
      const next = new Set(record.names)
      current = { disabledNames: next, revision: record.revision }
      view = deriveSkillProjections(registry, policy, next, record.revision)
      return { ok: true, view }
    })

  const sync = (): Promise<SkillRuntimeView> =>
    serialize(async () => {
      // The durable store is the SOURCE OF TRUTH: persist-before-publish means our
      // own committed revision never exceeds what is on disk, so adopting the
      // persisted {revision, names} verbatim converges to another process's write
      // without ever rolling back or publishing stale names at a high revision.
      const persisted = await deps.disabledStore.read()
      const names = new Set(persisted.names)
      current = { disabledNames: names, revision: persisted.revision }
      view = deriveSkillProjections(registry, policy, names, persisted.revision)
      return view
    })

  return {
    read: () => view,
    setEnabled,
    resolveActive: (name) => view.active.find((s) => s.name === name),
    sync,
  }
}
