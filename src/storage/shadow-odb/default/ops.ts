/** Internal operations for `defaultShadowOdb`.
 *
 *  Behavior-preserving extraction of the factory's local helpers and the
 *  returned object's method bodies. Every function here takes the
 *  factory's closed-over collaborators (`runner`, `now`, `cfg`, `states`)
 *  as an explicit `OdbDeps` param — the `states` Map is passed BY
 *  REFERENCE so the per-workspace promise-chain mutex keeps mutating the
 *  same object the factory holds. Control flow (early returns / throws)
 *  is preserved exactly. */

import { promises as fs } from "node:fs"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { writeFileAtomic } from "../../atomic-write"
import type { GitRunner } from "../../git-runner"
import {
  assertRepoRelativePaths,
  assertSafeRef,
  ensureNotNested,
  INIT_MARKER,
  resolveBaseDir,
  runShadow,
  runShadowOrThrow,
  validateWorkspaceRoot,
} from "../default-helpers"
import { workspaceHash } from "../hash"
import {
  type RewindOptions,
  SHADOW_LAST_REF,
  SHADOW_LAST_VERIFIED_REF,
  SHADOW_PRE_REWIND_REF_PREFIX,
  type ShadowInitResult,
  type ShadowOdbConfig,
  ShadowOdbError,
  type SnapshotMetadata,
} from "../types"

export interface WorkspaceState {
  shadowDir: string
  gitDir: string
  hash: string
  // Promise-chained mutex for serialized writes.
  chain: Promise<unknown>
}

/** Closed-over collaborators of the factory, threaded explicitly. */
export interface OdbDeps {
  runner: GitRunner
  now: () => Date
  cfg: ShadowOdbConfig
  states: Map<string, WorkspaceState>
  /** Strictly-monotonic, factory-scoped counter for pre-rewind safety-net
   *  ref names. Two rewinds whose `now()` lands in the SAME millisecond
   *  (or share a frozen test clock) still mint distinct refs because this
   *  suffix advances on every `captureSafetyNet` call. Mutable single-field
   *  box so the increment is visible to every op sharing the `deps` value. */
  refSeq: { n: number }
}

export const resolveState = (deps: OdbDeps, workspaceRoot: string): WorkspaceState => {
  const baseDir = resolveBaseDir(deps.cfg)
  const hash = workspaceHash(workspaceRoot)
  const shadowDir = join(baseDir, "snapshots", hash)
  const gitDir = join(shadowDir, ".git")
  let st = deps.states.get(hash)
  if (st === undefined) {
    st = { shadowDir, gitDir, hash, chain: Promise.resolve() }
    deps.states.set(hash, st)
  }
  return st
}

/** Acquire the per-workspace promise chain so `fn` runs after every
 *  prior write has settled. Used by `init`/`registerHead` so two
 *  concurrent callers never race the ref update. */
export const serialize = async <T>(st: WorkspaceState, fn: () => Promise<T>): Promise<T> => {
  const prev = st.chain
  let release: (v: unknown) => void = () => {}
  st.chain = new Promise((resolve) => {
    release = resolve
  })
  try {
    await prev.catch(() => {
      // Prior caller's failure must not poison ours.
    })
    return await fn()
  } finally {
    release(undefined)
  }
}

/** True iff the init marker for this shadow store already exists. */
const isAlreadyInitialized = async (markerPath: string): Promise<boolean> => {
  try {
    await fs.access(markerPath)
    return true
  } catch {
    return false
  }
}

/** `git init --quiet` inside the freshly-created shadow dir. Errors
 *  are normalized to typed ShadowOdbErrors so initInner stays flat. */
const gitInitShadow = async (runner: GitRunner, shadowDir: string): Promise<void> => {
  try {
    const r = await runner.run(["init", "--quiet"], shadowDir)
    if (r.exitCode !== 0) {
      throw new ShadowOdbError(
        "git-failed",
        `shadow git init exited ${r.exitCode}: ${r.stderr.trim()}`,
      )
    }
  } catch (err) {
    if (err instanceof ShadowOdbError) throw err
    const msg = errMessage(err)
    throw new ShadowOdbError("spawn-failed", `shadow git init failed: ${msg}`)
  }
}

