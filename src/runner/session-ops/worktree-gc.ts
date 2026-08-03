/**
 * RFC-06 §RFC06-3 — explicit operator worktree GC (aug-02 absorption).
 *
 * A two-phase, NON-autonomous cleanup: `--dry-run` JOINS persisted owned
 * `SessionMeta.workspaceOwnership` records against the live porcelain registry
 * and classifies each into a verdict + reason; `--apply` RE-CHECKS the dry-run
 * snapshot identity (TOCTOU) and removes ONLY `eligible` targets through the
 * hardened non-force `removeWorktree`. There is NO daemon, NO reaper, NO TTL/
 * PID/path-name ownership, and NO `--force`. Legacy `.claude/worktrees/agent-*`
 * trees have no quanta provenance ⇒ they are NEVER a GC target (salvage report
 * only, elsewhere).
 *
 * SOLID: this leaf ORCHESTRATES existing owners — it reads the persisted
 * ownership authority (`@/session`), the porcelain read model
 * (`@/runtime/worktree-inspect`), and the hardened mutation owner
 * (`@/runtime` `removeWorktree`). It creates NO new ownership/state/removal
 * authority of its own.
 */

import { realpath } from "node:fs/promises"
import {
  findByExactPath,
  inspectWorktrees,
  type RemoveOutcome,
  removeWorktree,
  type WorktreeInspection,
} from "@/runtime"
import { loadSessionById, type WorkspaceOwnership } from "@/session"

/** Best-effort realpath canonicalization (macOS `/tmp` → `/private/tmp`). A
 *  path whose dir is gone has no realpath ⇒ we keep the raw string (still a
 *  valid identity for the `missing` verdict). This is identity-under-
 *  canonicalization, NOT path inference — no substring/prefix/name guessing. */
const canonical = async (p: string): Promise<string> => realpath(p).catch(() => p)

/** Return a copy of `worktrees` with every `path` realpath-canonicalized so a
 *  verbatim compare against a canonicalized ownership path is symlink-safe. */
const canonicalizeRegistry = async (
  worktrees: readonly WorktreeInspection[],
): Promise<readonly WorktreeInspection[]> =>
  Promise.all(worktrees.map(async (w) => ({ ...w, path: await canonical(w.path) })))

/** Why a candidate is NOT eligible for GC — the operator-facing reason. Only
 *  `eligible` is ever removed; every other verdict is report-only. */
export type GcVerdict =
  /** Registered, clean, unlocked, owned by a settled/closing session ⇒ removable. */
  | "eligible"
  /** Registered but has uncommitted/untracked changes ⇒ preserve. */
  | "dirty"
  /** Registered but git-locked ⇒ preserve (never force). */
  | "locked"
  /** Persisted path is no longer registered (git dir gone / already removed). */
  | "missing"
  /** Persisted path exists but the porcelain path differs (moved). */
  | "moved"
  /** Ownership record is in a terminal error state (`quarantined`/`failed`). */
  | "quarantined"

/** One GC candidate: the persisted owner facts + the joined porcelain state +
 *  the classified verdict. `sessionId` ties it back to the owning session. */
export interface GcCandidate {
  readonly sessionId: string
  readonly ownership: WorkspaceOwnership
  readonly verdict: GcVerdict
  readonly reason: string
  /** The joined porcelain inspection (absent when `missing`). */
  readonly registered?: WorktreeInspection
}

/** Result of a dry-run plan over one repo's owned worktrees. */
export interface GcPlan {
  readonly repoRoot: string
  readonly candidates: readonly GcCandidate[]
}

/**
 * Classify ONE persisted ownership record against the live porcelain registry.
 * PURE (given the already-read `worktrees` + a dirty probe result) — the caller
 * supplies the dirty state so this stays deterministic and unit-testable.
 *
 * `dirty` is `true`/`false` when known, or `undefined` when the git-status probe
 * could not run (⇒ fail closed to `dirty`, never treat unknown as clean).
 */
export const classifyGcCandidate = (
  sessionId: string,
  ownership: WorkspaceOwnership,
  worktrees: readonly WorktreeInspection[],
  dirty: boolean | undefined,
  /** The path to MATCH against the (already-canonicalized) `worktrees` — the
   *  realpath-canonical form of `ownership.path`. Defaults to `ownership.path`
   *  for the pure/no-symlink case; the plan builder passes the canonical form
   *  so a symlinked root still matches exactly. NOT inference — verbatim
   *  identity under filesystem canonicalization. */
  matchPath: string = ownership.path,
): GcCandidate => {
  const mk = (
    verdict: GcVerdict,
    reason: string,
    registered?: WorktreeInspection,
  ): GcCandidate => ({
    sessionId,
    ownership,
    verdict,
    reason,
    ...(registered !== undefined ? { registered } : {}),
  })

  // Terminal error ownership ⇒ operator-only quarantine (never auto-removed).
  if (ownership.state === "failed" || ownership.state === "quarantined") {
    return mk("quarantined", `ownership state is "${ownership.state}" — operator action required`)
  }

  const registered = findByExactPath(worktrees, matchPath)
  if (registered === undefined) {
    return mk("missing", "persisted path is not in the porcelain registry (already gone / moved)")
  }
  if (registered.locked) {
    return mk(
      "locked",
      `git-locked${registered.lockedReason ? `: ${registered.lockedReason}` : ""}`,
      registered,
    )
  }
  // A detached/branch mismatch against the persisted branch ⇒ moved/unknown
  // provenance; do not treat as our exact target.
  if (registered.branch !== ownership.branch) {
    return mk(
      "moved",
      `registered branch "${registered.branch ?? "(detached)"}" ≠ persisted "${ownership.branch}"`,
      registered,
    )
  }
  if (dirty === undefined) {
    return mk("dirty", "clean state unknown (git status probe failed) — preserved", registered)
  }
  if (dirty) {
    return mk("dirty", "uncommitted/untracked changes — preserved", registered)
  }
  return mk("eligible", "registered, clean, unlocked, exact-owned", registered)
}

