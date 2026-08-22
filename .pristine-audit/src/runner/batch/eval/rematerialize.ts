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

import { lstat, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { REPRO_CANONICAL_BASENAME } from "@/agent/repro-test/scaffold-patterns"
import { errMessage, logger } from "@/shared"
import { type ProjectEnvSandboxFs, prepareProjectEnvSandbox } from "../corpus/project-env"
import { exec } from "./exec"

/**
 * Real-fs `ProjectEnvSandboxFs` port (node:fs/promises) for candidate-PROOF
 * build-env materialization. Mirrors the `snapshotFsPort` in {@link ./snapshot}
 * byte-for-byte so the proof path and the main-run snapshot path materialize the
 * SAME way (one materialization semantics, two call sites). The corpus helper is
 * fs-injected so unit tests inject a fake; production wires the real filesystem
 * here. */
const rematerializeFsPort: ProjectEnvSandboxFs = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, c) => writeFile(p, c),
  exists: async (p) => {
    try {
      await readFile(p)
      return true
    } catch {
      return false
    }
  },
  readdir: (p) => readdir(p),
  isDirectory: async (p) => {
    try {
      return (await lstat(p)).isDirectory()
    } catch {
      return false
    }
  },
}

/**
 * Candidate-proof build-env materialization (FAIL-OPEN).
 *
 * For repos whose build backend imports a dep at BUILD time (e.g. astropy's
 * `setup.py` does `import extension_helpers`), the candidate's source-only tree
 * cannot be `uv`-built unless the `[tool.uv.extra-build-dependencies]` table is
 * present in `pyproject.toml`. The leading `resetToBase` in
 * {@link withCandidatePatch} (`checkout -f && reset --hard && clean -fdx`) wipes
 * any pre-existing materialization, so the proof probe would otherwise hit a
 * build failure for astropy and the proof oracle could NEVER validate an astropy
 * candidate. This re-injects the block AFTER the candidate patch is applied.
 *
 * Insertion ordering rationale (AFTER apply, BEFORE probe):
 *  - The candidate patch is SOURCE-ONLY — the env block was stripped upstream
 *    before capture (see project-env `revertProjectEnvSandbox`). It NEVER touches
 *    `[tool.uv.extra-build-dependencies]`, so materializing AFTER apply is an
 *    append-at-EOF with no conflict, even if the candidate edits `pyproject.toml`
 *    elsewhere (its OWN tables survive verbatim).
 *  - Materializing BEFORE apply would be wiped by nothing (apply doesn't reset),
 *    but a candidate that edits pyproject could then collide; AFTER-apply is the
 *    conflict-free order and matches what the probe must build.
 *
 * FAIL-OPEN: a materialization throw (fs error, etc.) is swallowed to `false`
 * exactly like {@link applyCandidatePatch}'s `Bun.write` throw, so the proof loop
 * degrades to the existing `null`/skip path rather than crashing. The repo-set
 * caller treats "couldn't materialize" the same as "couldn't re-materialize the
 * candidate" — never a false-RED rejection.
 *
 * No explicit revert is needed: {@link withCandidatePatch}'s trailing `finally`
 * `resetToBase` (`clean -fdx`) wipes the block, and withCandidatePatch captures
 * NO diff (it only runs a probe), so the env-only mutation can never leak.
 */
export const materializeBuildEnv = async (sandbox: string, repo: string): Promise<boolean> => {
  try {
    await prepareProjectEnvSandbox(sandbox, repo, rematerializeFsPort)
    return true
  } catch {
    return false
  }
}

/** Temp patch file written into the sandbox root for `git apply`. Untracked, so
 *  `git clean -fdx` in the reset removes it even if the explicit unlink fails. */
const CAND_PATCH_FILE = ".quanta-cand.patch"
const CANONICAL_REPRO_FILE_NAME = REPRO_CANONICAL_BASENAME

const readCanonicalReproScaffold = async (sandbox: string): Promise<string | undefined> => {
  try {
    return await readFile(join(sandbox, CANONICAL_REPRO_FILE_NAME), "utf8")
  } catch (e) {
    // Absent scaffold (ENOENT) is the normal case ⇒ undefined, silently. A real
    // read failure (perms/IO) is NOT expected and must be visible, not masked as
    // a genuinely missing scaffold.
    const enoent = (e as { code?: string } | null)?.code === "ENOENT"
    if (!enoent) {
      logger.warn("rematerialize.read_canonical_repro_failed", { sandbox, cause: errMessage(e) })
    }
    return undefined
  }
}

const restoreCanonicalReproScaffold = async (
  sandbox: string,
  content: string | undefined,
): Promise<void> => {
  if (content === undefined) return
  await writeFile(join(sandbox, CANONICAL_REPRO_FILE_NAME), content)
}