/** Set the deterministic identity + no-GPG config so registerHead
 *  never prompts the user. Local config inside the shadow store
 *  only — user's global git config is untouched. */
const applyShadowConfig = async (runner: GitRunner, st: WorkspaceState): Promise<void> => {
  const cfgs: readonly (readonly string[])[] = [
    ["config", "user.email", "shadow-odb@quanta.local"],
    ["config", "user.name", "quanta-shadow-odb"],
    ["config", "commit.gpgsign", "false"],
    // Stops git complaining about "dubious ownership" when the
    // shadow dir is on a different filesystem than the workspace.
    ["config", "safe.directory", "*"],
  ]
  for (const args of cfgs) {
    await runShadowOrThrow(runner, st.gitDir, st.shadowDir, args)
  }
}

export const initInner = async (
  deps: OdbDeps,
  st: WorkspaceState,
  workspaceRoot: string,
): Promise<void> => {
  await ensureNotNested(st.shadowDir, workspaceRoot)
  await fs.mkdir(st.shadowDir, { recursive: true })
  const markerPath = join(st.shadowDir, INIT_MARKER)
  if (await isAlreadyInitialized(markerPath)) return
  await gitInitShadow(deps.runner, st.shadowDir)
  await applyShadowConfig(deps.runner, st)
  // T11 / L9 H9: write the init marker through the slice's ONE atomic write
  // helper (temp + rename). The next `init` short-circuits on the marker's
  // PRESENCE, so a non-atomic write could leave a 0-byte / partial marker
  // that makes a re-init skip `applyShadowConfig` — a half-configured store
  // masquerading as "ready". Atomic write makes the marker absent-or-complete.
  await writeFileAtomic(markerPath, `${deps.now().toISOString()}\n`)
}

const registerInner = async (
  deps: OdbDeps,
  st: WorkspaceState,
  workspaceRoot: string,
): Promise<string> => {
  const { runner, now } = deps
  // Stage everything (including deletions) at the shadow index.
  await runShadowOrThrow(runner, st.gitDir, workspaceRoot, ["add", "-A"])
  // Commit. We allow empty so a registerHead with no changes still
  // produces a fresh SHA the caller can attach metadata to.
  const ts = now().toISOString()
  await runShadowOrThrow(runner, st.gitDir, workspaceRoot, [
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    `snapshot ${ts}`,
  ])
  // Resolve the new commit SHA.
  const headRef = await runShadowOrThrow(runner, st.gitDir, workspaceRoot, ["rev-parse", "HEAD"])
  const sha = headRef.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ShadowOdbError("git-failed", `unexpected HEAD SHA from shadow git: ${sha}`)
  }
  assertSafeRef(SHADOW_LAST_REF)
  await runShadowOrThrow(runner, st.gitDir, workspaceRoot, ["update-ref", SHADOW_LAST_REF, sha])
  return sha
}

/* ------------------------------------------------------------------ */
/* method bodies                                                       */
/* ------------------------------------------------------------------ */

export const opInit = async (deps: OdbDeps, workspaceRoot: string): Promise<ShadowInitResult> => {
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  await serialize(st, () => initInner(deps, st, canonical))
  return { shadowDir: st.shadowDir, workspaceHash: st.hash }
}

export const opRegisterHead = async (deps: OdbDeps, workspaceRoot: string): Promise<string> => {
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  return await serialize(st, async () => {
    await initInner(deps, st, canonical)
    return await registerInner(deps, st, canonical)
  })
}

