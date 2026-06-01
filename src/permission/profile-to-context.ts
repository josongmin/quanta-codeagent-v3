/**
 * GAP2 — derive the live {@link PermissionContext} from a named
 * {@link PermissionProfile} at session start.
 *
 * RATIONALE (deep-map finding): the named-profile / two-layer machinery is
 * LARGELY REDUNDANT with the existing permission system —
 * `PermissionProfile.network` is already enforced by the A1 dispatch-guard, and
 * the approval pillar is already enforced by `evaluateStack`. The only clean,
 * non-duplicating move is to DERIVE the loop's existing `PermissionContext.mode`
 * from the profile's `approval.mode` at session start (NOT add a second gate).
 *
 * Axis mapping (`PermissionProfile.approval.mode` → `PermissionContext.mode`):
 *   - `auto`    → `"auto"`     — the profile opts into the classifier-driven
 *                                AFK path; the loop's `"auto"` mode degrades
 *                                safely to `"ask"` when no `classify` port is
 *                                wired.
 *   - `once`    → `"default"`  — interactive per-action approval (the loop's
 *   - `session` → `"default"`    `"default"` mode runs the normal HITL gate;
 *   - `always`  → `"default"`    once/session/always all keep the prompt).
 *
 * Axes NOT mapped here (enforced elsewhere, deliberately):
 *   - `network`    — enforced by the A1 network dispatch-guard
 *                    (`buildNetworkDispatchGuard`), derived from the mode's
 *                    `NetworkLever` in `assembleAgentConfig`. NOT a
 *                    dispatch-time `PermissionContext` concern.
 *   - `fileSystem` — the two-layer access checker is NOT dispatch-time
 *                    enforceable through `PermissionContext`; it gates the
 *                    file-access layer, not the per-tool approval mode.
 *   - `sandbox`    — OS-sandbox posture is wired via `QUANTA_SANDBOX` /
 *                    `installCliSandbox`, orthogonal to the approval mode.
 *   - `control`    — admin/audit metadata; not a `PermissionContext` axis.
 *
 * Pure + total: every `ApprovalMode` discriminant maps; no `process.env`, no
 * I/O. Leaf slice — depends only on the local pure types.
 */

import type { ApprovalMode, PermissionProfile } from "./permission-profile"
import type { PermissionMode } from "./types"

/** Map a profile `approval.mode` to the loop's `PermissionContext.mode`.
 *  Total over the closed {@link ApprovalMode} union (the `default` arm is
 *  unreachable for a well-typed input but kept so a future enum member fails
 *  loud in review rather than silently picking a permissive mode). */
export const approvalModeToContextMode = (mode: ApprovalMode): PermissionMode => {
  switch (mode) {
    case "auto":
      return "auto"
    case "once":
    case "session":
    case "always":
      return "default"
    default:
      return "default"
  }
}

/** Derive the full {@link PermissionMode} from a resolved
 *  {@link PermissionProfile} (reads only the `approval.mode` axis — see the
 *  module doc for which axes are enforced elsewhere). */
export const permissionModeFromProfile = (profile: PermissionProfile): PermissionMode =>
  approvalModeToContextMode(profile.approval.mode)