/** Probe shape the planner uses to read a worktree's dirty state. Injected so
 *  the plan builder is testable without a real git subprocess. */
export type DirtyProbe = (worktreePath: string) => Promise<boolean | undefined>

/** Enumerate owned worktree records for `repoRoot` from persisted sessions.
 *  Loads each session's FULL snapshot (authoritative — never trusts a possibly
 *  stale index copy of the ownership record). Returns `(sessionId, ownership)`
 *  pairs whose `repoRoot` matches. */
export const collectOwnedWorktrees = async (
  sessionIds: readonly string[],
  repoRoot: string,
): Promise<readonly { sessionId: string; ownership: WorkspaceOwnership }[]> => {
  const out: { sessionId: string; ownership: WorkspaceOwnership }[] = []
  for (const id of sessionIds) {
    const saved = await loadSessionById(id)
    const ownership = saved?.meta.workspaceOwnership
    if (ownership === undefined) continue
    if (ownership.repoRoot !== repoRoot) continue
    out.push({ sessionId: id, ownership })
  }
  return out
}

/**
 * Build a dry-run GC plan for `repoRoot`. Reads the live porcelain registry
 * ONCE, then classifies every owned record. Returns a report-only plan — NO
 * mutation happens here. On a porcelain read failure the plan is empty with the
 * error surfaced by the caller (fail closed — never invent eligibility).
 */
export const planWorktreeGc = async (
  owned: readonly { sessionId: string; ownership: WorkspaceOwnership }[],
  repoRoot: string,
  dirtyProbe: DirtyProbe,
): Promise<{ ok: true; plan: GcPlan } | { ok: false; error: string }> => {
  const inspected = await inspectWorktrees(repoRoot)
  if (!inspected.ok) return { ok: false, error: inspected.error }
  const registry = await canonicalizeRegistry(inspected.worktrees)
  const candidates: GcCandidate[] = []
  for (const { sessionId, ownership } of owned) {
    const matchPath = await canonical(ownership.path)
    // Only probe dirty state when the path is actually registered (a missing
    // path has no dir to stat) — but classify handles the missing case too.
    const registered = findByExactPath(registry, matchPath)
    const dirty = registered === undefined ? undefined : await dirtyProbe(ownership.path)
    candidates.push(classifyGcCandidate(sessionId, ownership, registry, dirty, matchPath))
  }
  return { ok: true, plan: { repoRoot, candidates } }
}

/** Per-target apply outcome. `skipped` covers a TOCTOU drift (the target was
 *  eligible at dry-run but changed) and any non-eligible dry-run verdict. */
export interface GcApplyResult {
  readonly sessionId: string
  readonly path: string
  readonly action: "removed" | "skipped"
  readonly reason: string
  readonly removeOutcome?: RemoveOutcome
}

/**
 * Apply a dry-run plan. For each `eligible` candidate it RE-CHECKS the live
 * registry + dirty state (TOCTOU) and removes ONLY if the target is STILL
 * exact-registered, clean, unlocked, and branch-matched. Any drift ⇒ `skipped`
 * with the reason. Non-eligible candidates are skipped verbatim. Removal goes
 * through the hardened non-force `removeWorktree`; a `refused`/`error` outcome
 * is reported, never escalated. Partial failure CONTINUES (report-only).
 */
export const applyWorktreeGc = async (
  plan: GcPlan,
  dirtyProbe: DirtyProbe,
  remove: typeof removeWorktree = removeWorktree,
): Promise<readonly GcApplyResult[]> => {
  const results: GcApplyResult[] = []
  for (const candidate of plan.candidates) {
    if (candidate.verdict !== "eligible") {
      results.push({
        sessionId: candidate.sessionId,
        path: candidate.ownership.path,
        action: "skipped",
        reason: `not eligible (${candidate.verdict})`,
      })
      continue
    }
    // TOCTOU RECHECK: re-read the registry + dirty state right before removal.
    const recheck = await inspectWorktrees(plan.repoRoot)
    if (!recheck.ok) {
      results.push({
        sessionId: candidate.sessionId,
        path: candidate.ownership.path,
        action: "skipped",
        reason: `recheck failed: ${recheck.error}`,
      })
      continue
    }
    const freshRegistry = await canonicalizeRegistry(recheck.worktrees)
    const matchPath = await canonical(candidate.ownership.path)
    const fresh = classifyGcCandidate(
      candidate.sessionId,
      candidate.ownership,
      freshRegistry,
      await dirtyProbe(candidate.ownership.path),
      matchPath,
    )
    if (fresh.verdict !== "eligible") {
      results.push({
        sessionId: candidate.sessionId,
        path: candidate.ownership.path,
        action: "skipped",
        reason: `changed since dry-run (now ${fresh.verdict})`,
      })
      continue
    }
    const outcome = await remove(candidate.ownership.path, candidate.ownership.repoRoot, {
      branch: candidate.ownership.branch,
    })
    const removed = outcome.kind === "removed" || outcome.kind === "absent"
    results.push({
      sessionId: candidate.sessionId,
      path: candidate.ownership.path,
      action: removed ? "removed" : "skipped",
      reason: removed ? `removed (${outcome.kind})` : `remove refused (${outcome.kind})`,
      removeOutcome: outcome,
    })
  }
  return results
}
