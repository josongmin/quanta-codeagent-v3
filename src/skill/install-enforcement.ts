/**
 * Skill install enforcement (ADR-0134 §3) — admin policy ↔ user attempts.
 *
 * Pure decision functions over (policy, attempt) ⇒ outcome. The host wraps
 * these with the audit log writer (Phase C) so every enforcement decision
 * leaves a trail. Splitting decision from logging keeps the unit-test
 * surface narrow.
 *
 * Decision matrix (ADR-0134 §3):
 *
 *   attempt.kind       | policy state              | outcome
 *   -------------------|---------------------------|--------------------------
 *   install (non-admin)| skill in bannedSkills     | DENY  + audit("banned_install_blocked")
 *   install (non-admin)| skill not banned          | ALLOW
 *   install (admin)    | no org-policy.json        | DENY  ("admin scope disabled")
 *   install (admin)    | org-policy.json present   | ALLOW + audit("admin_install")
 *   remove (admin)     | always                    | ALLOW + audit("admin_remove")
 *   disable            | skill is admin-installed  | DENY  + audit("admin_attempt_disable")
 *   disable            | skill is NOT admin        | ALLOW
 */

import type { AdminPolicy } from "./admin-policy"
import type { SkillScope } from "./types"

export interface InstallAttempt {
  readonly kind: "install" | "remove" | "disable"
  readonly skillName: string
  readonly requestedScope: SkillScope
  /** When non-null, the caller has admin privileges (set by host). */
  readonly admin?: string | null
  /** Acting user identifier (optional). */
  readonly user?: string | null
}

export interface InstallDecision {
  readonly allowed: boolean
  readonly reason: string
  /** Event to audit (when the host has audit enabled). null ⇒ no audit. */
  readonly auditEvent:
    | "admin_install"
    | "admin_remove"
    | "admin_attempt_disable"
    | "banned_install_blocked"
    | null
}

const decideAdminInstall = (policy: AdminPolicy | null): InstallDecision => {
  if (policy === null) {
    return {
      allowed: false,
      reason: "admin scope is disabled (no org-policy.json found)",
      auditEvent: null,
    }
  }
  return {
    allowed: true,
    reason: "admin install permitted by org-policy.json",
    auditEvent: "admin_install",
  }
}

const decideNonAdminInstall = (
  attempt: InstallAttempt,
  policy: AdminPolicy | null,
): InstallDecision => {
  if (policy?.bannedSkills.includes(attempt.skillName) === true) {
    return {
      allowed: false,
      reason: `skill '${attempt.skillName}' is banned by admin policy`,
      auditEvent: "banned_install_blocked",
    }
  }
  return { allowed: true, reason: "install permitted", auditEvent: null }
}

const decideAdminRemove = (policy: AdminPolicy | null): InstallDecision => {
  if (policy === null) {
    return {
      allowed: false,
      reason: "admin remove rejected: no org-policy.json found",
      auditEvent: null,
    }
  }
  return {
    allowed: true,
    reason: "admin remove permitted by org-policy.json",
    auditEvent: "admin_remove",
  }
}

const decideDisable = (attempt: InstallAttempt, policy: AdminPolicy | null): InstallDecision => {
  // Disable is only blocked when the target skill is admin-required. The
  // host passes requestedScope = "admin" when the user is attempting to
  // disable an admin-installed skill; the policy.requiredSkills list is
  // the SSOT for "must stay installed".
  const isAdminRequired =
    policy?.requiredSkills.includes(attempt.skillName) === true &&
    attempt.requestedScope === "admin"
  if (isAdminRequired) {
    return {
      allowed: false,
      reason: `skill '${attempt.skillName}' is admin-required; users cannot disable it`,
      auditEvent: "admin_attempt_disable",
    }
  }
  return { allowed: true, reason: "disable permitted", auditEvent: null }
}

/**
 * Decide one install/remove/disable attempt against the loaded policy.
 *
 * `policy === null` means "no org-policy.json on this host". In that case:
 *  - admin-scope attempts are DENIED (admin scope inactive — ADR §3)
 *  - non-admin install: ALLOWED (no banned list to check)
 *  - disable: ALLOWED (no admin installs to protect)
 */
export const decideInstall = (
  attempt: InstallAttempt,
  policy: AdminPolicy | null,
): InstallDecision => {
  if (attempt.kind === "install") {
    return attempt.requestedScope === "admin"
      ? decideAdminInstall(policy)
      : decideNonAdminInstall(attempt, policy)
  }
  if (attempt.kind === "remove") {
    return attempt.requestedScope === "admin"
      ? decideAdminRemove(policy)
      : { allowed: true, reason: "remove permitted", auditEvent: null }
  }
  // kind === "disable"
  return decideDisable(attempt, policy)
}

/**
 * Cross-policy aggregator: returns the list of skill names the loaded
 * policy force-installs (i.e. requiredSkills, when the policy exists).
 * Hosts use this to ensure those names land in the registry even when no
 * SKILL.md is mounted under `<orgConfigDir>/admin-skills/`.
 */
export const requiredAdminSkillNames = (policy: AdminPolicy | null): readonly string[] =>
  policy === null ? [] : policy.requiredSkills

/**
 * Cross-policy aggregator: banned names — names the host MUST reject in
 * any non-admin scope at install time.
 */
export const bannedSkillNames = (policy: AdminPolicy | null): readonly string[] =>
  policy === null ? [] : policy.bannedSkills
