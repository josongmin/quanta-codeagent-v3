/**
 * Candidate-patch re-materialization (verify-and-select TD hard-gate seam).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The selection executor scores candidates AFTER all N are generated. Each
 * generation runs inside {@link withGitSnapshot}, which resets the sandbox to
 * the base commit at the START of every candidate and never restores the patch
 * afterward — so by scoring time the sandbox holds the LAST candidate's tree (or
 * base), NOT the candidate being scored. A hard-gate probe (regression / patched
 * resolved-K-of-N) that ran `pytest` on the sandbox AS-IS would therefore measure
 * the WRONG tree for every candidate — a false signal ("theater") that silently
 * defeats the whole gate. (Symptom we are explicitly guarding against: a wired
 * gate that does not actually engage.)
 *
 * {@link withCandidatePatch} re-materializes ONE candidate's tree for the
 * duration of a probe: reset → `git apply` the candidate diff → run the probe →
 * reset. The reset seam is byte-for-byte the one {@link withGitSnapshot} uses,
 * so the materialized tree is the canonical `base_commit + candidate.patch`.
 *
 * ── Fail-open by construction ────────────────────────────────────────────────
 * Returns `null` (NOT a verdict) when the candidate cannot be faithfully
 * re-materialized — empty patch, no base commit, the reset failed, or the patch
 * does not apply clean. The VerificationBundle treats a `null` hard signal as
 * "no objection" (never a rejection): a candidate we cannot re-materialize must
 * never be PUNISHED by a false-RED. Only a probe that actually runs returns a
 * real signal.
 *
 * ── Sequential-only ──────────────────────────────────────────────────────────
 * Mutates the single shared sandbox; callers MUST invoke it sequentially (the
 * executor's scoring loop is sequential). The `finally` reset leaves the sandbox
 * at base for the next call regardless of how the probe exits.
 */

import { join } from "node:path"
import { exec } from "./exec"

/** Temp patch file written into the sandbox root for `git apply`. Untracked, so
 *  `git clean -fdx` in the reset removes it even if the explicit unlink fails. */
const CAND_PATCH_FILE = ".quanta-cand.patch"

/** Bench git prefix (shell-string form) — matches {@link withGitSnapshot}'s `G`
 *  exactly: pinned identity + `gpgsign=false` so a host signing config never
 *  blocks the reset/apply. */
const G = "git -c user.email=b@b -c user.name=b -c commit.gpgsign=false"

/**
 * Hard-reset the sandbox to `baseCommit`: discard ALL worktree edits + untracked
 * files, exactly as {@link withGitSnapshot}'s pre-image prep does. Returns true
 * iff git succeeded (a non-git / detached sandbox ⇒ false ⇒ caller fails open).
 */
export const resetToBase = async (
  sandbox: string,
  baseCommit: string,
  timeoutMs: number,
): Promise<boolean> => {
  const r = await exec(
    `${G} checkout -q -f ${baseCommit} && ${G} reset -q --hard ${baseCommit} && ${G} clean -qfdx`,
    sandbox,
    timeoutMs,
  )
  return r.code === 0
}

/**
 * Apply `patch` to `sandbox` via a temp file + `git apply --whitespace=nowarn`
 * (the same flags the gold-sanity check uses — tolerant of trailing-whitespace
 * noise, strict on content). The patch is the unified `diff --git a/… b/…` the
 * executor captured, so default `-p1` strip is correct. Returns true iff it
 * applied clean. The temp file is removed regardless of outcome.
 */
export const applyCandidatePatch = async (
  sandbox: string,
  patch: string,
  timeoutMs: number,
): Promise<boolean> => {
  // `Bun.write` can THROW (ENOSPC / read-only / bad path) — that is a
  // re-materialization failure, NOT a probe failure, so it must surface as
  // `false` (→ withCandidatePatch returns null, fail-open) rather than
  // propagating out and crashing the caller (the regression port does not wrap
  // withCandidatePatch in its own try/catch). The probe's OWN throw still
  // propagates (intentional, tested contract).
  try {
    await Bun.write(join(sandbox, CAND_PATCH_FILE), patch)
  } catch {
    return false
  }
  const r = await exec(`git apply --whitespace=nowarn ${CAND_PATCH_FILE}`, sandbox, timeoutMs)
  // Best-effort unlink; a failure here is harmless (the next reset's `clean -fdx`
  // sweeps the untracked file, and it is never part of a probe's collection).
  await exec(`rm -f ${CAND_PATCH_FILE}`, sandbox, timeoutMs)
  return r.code === 0
}

/**
 * Run `probe` against the sandbox materialized to `base_commit + patch`, then
 * restore the sandbox to base. Returns the probe's result, or `null` when the
 * candidate cannot be faithfully re-materialized (FAIL-OPEN — see module doc).
 *
 * Ordering: reset → apply → probe → (finally) reset. The leading reset is
 * REQUIRED because the shared sandbox arrives dirty (the prior candidate's tree
 * from generation/scoring); without it `git apply` would stack onto a stale
 * worktree and the probe would measure a polluted tree.
 */
export const withCandidatePatch = async <T>(args: {
  sandbox: string
  patch: string
  baseCommit: string | undefined
  timeoutMs: number
  probe: (sandbox: string) => Promise<T>
}): Promise<T | null> => {
  const { sandbox, patch, baseCommit, timeoutMs, probe } = args
  if (patch.trim() === "" || baseCommit === undefined) return null
  if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return null
  if (!(await applyCandidatePatch(sandbox, patch, timeoutMs))) {
    await resetToBase(sandbox, baseCommit, timeoutMs)
    return null
  }
  try {
    return await probe(sandbox)
  } finally {
    await resetToBase(sandbox, baseCommit, timeoutMs)
  }
}

/**
 * Probe-free applyability check for a candidate patch.
 *
 * Returns:
 *   - `false` when the candidate is definitely not admissible on applyability
 *     grounds (empty patch or `git apply` failed against base),
 *   - `true` when the patch applied cleanly,
 *   - `null` when the reset/apply seam is unavailable (no base commit / reset
 *     failure), so callers can FAIL-OPEN rather than fabricate a false red.
 */
export const candidatePatchAppliesCleanly = async (args: {
  sandbox: string
  patch: string
  baseCommit: string | undefined
  timeoutMs: number
}): Promise<boolean | null> => {
  const { sandbox, patch, baseCommit, timeoutMs } = args
  if (patch.trim() === "") return false
  if (baseCommit === undefined) return null
  if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return null
  try {
    return await applyCandidatePatch(sandbox, patch, timeoutMs)
  } finally {
    await resetToBase(sandbox, baseCommit, timeoutMs)
  }
}