const resetToBaseKeepingReproScaffold = async (
  sandbox: string,
  baseCommit: string,
  timeoutMs: number,
  reproScaffold: string | undefined,
): Promise<boolean> => {
  const ok = await resetToBase(sandbox, baseCommit, timeoutMs)
  if (ok) await restoreCanonicalReproScaffold(sandbox, reproScaffold)
  return ok
}

/** Bench git prefix (shell-string form) — matches {@link withGitSnapshot}'s `G`
 *  exactly: pinned identity + `gpgsign=false` so a host signing config never
 *  blocks the reset/apply. Exported as the SSOT so reset AND apply share ONE
 *  identity (the "matches withGitSnapshot's G exactly" invariant), and tests can
 *  pin that both git seams use it. */
export const PINNED_GIT_IDENTITY = "git -c user.email=b@b -c user.name=b -c commit.gpgsign=false"
const G = PINNED_GIT_IDENTITY

/** Build the `git apply` command for a candidate patch file. Uses the pinned
 *  identity prefix (`G`) — NOT a bare `git` — so it is symmetric with
 *  {@link resetToBase} and a host `commit.gpgsign=true` / signing hook can never
 *  influence re-materialization. `git apply` does not commit, so this is
 *  behaviorally identical to the prior bare form; the prefix removes the
 *  asymmetry / latent footgun. Pure + exported for a wiring-proof test. */
export const buildApplyCommand = (patchFile: string): string =>
  `${G} apply --whitespace=nowarn ${patchFile}`

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
  const r = await exec(buildApplyCommand(CAND_PATCH_FILE), sandbox, timeoutMs)
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
 * Ordering: reset → apply → materialize-build-env → probe → (finally) reset. The
 * leading reset is REQUIRED because the shared sandbox arrives dirty (the prior
 * candidate's tree from generation/scoring); without it `git apply` would stack
 * onto a stale worktree and the probe would measure a polluted tree.
 *
 * `repo` (optional): when set, the repo's build-env block
 * (`[tool.uv.extra-build-dependencies]`) is materialized into `pyproject.toml`
 * AFTER apply and BEFORE the probe (see {@link materializeBuildEnv}) so the
 * proof's `uv` build can succeed for repos like astropy whose build backend
 * imports a dep at build time. `repo` undefined ⇒ byte-identical to before (no
 * git/fs work added). A repo with no build-dep override (e.g. django) ⇒
 * `prepareProjectEnvSandbox` no-ops. Materialization is FAIL-OPEN — a throw is
 * swallowed and the probe still runs (the build may then fail and the probe
 * returns its own signal); it never escapes this function.
 */
export const withCandidatePatch = async <T>(args: {
  sandbox: string
  patch: string
  baseCommit: string | undefined
  timeoutMs: number
  probe: (sandbox: string) => Promise<T>
  /** Optional `owner/name` slug. When set, build-env is materialized after apply
   *  / before probe so the proof build succeeds for build-time-import repos. */
  repo?: string
}): Promise<T | null> => {
  const { sandbox, patch, baseCommit, timeoutMs, probe, repo } = args
  if (patch.trim() === "" || baseCommit === undefined) return null
  const reproScaffold = await readCanonicalReproScaffold(sandbox)
  if (!(await resetToBaseKeepingReproScaffold(sandbox, baseCommit, timeoutMs, reproScaffold))) {
    return null
  }
  if (!(await applyCandidatePatch(sandbox, patch, timeoutMs))) {
    await resetToBaseKeepingReproScaffold(sandbox, baseCommit, timeoutMs, reproScaffold)
    return null
  }
  // AFTER apply, BEFORE probe: re-inject the build-env block the leading reset
  // wiped, so the proof build (e.g. astropy `uv run --with-editable .`) succeeds.
  // FAIL-OPEN — swallowed to `false`, never crashes the probe loop. No explicit
  // revert: the trailing `finally` reset's `clean -fdx` wipes it and this seam
  // captures no diff, so the env-only mutation cannot leak.
  if (repo !== undefined) await materializeBuildEnv(sandbox, repo)
  try {
    return await probe(sandbox)
  } finally {
    await resetToBaseKeepingReproScaffold(sandbox, baseCommit, timeoutMs, reproScaffold)
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
  const reproScaffold = await readCanonicalReproScaffold(sandbox)
  if (!(await resetToBaseKeepingReproScaffold(sandbox, baseCommit, timeoutMs, reproScaffold))) {
    return null
  }
  try {
    return await applyCandidatePatch(sandbox, patch, timeoutMs)
  } finally {
    await resetToBaseKeepingReproScaffold(sandbox, baseCommit, timeoutMs, reproScaffold)
  }
}