export const opDiffSinceLast = async (deps: OdbDeps, workspaceRoot: string): Promise<string> => {
  const { runner } = deps
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  // Resolve ref; if it doesn't exist, the workspace was never
  // registered.
  const refCheck = await runShadow(runner, st.gitDir, canonical, [
    "rev-parse",
    "--verify",
    "--quiet",
    SHADOW_LAST_REF,
  ])
  if (refCheck.exitCode !== 0) {
    throw new ShadowOdbError(
      "uninitialized",
      `shadow ODB has no ${SHADOW_LAST_REF} for ${canonical} — call registerHead first`,
    )
  }
  // Diff that ref against the working tree (no --cached: we want
  // the *uncommitted* state to surface). Untracked files won't
  // show in `git diff <ref>` semantics — see ADR-0108 한계.
  const r = await runShadow(runner, st.gitDir, canonical, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    SHADOW_LAST_REF,
  ])
  if (r.exitCode !== 0) {
    throw new ShadowOdbError(
      "git-failed",
      `shadow git diff exited ${r.exitCode}: ${r.stderr.trim()}`,
    )
  }
  return r.stdout
}

export const opDiffWorkspaceSinceLast = async (
  deps: OdbDeps,
  anchorWorkspace: string,
  comparisonWorkspace: string,
): Promise<string> => {
  const { runner } = deps
  // Validate BOTH paths up front. Identical symlink-leaf / relative-
  // path rejection as `diffSinceLast` — we never want a malicious
  // comparison path to slip past path safety just because the anchor
  // already cleared it (HELL-18/19).
  const anchorCanonical = await validateWorkspaceRoot(anchorWorkspace)
  const comparisonCanonical = await validateWorkspaceRoot(comparisonWorkspace)
  const st = resolveState(deps, anchorCanonical)
  // The shadow store lives under the ANCHOR workspace's hash. The
  // ref must exist on THAT store — comparison workspace contributes
  // only the working tree pointer (`--work-tree=...`).
  const refCheck = await runShadow(runner, st.gitDir, comparisonCanonical, [
    "rev-parse",
    "--verify",
    "--quiet",
    SHADOW_LAST_REF,
  ])
  if (refCheck.exitCode !== 0) {
    throw new ShadowOdbError(
      "uninitialized",
      `shadow ODB has no ${SHADOW_LAST_REF} for anchor ${anchorCanonical} — call registerHead first`,
    )
  }
  // git diff exit codes: 0 = no diff, 1 = differences found. Both are
  // success for our purposes; anything else (e.g. 128) is fatal.
  const r = await runShadow(runner, st.gitDir, comparisonCanonical, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    SHADOW_LAST_REF,
  ])
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    throw new ShadowOdbError(
      "git-failed",
      `shadow git diff (workspace) exited ${r.exitCode}: ${r.stderr.trim()}`,
    )
  }
  return r.stdout
}

/** MERGE_HEAD guard shared by every rewind-family op. Returns when no
 *  merge is in progress (or override is set); throws otherwise. */
const assertNoMergeInProgress = async (
  canonical: string,
  opts: RewindOptions | undefined,
  label: string,
): Promise<void> => {
  if (opts?.allowDirtyMerge === true) return
  const mergeHead = join(canonical, ".git", "MERGE_HEAD")
  let mergeInProgress = false
  try {
    await fs.access(mergeHead)
    mergeInProgress = true
  } catch {
    // ENOENT — no merge in progress, fall through.
  }
  if (mergeInProgress) {
    throw new ShadowOdbError(
      "merge-in-progress",
      `refusing ${label}: ${mergeHead} exists (pass allowDirtyMerge:true to override)`,
    )
  }
}

/** Capture the current worktree to a fresh, create-only pre-rewind ref
 *  (the safety net shared by every rewind-family op). `msgLabel` names
 *  the commit subject (`pre-rewind` / `pre-rewind-partial` / …). */
