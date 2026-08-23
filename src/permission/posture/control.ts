/**
 * RFC-05 E4 — the posture FRONT-DOOR control: the SINGLE engine both the host
 * `setPosture` projection (the `session.posture.set` / `session.permission.set`
 * wire path) AND the CLI `/posture` selector operate through. One place resolves
 * a posture mutation over E2/E3's live {@link PostureAuthority}, so the wire and
 * the REPL can never drift into two mutation semantics.
 *
 * It exposes exactly the two E2 durable entries as explicit scopes:
 *   - `scope: "current"` mutates THIS thread's live posture through the shared
 *     authority (so the next turn's gate reads it) under CAS on the posture-domain
 *     revision — a stale `expectedRevision` is a typed `stale_revision` conflict,
 *     never a clobber of a newer commit.
 *   - `scope: "default"` mutates the FUTURE-thread default store (a change that
 *     never reaches back into already-created threads — the E2 thread-copy
 *     boundary). The default is an operator single-writer setting with no
 *     revision, so it carries no CAS.
 *
 * The de-branded {@link PostureProjectionView} is what crosses the wire / renders
 * on a surface: a posture lock's producer-minted brand (a module-private
 * `unique symbol`) must not leave the permission slice, so each lock's value-only
 * fields are carried VERBATIM (reason NOT remapped — §E4 stop rule).
 *
 * Slice: `@/permission` siblings + `@/shared`; the `@/protocol/session` posture
 * projection TYPES are imported type-only (the AST scanner skips type-only
 * imports — no value dependency on the protocol slice).
 */

import type {
  PostureCommandOutcome,
  PostureCommandScope,
  PostureLockView,
  PostureProjectionView,
} from "@/protocol/session"
import { errMessage } from "@/shared"
import type { ControlPolicy } from "../permission-profile"
import type { PermissionMode } from "../types"
import type { PostureAuthority } from "./authority"
import { buildResolvedPosture } from "./availability"
import type { ManagedPolicyPort, PermissionDefaultsPort } from "./ports"
import { applyPatch, toCustomPatch } from "./presets"
import type { PosturePatch, ResolvedPermissionPosture, ReviewerAvailability } from "./types"

/** The posture front-door control both surfaces share. */
export interface PostureControl {
  /** The live resolved CURRENT-thread posture (the authority's published view). */
  read(): ResolvedPermissionPosture
  /** De-branded projection of the CURRENT-thread posture (wire / surface echo). */
  describe(): PostureProjectionView
  /** De-branded projection of the FUTURE-thread DEFAULT, or `null` when this
   *  control was built without a default store. */
  describeDefault(): PostureProjectionView | null
  /** Apply a lossless patch at the given scope. `current` CAS-guards on the
   *  authority revision; `default` writes the future-thread default (no CAS). */
  apply(args: {
    readonly patch: PosturePatch
    readonly scope: PostureCommandScope
    readonly expectedRevision?: number
  }): Promise<PostureCommandOutcome>
}

export interface PostureControlDeps {
  readonly authority: PostureAuthority
  /** The FUTURE-thread default store. Absent ⇒ `scope: "default"` is a typed
   *  negative and `describeDefault()` returns `null`. */
  readonly defaults?: PermissionDefaultsPort | undefined
  readonly reviewerAvailability: ReviewerAvailability
  /** Live managed-policy producer for the default projection's locks/clamp. */
  readonly managedPolicy?: ManagedPolicyPort | undefined
  /** The managed-forced mode for the default projection's effective view. */
  readonly managedMode?: PermissionMode | undefined
}

/** De-brand a producer-minted posture lock into its wire-safe value fields
 *  (reason carried VERBATIM — never remapped). */
const toLockView = (lock: {
  readonly reason: string
  readonly producer: string
  readonly label: string
  readonly detail?: string | undefined
}): PostureLockView => ({
  reason: lock.reason,
  producer: lock.producer,
  label: lock.label,
  ...(lock.detail !== undefined ? { detail: lock.detail } : {}),
})

/** Project a live resolved posture into the de-branded wire/surface view. */
export const toPostureProjectionView = (
  resolved: ResolvedPermissionPosture,
): PostureProjectionView => ({
  revision: resolved.revision,
  requested: {
    preset: resolved.requested.preset,
    patch: resolved.requested.patch,
  },
  effective: {
    threadPermission: resolved.effective.threadPermission,
    reviewerRoute: resolved.effective.reviewerRoute,
    askOutsidePlan: resolved.effective.askOutsidePlan,
    effectiveMode: resolved.effective.effectiveMode,
  },
  locks: resolved.locks.map((l) => toLockView(l)),
})

export const buildPostureControl = (deps: PostureControlDeps): PostureControl => {
  const describeDefault = (): PostureProjectionView | null => {
    if (deps.defaults === undefined) return null
    const record = deps.defaults.readDefault()
    const control: ControlPolicy | undefined = deps.managedPolicy?.read()
    const resolved = buildResolvedPosture({
      record,
      // The default is a template, not a live CAS cell — surface its own
      // revision as 0 (the initial revision a copy binds under).
      revision: 0,
      requestedPatch: toCustomPatch(record),
      availability: deps.reviewerAvailability,
      ...(control !== undefined ? { managedPolicy: control } : {}),
      ...(deps.managedMode !== undefined ? { managedMode: deps.managedMode } : {}),
    })
    return toPostureProjectionView(resolved)
  }

  const applyDefault = async (patch: PosturePatch): Promise<PostureCommandOutcome> => {
    if (deps.defaults === undefined) {
      return {
        ok: false,
        kind: "persist_failed",
        detail: "no future-thread default store wired",
      }
    }
    const next = applyPatch(deps.defaults.readDefault(), patch)
    try {
      await deps.defaults.writeDefault(next)
    } catch (err) {
      return {
        ok: false,
        kind: "persist_failed",
        detail: errMessage(err),
      }
    }
    return { ok: true }
  }

  const applyCurrent = async (
    patch: PosturePatch,
    expectedRevision: number | undefined,
  ): Promise<PostureCommandOutcome> => {
    const expected = expectedRevision ?? deps.authority.read().revision
    const result = await deps.authority.set(patch, expected)
    if (result.ok) return { ok: true }
    if (result.rejection.kind === "stale_revision") {
      return {
        ok: false,
        kind: "stale_revision",
        expected: result.rejection.expected,
        actual: result.rejection.actual,
      }
    }
    return { ok: false, kind: "persist_failed", detail: result.rejection.detail }
  }

  return {
    read: () => deps.authority.read(),
    describe: () => toPostureProjectionView(deps.authority.read()),
    describeDefault,
    apply: ({ patch, scope, expectedRevision }) =>
      scope === "default" ? applyDefault(patch) : applyCurrent(patch, expectedRevision),
  }
}
