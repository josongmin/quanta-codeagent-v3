/**
 * Network-egress guard wiring (Track A1 — ADR-0229 follow-up).
 *
 * Bridges the active mode's network posture (`NetworkLever` /
 * `PermissionProfile.network`) into a concrete {@link DispatchGuard} so that
 * outbound egress is ACTUALLY ENFORCED — closing the "defined-but-not-wired"
 * hole where `network-allowlist.ts` + `checkHostAllowlist` shipped but nothing
 * ever set `config.dispatchGuard`.
 *
 * Design (default-OFF / byte-identical):
 *   - `open`      ⇒ returns `undefined`. The composition root leaves
 *                   `config.dispatchGuard` unset ⇒ dispatch is byte-identical
 *                   to the pre-wire path. This is the natural default-OFF:
 *                   only restrictive modes activate enforcement.
 *   - `allowlist` ⇒ a `defaultDispatchGuard({ networkAllowlist: hosts })`.
 *                   An empty `hosts` denies all egress (detector semantics).
 *                   When `perRequestApproval` is true the off-list host routes
 *                   to `ask` (HITL) instead of `deny`.
 *   - `denied`    ⇒ a `defaultDispatchGuard({ networkAllowlist: [] })` — the
 *                   empty allowlist denies every egress-bearing tool call.
 *
 * The guard ALSO keeps the git-write-protect + branch-only contributions that
 * `defaultDispatchGuard` composes (most-conservative wins); callers that need
 * those independently of the network posture wire the guard directly. This
 * helper is the single place the network posture → guard mapping lives.
 *
 * Plane-clean: imports ONLY sibling files (`./default-guard`, `./port`). The
 * `NetworkLever` shape is mirrored as a structural parameter (not imported)
 * so this leaf does not take a `@/agent/run-mode` dependency — the composition
 * root passes the already-narrowed lever.
 */

import { defaultDispatchGuard } from "./default-guard"
import type { DispatchGuard } from "./port"

/** The three network postures a mode can bind. Structural mirror of
 *  `NetworkLever["kind"]` (run-mode slice) — kept inline so this leaf has no
 *  cross-slice import. A drift test in the hellgate pins the two together. */
export type NetworkPosture = "open" | "allowlist" | "denied"

export interface NetworkGuardSpec {
  /** Active network posture from the mode's `NetworkLever`. */
  readonly posture: NetworkPosture
  /** Effective allowlist hosts. Consulted ONLY when `posture === "allowlist"`.
   *  Absent ⇒ treated as `[]` (deny-all within the allowlist posture — the
   *  strictest sensible reading of "allowlist with no hosts"). */
  readonly hosts?: readonly string[]
  /** ADR-0135 `NetworkPolicy.perRequestApproval`. When true (and
   *  `posture === "allowlist"`), an off-list host routes to `ask` instead of
   *  `deny`. Ignored for `open` / `denied`. */
  readonly perRequestApproval?: boolean
  /** Branches the composed guard treats as protected (forwarded verbatim to
   *  `defaultDispatchGuard`). Absent ⇒ the detector's default protected set. */
  readonly protectedBranches?: readonly string[]
  /** Current branch HEAD points to (forwarded verbatim). Absent ⇒ the
   *  branch-only check degrades to "no contribution". */
  readonly currentBranch?: string
  /** Tools an embedding host registered itself (`createAnalysisAgent({ tools })`): the
   *  host's own code, which it chose to give the agent, so the deny-all posture permits
   *  them alongside `DENY_ALL_PERMITTED_TOOLS`. Never MCP or plugin tools — those are a
   *  third party's. */
  readonly hostTools?: readonly string[]
}

/**
 * Build the dispatch guard for a network posture, or `undefined` when the
 * posture imposes no egress restriction (`open`).
 *
 * `undefined` is load-bearing: the composition root only sets
 * `config.dispatchGuard` when this returns a guard, so an `open`-network mode
 * stays byte-identical to the pre-wire path.
 */
export const buildNetworkDispatchGuard = (spec: NetworkGuardSpec): DispatchGuard | undefined => {
  if (spec.posture === "open") return undefined

  // `denied` ⇒ deny ALL egress (empty allowlist). `allowlist` ⇒ the mode's
  // hosts (absent ⇒ `[]`, i.e. deny-all within the allowlist posture).
  const networkAllowlist: readonly string[] = spec.posture === "denied" ? [] : (spec.hosts ?? [])

  return defaultDispatchGuard({
    networkAllowlist,
    // perRequestApproval only meaningful for the `allowlist` posture; for
    // `denied` we never route to `ask` (egress is categorically refused).
    ...(spec.posture === "allowlist" && spec.perRequestApproval === true
      ? { perRequestApproval: true }
      : {}),
    ...(spec.protectedBranches !== undefined ? { protectedBranches: spec.protectedBranches } : {}),
    ...(spec.currentBranch !== undefined ? { currentBranch: spec.currentBranch } : {}),
    ...(spec.hostTools !== undefined ? { hostPermittedTools: new Set(spec.hostTools) } : {}),
  })
}