const captureSafetyNet = async (
  deps: OdbDeps,
  st: WorkspaceState,
  canonical: string,
  msgLabel: string,
): Promise<void> => {
  const { runner, now } = deps
  // ISO timestamp with `:` and `.` replaced by `-` because git refuses
  // colons (and treats `.` runs specially) in ref names (`refusing to
  // update ref with bad name`). Millisecond resolution is preserved
  // (yyyy-mm-ddThh-mm-ss-sssZ) and a strictly-monotonic factory-scoped
  // counter is appended so two rewinds within the SAME millisecond — or
  // sharing a frozen test clock — still mint DISTINCT refs instead of
  // colliding into a `rewind-failed` on the create-only ref update below.
  const seq = ++deps.refSeq.n
  const isoTs = now().toISOString().replace(/:/g, "-").replace(/\./g, "-")
  const suffix = `${isoTs}-${seq}`
  const preRewindRef = `${SHADOW_PRE_REWIND_REF_PREFIX}${suffix}`
  // Stage current worktree to the shadow index.
  await runShadowOrThrow(runner, st.gitDir, canonical, ["add", "-A"])
  // Commit (allow-empty so a "no change since last register" rewind
  // still produces a recovery SHA distinct from SHADOW_LAST_REF).
  await runShadowOrThrow(runner, st.gitDir, canonical, [
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    `${msgLabel} ${suffix}`,
  ])
  const headRef = await runShadowOrThrow(runner, st.gitDir, canonical, ["rev-parse", "HEAD"])
  const preSha = headRef.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(preSha)) {
    throw new ShadowOdbError(
      "rewind-failed",
      `unexpected HEAD SHA from ${msgLabel} commit: ${preSha}`,
    )
  }
  // Create-only ref update: third arg "0000…" (40 zeros = empty-oid
  // sentinel) tells git to fail if the ref ALREADY exists (HELL-25).
  // The `${isoTs}-${seq}` suffix already guarantees uniqueness across
  // rapid sequential rewinds (millisecond + monotonic counter), so this
  // remains a defence-in-depth guard against a truly concurrent collision
  // — it surfaces a typed `rewind-failed` rather than silently clobbering
  // the first one's safety net.
  const empty = "0".repeat(40)
  const updRef = await runShadow(runner, st.gitDir, canonical, [
    "update-ref",
    preRewindRef,
    preSha,
    empty,
  ])
  if (updRef.exitCode !== 0) {
    throw new ShadowOdbError(
      "rewind-failed",
      `pre-rewind ref ${preRewindRef} create failed: ${updRef.stderr.trim() || updRef.stdout.trim()}`,
    )
  }
}

/** Full-tree restore (read-tree --reset + checkout-index) of `ref`
 *  into the worktree, optionally discarding untracked files. Shared by
 *  `rewindToLast` and `rewindToVerified`. */
const restoreFullTree = async (
  deps: OdbDeps,
  st: WorkspaceState,
  canonical: string,
  ref: string,
  opts: RewindOptions | undefined,
): Promise<void> => {
  const { runner } = deps
  // Reset INDEX to `ref` (without `-u`: see rewindToLast header).
  const rt = await runShadow(runner, st.gitDir, canonical, ["read-tree", "--reset", ref])
  if (rt.exitCode !== 0) {
    throw new ShadowOdbError(
      "rewind-failed",
      `read-tree --reset ${ref} failed: ${rt.stderr.trim()}`,
    )
  }
  // checkout-index writes every tracked-in-snapshot file to the
  // worktree (overwriting mods + recreating deletions). Files NOT in
  // the new index (= post-snapshot adds) are untouched ⇒
  // `untracked:preserve` default holds.
  const ci = await runShadow(runner, st.gitDir, canonical, ["checkout-index", "-a", "-f"])
  if (ci.exitCode !== 0) {
    throw new ShadowOdbError("rewind-failed", `checkout-index -a -f failed: ${ci.stderr.trim()}`)
  }
  // Optionally discard untracked files.
  if (opts?.untracked === "discard") {
    const cl = await runShadow(runner, st.gitDir, canonical, ["clean", "-fd"])
    if (cl.exitCode !== 0) {
      throw new ShadowOdbError("rewind-failed", `clean -fd failed: ${cl.stderr.trim()}`)
    }
  }
}

