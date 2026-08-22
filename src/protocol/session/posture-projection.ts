/**
 * RFC-05 E4 — the WIRE PROJECTION of a resolved posture (the requested /
 * effective / locks echo a surface renders + the typed outcome a
 * `session.posture.set` yields).
 *
 * This is a PLAIN, unbranded structural mirror of the permission slice's
 * `ResolvedPermissionPosture` (`@/permission/posture/types`): the live authority
 * value carries a module-private `unique symbol` lock brand that MUST NOT cross
 * the wire, so the host de-brands each lock into a {@link PostureLockView} (its
 * value-only fields, VERBATIM — the surface never remaps a lock reason, §E4 stop
 * rule). The `PosturePatch` / `ThreadPermission` shapes are already plain and are
 * reused by TYPE only (the protocol slice never imports the `@/permission` VALUE
 * — the AST scanner skips type-only imports).
 */

import type { ThreadPermission } from "@/permission/permission-store"
import type { PosturePatch } from "@/permission/posture/types"

/** A de-branded posture lock — the value-only fields of a producer-minted
 *  `PostureLock`, carried VERBATIM (reason NOT remapped). */
export interface PostureLockView {
  readonly reason: string
  readonly producer: string
  readonly label: string
  readonly detail?: string
}

/** The operator-REQUESTED projection: the lossless patch + the named preset the
 *  effective record projects to (`null` ⇒ "custom"). */
export interface PostureRequestedView {
  readonly preset: string | null
  readonly patch: PosturePatch
}

/** The fully-RESOLVED effective projection the gate evaluates against. */
export interface PostureEffectiveView {
  readonly threadPermission: ThreadPermission
  readonly reviewerRoute: string
  readonly askOutsidePlan: boolean
  readonly effectiveMode: string
}

/** The complete posture echo at ONE revision: requested patch, effective view
 *  (incl `effectiveMode`), and the admitted locks — all at the SAME revision as
 *  the mutation that produced it (RFC-05 E4 requirement #2). */
export interface PostureProjectionView {
  readonly revision: number
  readonly requested: PostureRequestedView
  readonly effective: PostureEffectiveView
  readonly locks: readonly PostureLockView[]
}

/**
 * The TYPED outcome the host's `setPosture` projection returns to the kernel
 * scheduler. A negative arm is a typed refusal with NO live mutation and NO
 * success echo (RFC-05 E4 hard rule: unsupported-host / stale ⇒ typed negative,
 * never a silent success). On `ok` the scheduler reconciles the fresh
 * {@link PostureProjectionView} from the host's `describe()` (its authoritative
 * echo source) at the SAME revision — the outcome itself carries no view so the
 * echo has ONE source of truth. `setPosture` being ABSENT (not returning this)
 * is the distinct unsupported-host negative the scheduler raises.
 */
export type PostureCommandOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly kind: "stale_revision"
      readonly expected: number
      readonly actual: number
    }
  | { readonly ok: false; readonly kind: "persist_failed"; readonly detail: string }