export const opRewindToLast = async (
  deps: OdbDeps,
  workspaceRoot: string,
  opts?: RewindOptions,
): Promise<void> => {
  // Order is deliberate (ADR-0118):
  // 1. path-safety (same as init/registerHead)
  // 2. ensure shadow store init
  // 3. SHADOW_LAST_REF must exist (else nothing to rewind to)
  // 4. MERGE_HEAD guard (refuse on half-finished merges)
  // 5. SAFETY NET: snapshot current worktree to a NEW pre-rewind ref
  //    BEFORE we touch the worktree (create-only sentinel — see
  //    captureSafetyNet).
  // 6. read-tree --reset (NO -u) updates the INDEX to SHADOW_LAST_REF
  //    without touching the worktree — needed because the safety-net
  //    `git add -A` just put post-snapshot untracked files into the
  //    index, and `-u` would delete them from the worktree to match
  //    the new tree (violating `untracked:preserve`).
  // 7. checkout-index -a -f writes every tracked-in-snapshot file
  //    back to the worktree (restoring modifications + re-creating
  //    deletions). Files NOT in the new index (post-snapshot adds)
  //    are untouched — that's how `preserve` is honoured.
  // 8. opts.untracked === "discard" → git clean -fd to remove
  //    files that exist in the worktree but not in the snapshot.
  // 9. SHADOW_LAST_REF is INTENTIONALLY NOT advanced. After rewind
  //    the worktree state == old SHADOW_LAST_REF content, so the ref
  //    still correctly describes the worktree.
  const { runner } = deps
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  await serialize(st, async () => {
    await initInner(deps, st, canonical)
    // (3) SHADOW_LAST_REF must exist.
    const refCheck = await runShadow(runner, st.gitDir, canonical, [
      "rev-parse",
      "--verify",
      "--quiet",
      SHADOW_LAST_REF,
    ])
    if (refCheck.exitCode !== 0) {
      throw new ShadowOdbError(
        "uninitialized",
        `shadow ODB has no ${SHADOW_LAST_REF} for ${canonical} — call registerHead first`,
      )
    }
    // (4) MERGE_HEAD guard.
    await assertNoMergeInProgress(canonical, opts, "rewind")
    // (5) SAFETY NET — capture current worktree state to a fresh ref.
    await captureSafetyNet(deps, st, canonical, "pre-rewind")
    // (6-8) Restore full tree from SHADOW_LAST_REF.
    await restoreFullTree(deps, st, canonical, SHADOW_LAST_REF, opts)
    // (9) Do NOT advance SHADOW_LAST_REF — see comment at top.
  })
}

export const opRestorePartial = async (
  deps: OdbDeps,
  workspaceRoot: string,
  paths: ReadonlyArray<string>,
  opts?: RewindOptions,
): Promise<void> => {
  const { runner } = deps
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  assertRepoRelativePaths(paths)
  if (paths.length === 0) return
  const st = resolveState(deps, canonical)
  await serialize(st, async () => {
    await initInner(deps, st, canonical)
    // SHADOW_LAST_REF presence check (uninitialized fires BEFORE
    // safety net so a never-registered workspace doesn't accumulate
    // pre-rewind refs as a side effect — same invariant as
    // rewindToLast's HELL-21).
    const refCheck = await runShadow(runner, st.gitDir, canonical, [
      "rev-parse",
      "--verify",
      "--quiet",
      SHADOW_LAST_REF,
    ])
    if (refCheck.exitCode !== 0) {
      throw new ShadowOdbError(
        "uninitialized",
        `shadow ODB has no ${SHADOW_LAST_REF} for ${canonical} — call registerHead first`,
      )
    }
    await assertNoMergeInProgress(canonical, opts, "restorePartial")
    // Safety-net: FULL-tree pre-rewind ref. Same logic as
    // rewindToLast's safety net so the partial-restore caller has
    // the same recovery surface (a user who restored the wrong path
    // can still pull back unrelated edits from this ref).
    await captureSafetyNet(deps, st, canonical, "pre-rewind-partial")
    // Path-scoped checkout. The `--` is the standard pathspec
    // separator; we route every entry as a single argv so spaces
    // and quotes never get shell-split.
    const co = await runShadow(runner, st.gitDir, canonical, [
      "checkout",
      SHADOW_LAST_REF,
      "--",
      ...paths,
    ])
    if (co.exitCode !== 0) {
      throw new ShadowOdbError(
        "rewind-failed",
        `checkout ${SHADOW_LAST_REF} -- <paths> failed: ${co.stderr.trim() || co.stdout.trim()}`,
      )
    }
  })
}

export const opMarkVerified = async (deps: OdbDeps, workspaceRoot: string): Promise<void> => {
  const { runner } = deps
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  await serialize(st, async () => {
    await initInner(deps, st, canonical)
    const r = await runShadow(runner, st.gitDir, canonical, [
      "rev-parse",
      "--verify",
      "--quiet",
      SHADOW_LAST_REF,
    ])
    if (r.exitCode !== 0) {
      throw new ShadowOdbError(
        "uninitialized",
        `shadow ODB has no ${SHADOW_LAST_REF} for ${canonical} — call registerHead first`,
      )
    }
    const sha = r.stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new ShadowOdbError("git-failed", `unexpected SHA from rev-parse: ${sha}`)
    }
    assertSafeRef(SHADOW_LAST_VERIFIED_REF)
    await runShadowOrThrow(runner, st.gitDir, canonical, [
      "update-ref",
      SHADOW_LAST_VERIFIED_REF,
      sha,
    ])
  })
}

export const opRewindToVerified = async (
  deps: OdbDeps,
  workspaceRoot: string,
  opts?: RewindOptions,
): Promise<void> => {
  const { runner } = deps
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  await serialize(st, async () => {
    await initInner(deps, st, canonical)
    // Verified-ref presence check (no-verified-anchor BEFORE safety
    // net — same invariant as rewindToLast's uninitialized check).
    const refCheck = await runShadow(runner, st.gitDir, canonical, [
      "rev-parse",
      "--verify",
      "--quiet",
      SHADOW_LAST_VERIFIED_REF,
    ])
    if (refCheck.exitCode !== 0) {
      throw new ShadowOdbError(
        "no-verified-anchor",
        `shadow ODB has no ${SHADOW_LAST_VERIFIED_REF} for ${canonical} — call markVerified first`,
      )
    }
    await assertNoMergeInProgress(canonical, opts, "rewindToVerified")
    // Safety-net pre-rewind ref. Identical name/flow to rewindToLast.
    await captureSafetyNet(deps, st, canonical, "pre-rewind-verified")
    await restoreFullTree(deps, st, canonical, SHADOW_LAST_VERIFIED_REF, opts)
    // SHADOW_LAST_REF + SHADOW_LAST_VERIFIED_REF are both intentionally
    // NOT advanced — same reasoning as rewindToLast (worktree now
    // matches old verified content; both refs still describe truth).
  })
}

export const opListSnapshots = async (
  deps: OdbDeps,
  workspaceRoot: string,
): Promise<readonly SnapshotMetadata[]> => {
  const { runner } = deps
  const canonical = await validateWorkspaceRoot(workspaceRoot)
  const st = resolveState(deps, canonical)
  // Ensure shadow init exists so for-each-ref doesn't ENOENT on the
  // git dir. ensureInit is idempotent and serialized — same chain as
  // registerHead so a concurrent rewind can't yank the store mid-scan.
  await serialize(st, () => initInner(deps, st, canonical))
  const args = [
    "for-each-ref",
    "--format=%(refname)|%(objectname)|%(committerdate:unix)",
    "refs/quanta/snapshots/",
    "--sort=-committerdate",
  ]
  const r = await runShadow(runner, st.gitDir, canonical, args)
  if (r.exitCode !== 0) {
    throw new ShadowOdbError("git-failed", `for-each-ref exited ${r.exitCode}: ${r.stderr.trim()}`)
  }
  const out: SnapshotMetadata[] = []
  for (const raw of r.stdout.split("\n")) {
    const line = raw.trim()
    if (line.length === 0) continue
    const parts = line.split("|")
    if (parts.length !== 3) {
      throw new ShadowOdbError("git-failed", `unparseable for-each-ref line: ${raw}`)
    }
    const [ref, sha, tsStr] = parts as [string, string, string]
    if (ref.length === 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new ShadowOdbError("git-failed", `unparseable for-each-ref line: ${raw}`)
    }
    const ts = Number(tsStr)
    if (!Number.isFinite(ts)) {
      throw new ShadowOdbError("git-failed", `unparseable for-each-ref line: ${raw}`)
    }
    out.push({ ref, sha, timestampSec: ts })
  }
  return out
}
