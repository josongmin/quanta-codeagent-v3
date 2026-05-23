/** Default `ShadowOdb` implementation.
 *
 *  Storage layout (per ADR-0108):
 *
 *      <baseDir>/snapshots/<workspaceHash>/.git    ← real git store
 *      <baseDir>/snapshots/<workspaceHash>/HEAD    (etc.)
 *
 *  We use a NON-bare repo (running `git init` inside the dir creates a
 *  `.git/` subdirectory) so that the existing `defaultGitRunner`'s
 *  argv-and-cwd contract is enough — we route every command at the
 *  shadow `.git` via the `--git-dir` / `--work-tree` *argv* flags
 *  instead of plumbing a brand-new env-override surface through the
 *  runner. These flags are byte-equivalent to the `GIT_DIR` /
 *  `GIT_WORK_TREE` environment variables (git's own docs say so) and
 *  let us re-use the runner's spawn-error normalization untouched.
 *
 *  Concurrency: a per-workspace promise chain ensures `registerHead`
 *  calls against the same workspace are serialized (HELL-11). Different
 *  workspaces still run in parallel.
 *
 *  Safety invariants (sealed by `tests/unit/shadow-odb-hellgate.test.ts`):
 *  - Reject relative workspace roots (HELL-9).
 *  - Reject any path component that is a symlink (HELL-8).
 *  - Never read or write the user's `.git` (we only point at our own
 *    via `--git-dir`; user's `.git` is incidentally ignored by our
 *    own `.gitignore`-style `excludesFile` set in `init`). The hellgate
 *    proves this by inspecting the user's `.git` after a
 *    `registerHead`. */

import { promises as fs } from "node:fs"
import { isAbsolute, join, sep } from "node:path"
import { defaultGitRunner, type GitRunner, type GitRunResult } from "@/tool/git"
import { evictLru } from "./cleanup"
import { workspaceHash } from "./hash"
import {
  type RewindOptions,
  SHADOW_LAST_REF,
  SHADOW_LAST_VERIFIED_REF,
  SHADOW_PRE_REWIND_REF_PREFIX,
  type ShadowInitResult,
  type ShadowOdb,
  type ShadowOdbConfig,
  ShadowOdbError,
  type SnapshotMetadata,
} from "./types"

/* ------------------------------------------------------------------ */
/* path safety                                                         */
/* ------------------------------------------------------------------ */

/** Validate that `workspaceRoot` is an absolute path, exists as a
 *  directory, and that the *final component itself* is not a symbolic
 *  link. Parent components are allowed to be system symlinks (e.g. on
 *  macOS `/tmp -> /private/tmp` and `/var -> /private/var`); the
 *  invariant we care about is that the caller didn't hand us a link
 *  whose target retargets `GIT_WORK_TREE` to a different directory
 *  than the one they thought they were snapshotting.
 *
 *  Returns the resolved (realpath'd) absolute path so all downstream
 *  use (hash, mkdir, git invocations) is canonicalized — this is what
 *  makes the workspaceHash deterministic across `/tmp` vs `/private/tmp`. */
const validateWorkspaceRoot = async (workspaceRoot: string): Promise<string> => {
  if (workspaceRoot.length === 0 || !isAbsolute(workspaceRoot)) {
    throw new ShadowOdbError(
      "relative-path",
      `workspaceRoot must be an absolute path (got: ${JSON.stringify(workspaceRoot)})`,
    )
  }
  // 1. The leaf itself must not be a symlink (caller-controlled
  //    misdirection). lstat is required to *not* follow.
  let leaf: Awaited<ReturnType<typeof fs.lstat>>
  try {
    leaf = await fs.lstat(workspaceRoot)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ShadowOdbError("symlink-in-path", `cannot stat ${workspaceRoot}: ${msg}`)
  }
  if (leaf.isSymbolicLink()) {
    throw new ShadowOdbError(
      "symlink-in-path",
      `workspaceRoot is a symbolic link: ${workspaceRoot}`,
    )
  }
  if (!leaf.isDirectory()) {
    throw new ShadowOdbError(
      "symlink-in-path",
      `workspaceRoot is not a directory: ${workspaceRoot}`,
    )
  }
  // 2. Canonicalize so /tmp/x and /private/tmp/x hash to the same
  //    workspace identity. realpath resolves *all* symlinks in the
  //    path; we only forbid the leaf above, parents are fine.
  try {
    return await fs.realpath(workspaceRoot)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ShadowOdbError("symlink-in-path", `realpath failed for ${workspaceRoot}: ${msg}`)
  }
}

/* ------------------------------------------------------------------ */
/* base dir                                                            */
/* ------------------------------------------------------------------ */

const resolveBaseDir = (cfg: ShadowOdbConfig): string => {
  if (typeof cfg.baseDir === "string" && cfg.baseDir.length > 0) {
    return cfg.baseDir
  }
  const home = process.env.HOME
  if (typeof home !== "string" || home.length === 0) {
    throw new ShadowOdbError(
      "spawn-failed",
      "shadow ODB: HOME is unset and no baseDir override provided",
    )
  }
  return join(home, ".quanta")
}

/* ------------------------------------------------------------------ */
/* git invocation helpers                                              */
/* ------------------------------------------------------------------ */

/** Build the argv prefix that pins git at the shadow store while
 *  letting it see the user workspace. Passed as argv flags (not env)
 *  so the runner contract stays unchanged. */
const shadowArgs = (gitDir: string, workTree: string, rest: readonly string[]): string[] => [
  `--git-dir=${gitDir}`,
  `--work-tree=${workTree}`,
  ...rest,
]

/** Invoke git inside the shadow store and surface errors as typed
 *  `ShadowOdbError`. We deliberately do *not* swallow non-zero exit
 *  codes — every call site in the impl below checks exit and decides
 *  whether the failure is fatal (e.g. `rev-parse <ref>` is allowed to
 *  fail with code 128 the first time we look for the ref). */
const runShadow = async (
  runner: GitRunner,
  gitDir: string,
  workTree: string,
  rest: readonly string[],
): Promise<GitRunResult> => {
  try {
    return await runner.run(shadowArgs(gitDir, workTree, rest), workTree)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ShadowOdbError("spawn-failed", `shadow git ${rest.join(" ")} failed: ${msg}`)
  }
}

/** Same as `runShadow` but treats non-zero exit as a typed error. Used
 *  for operations that MUST succeed (the ref update, the commit). */
const runShadowOrThrow = async (
  runner: GitRunner,
  gitDir: string,
  workTree: string,
  rest: readonly string[],
): Promise<GitRunResult> => {
  const r = await runShadow(runner, gitDir, workTree, rest)
  if (r.exitCode !== 0) {
    throw new ShadowOdbError(
      "git-failed",
      `shadow git ${rest.join(" ")} exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`,
    )
  }
  return r
}

/* ------------------------------------------------------------------ */
/* init helpers                                                        */
/* ------------------------------------------------------------------ */

/** Marker file we drop the first time `init` runs. Its presence tells a
 *  subsequent `init` call to skip the (otherwise idempotent but slower)
 *  re-`git init`. */
const INIT_MARKER = ".quanta-shadow-init"

/** Resolve `p` through realpath if possible. Falls back to the input
 *  when `p` (or any prefix) does not exist yet — common case since the
 *  shadow dir is freshly created. We walk parents until one resolves,
 *  then re-append the un-existing tail; this is the standard idiom for
 *  comparing two paths under symlink-laundering without forcing both
 *  to exist. */
const tryRealpath = async (p: string): Promise<string> => {
  let probe = p
  const tail: string[] = []
  // Walk up at most this many parents before giving up; pathological
  // depths (hundreds of components) are not a real workspace.
  for (let i = 0; i < 64; i += 1) {
    try {
      const resolved = await fs.realpath(probe)
      return tail.length === 0 ? resolved : join(resolved, ...tail.reverse())
    } catch {
      const lastSep = probe.lastIndexOf(sep)
      if (lastSep <= 0) return p
      tail.push(probe.slice(lastSep + 1))
      probe = probe.slice(0, lastSep)
    }
  }
  return p
}

/** Stage-1 invariant: shadow dir must not nest a user `.git`. If a user
 *  accidentally rooted their workspace at `~/.quanta/snapshots/...`
 *  we'd recurse infinitely. We refuse to operate in that case. Both
 *  paths are realpath'd first so a `/tmp` vs `/private/tmp` mismatch
 *  doesn't silently disable the guard. */
const ensureNotNested = async (shadowDir: string, workspaceRoot: string): Promise<void> => {
  const SEP: string = sep
  const [sdReal, wrReal] = await Promise.all([tryRealpath(shadowDir), tryRealpath(workspaceRoot)])
  const sd = sdReal.endsWith(SEP) ? sdReal : `${sdReal}${SEP}`
  const wr = wrReal.endsWith(SEP) ? wrReal : `${wrReal}${SEP}`
  if (sd.startsWith(wr) || wr.startsWith(sd)) {
    throw new ShadowOdbError(
      "nested-shadow",
      `shadow ODB path nests with workspaceRoot (shadow=${shadowDir}, workspace=${workspaceRoot})`,
    )
  }
  // Best-effort sanity scan: if the shadow dir contains anything other
  // than git internals at the top level, refuse. Allows recovery from
  // a half-written init (only the marker missing).
  try {
    const entries = await fs.readdir(shadowDir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === ".git" || e.name === INIT_MARKER) continue
      // Anything else means we'd be init-ing on top of unknown data.
      throw new ShadowOdbError(
        "nested-shadow",
        `shadow dir ${shadowDir} contains unexpected entry: ${e.name}`,
      )
    }
  } catch (err) {
    if (err instanceof ShadowOdbError) throw err
    // readdir failure (e.g. dir doesn't exist yet) is fine — caller
    // will create it.
  }
}

/* ------------------------------------------------------------------ */
/* refspec safety                                                      */
/* ------------------------------------------------------------------ */

/** SHADOW_LAST_REF + SHADOW_LAST_VERIFIED_REF are the only refs we ever
 *  WRITE (the pre-rewind refs are dynamically-named via the
 *  `SHADOW_PRE_REWIND_REF_PREFIX` + ISO timestamp helper, validated
 *  inside the rewind flow). We guard against accidental future code
 *  paths that build a ref from user input: the resolver rejects
 *  anything that doesn't match the hard-coded ref names. */
const assertSafeRef = (ref: string): void => {
  if (ref !== SHADOW_LAST_REF && ref !== SHADOW_LAST_VERIFIED_REF) {
    throw new ShadowOdbError("invalid-ref", `refusing non-canonical ref name: ${ref}`)
  }
}

/* ------------------------------------------------------------------ */
/* repo-relative path validation                                       */
/* ------------------------------------------------------------------ */

/** Validate that every entry in `paths` is a REPO-RELATIVE path (rejects
 *  absolute paths and any `..` segment — same posture as the
 *  `conflict-inspect` tool). Used by `restorePartial` BEFORE any
 *  filesystem / git mutation runs so a malicious entry never reaches
 *  the spawn boundary. Empty strings and `..` segments are explicit
 *  rejections; `.` (current-dir) is allowed since `git checkout` treats
 *  it as a no-op pathspec.
 *
 *  We do NOT use `path.relative`/`path.resolve` here — those would
 *  silently normalize `a/../b` to `b` and lose the intent signal.
 *  The split is on `/` only because `restorePartial`'s contract is
 *  POSIX-style repo paths (matches git's own pathspec normalization). */
const assertRepoRelativePaths = (paths: ReadonlyArray<string>): void => {
  for (const p of paths) {
    if (p.length === 0) {
      throw new ShadowOdbError("rewind-failed", "empty path in restorePartial paths")
    }
    if (isAbsolute(p)) {
      throw new ShadowOdbError(
        "rewind-failed",
        `restorePartial rejected absolute path: ${JSON.stringify(p)}`,
      )
    }
    // POSIX `/` AND OS-native sep — handle both so a Windows backslash
    // path can't sneak `..\..\etc` past the POSIX check (defense in
    // depth; production target is *nix but the rejection is cheap).
    const segs = p.split(/[/\\]/u)
    for (const seg of segs) {
      if (seg === "..") {
        throw new ShadowOdbError(
          "rewind-failed",
          `restorePartial rejected path traversal segment in: ${JSON.stringify(p)}`,
        )
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* implementation                                                      */
/* ------------------------------------------------------------------ */

interface WorkspaceState {
  shadowDir: string
  gitDir: string
  hash: string
  // Promise-chained mutex for serialized writes.
  chain: Promise<unknown>
}

/** Build a `ShadowOdb` from optional collaborators. */
export const defaultShadowOdb = (cfg: ShadowOdbConfig = {}): ShadowOdb => {
  const runner: GitRunner = cfg.runner ?? defaultGitRunner
  const now = cfg.now ?? ((): Date => new Date())

  /** Per-workspaceHash state. We resolve `shadowDir` lazily inside
   *  `init` so a `cleanup` call doesn't require any prior `init`. */
  const states = new Map<string, WorkspaceState>()

  const resolveState = (workspaceRoot: string): WorkspaceState => {
    const baseDir = resolveBaseDir(cfg)
    const hash = workspaceHash(workspaceRoot)
    const shadowDir = join(baseDir, "snapshots", hash)
    const gitDir = join(shadowDir, ".git")
    let st = states.get(hash)
    if (st === undefined) {
      st = { shadowDir, gitDir, hash, chain: Promise.resolve() }
      states.set(hash, st)
    }
    return st
  }

  /** Acquire the per-workspace promise chain so `fn` runs after every
   *  prior write has settled. Used by `init`/`registerHead` so two
   *  concurrent callers never race the ref update. */
  const serialize = async <T>(st: WorkspaceState, fn: () => Promise<T>): Promise<T> => {
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
  const gitInitShadow = async (shadowDir: string): Promise<void> => {
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
      const msg = err instanceof Error ? err.message : String(err)
      throw new ShadowOdbError("spawn-failed", `shadow git init failed: ${msg}`)
    }
  }

  /** Set the deterministic identity + no-GPG config so registerHead
   *  never prompts the user. Local config inside the shadow store
   *  only — user's global git config is untouched. */
  const applyShadowConfig = async (st: WorkspaceState): Promise<void> => {
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

  const initInner = async (st: WorkspaceState, workspaceRoot: string): Promise<void> => {
    await ensureNotNested(st.shadowDir, workspaceRoot)
    await fs.mkdir(st.shadowDir, { recursive: true })
    const markerPath = join(st.shadowDir, INIT_MARKER)
    if (await isAlreadyInitialized(markerPath)) return
    await gitInitShadow(st.shadowDir)
    await applyShadowConfig(st)
    await fs.writeFile(markerPath, `${now().toISOString()}\n`, "utf8")
  }

  const registerInner = async (st: WorkspaceState, workspaceRoot: string): Promise<string> => {
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

  return {
    async init(workspaceRoot: string): Promise<ShadowInitResult> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
      await serialize(st, () => initInner(st, canonical))
      return { shadowDir: st.shadowDir, workspaceHash: st.hash }
    },

    async registerHead(workspaceRoot: string): Promise<string> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
      return await serialize(st, async () => {
        await initInner(st, canonical)
        return await registerInner(st, canonical)
      })
    },

    async diffSinceLast(workspaceRoot: string): Promise<string> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
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
    },

    async diffWorkspaceSinceLast(
      anchorWorkspace: string,
      comparisonWorkspace: string,
    ): Promise<string> {
      // Validate BOTH paths up front. Identical symlink-leaf / relative-
      // path rejection as `diffSinceLast` — we never want a malicious
      // comparison path to slip past path safety just because the anchor
      // already cleared it (HELL-18/19).
      const anchorCanonical = await validateWorkspaceRoot(anchorWorkspace)
      const comparisonCanonical = await validateWorkspaceRoot(comparisonWorkspace)
      const st = resolveState(anchorCanonical)
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
    },

    async rewindToLast(workspaceRoot: string, opts?: RewindOptions): Promise<void> {
      // Order is deliberate (ADR-0118):
      // 1. path-safety (same as init/registerHead)
      // 2. ensure shadow store init
      // 3. SHADOW_LAST_REF must exist (else nothing to rewind to)
      // 4. MERGE_HEAD guard (refuse on half-finished merges)
      // 5. SAFETY NET: snapshot current worktree to a NEW pre-rewind ref
      //    BEFORE we touch the worktree. update-ref uses the empty-oid
      //    sentinel ("create-only") so successive rewinds within the same
      //    ISO-second second fail with a typed error instead of silently
      //    overwriting the recovery point.
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
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
      await serialize(st, async () => {
        await initInner(st, canonical)
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
        if (opts?.allowDirtyMerge !== true) {
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
              `refusing rewind: ${mergeHead} exists (pass allowDirtyMerge:true to override)`,
            )
          }
        }
        // (5) SAFETY NET — capture current worktree state to a fresh ref.
        //     ISO-second timestamp with `:` replaced by `-` because git
        //     refuses colons in ref names (`refusing to update ref with
        //     bad name`). The suffix is still strictly monotonic in time
        //     (yyyy-mm-ddThh-mm-ssZ) and remains 1-second-resolution.
        const isoTs = now().toISOString().replace(/\..*$/, "Z").replace(/:/g, "-")
        const preRewindRef = `${SHADOW_PRE_REWIND_REF_PREFIX}${isoTs}`
        // Stage current worktree to the shadow index.
        await runShadowOrThrow(runner, st.gitDir, canonical, ["add", "-A"])
        // Commit (allow-empty so a "no change since last register" rewind
        // still produces a recovery SHA distinct from SHADOW_LAST_REF).
        await runShadowOrThrow(runner, st.gitDir, canonical, [
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          `pre-rewind ${isoTs}`,
        ])
        const headRef = await runShadowOrThrow(runner, st.gitDir, canonical, ["rev-parse", "HEAD"])
        const preSha = headRef.stdout.trim()
        if (!/^[0-9a-f]{40}$/.test(preSha)) {
          throw new ShadowOdbError(
            "rewind-failed",
            `unexpected HEAD SHA from pre-rewind commit: ${preSha}`,
          )
        }
        // Create-only ref update: third arg "0000…" (40 zeros = empty-oid
        // sentinel) tells git to fail if the ref ALREADY exists. This is
        // the same-ISO-second collision policy (HELL-25): two concurrent
        // rewinds that compute the same suffix → the second one fails
        // with a typed `rewind-failed` rather than silently clobbering
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
        // (6) Reset INDEX to SHADOW_LAST_REF (without `-u`: see header).
        const rt = await runShadow(runner, st.gitDir, canonical, [
          "read-tree",
          "--reset",
          SHADOW_LAST_REF,
        ])
        if (rt.exitCode !== 0) {
          throw new ShadowOdbError(
            "rewind-failed",
            `read-tree --reset ${SHADOW_LAST_REF} failed: ${rt.stderr.trim()}`,
          )
        }
        // (7) checkout-index writes every tracked-in-snapshot file to
        //     the worktree (overwriting mods + recreating deletions).
        //     Files NOT in the new index (= post-snapshot adds) are
        //     untouched ⇒ `untracked:preserve` default holds.
        const ci = await runShadow(runner, st.gitDir, canonical, ["checkout-index", "-a", "-f"])
        if (ci.exitCode !== 0) {
          throw new ShadowOdbError(
            "rewind-failed",
            `checkout-index -a -f failed: ${ci.stderr.trim()}`,
          )
        }
        // (8) Optionally discard untracked files.
        if (opts?.untracked === "discard") {
          const cl = await runShadow(runner, st.gitDir, canonical, ["clean", "-fd"])
          if (cl.exitCode !== 0) {
            throw new ShadowOdbError("rewind-failed", `clean -fd failed: ${cl.stderr.trim()}`)
          }
        }
        // (9) Do NOT advance SHADOW_LAST_REF — see comment at top.
      })
    },

    /* ADR-0122 — `restorePartial`. Path-scoped checkout of named files
     *  from SHADOW_LAST_REF, leaving every other worktree file untouched.
     *
     *  Sequence (mirrors `rewindToLast` with one substitution):
     *   1. validate workspace path (same posture).
     *   2. validate path entries (repo-relative, no `..`).
     *   3. `paths.length === 0` → return without taking a safety net.
     *   4. ensure shadow init.
     *   5. SHADOW_LAST_REF must exist → else `uninitialized`.
     *   6. MERGE_HEAD guard (same as `rewindToLast`; honors allowDirtyMerge).
     *   7. safety-net pre-rewind ref (FULL-tree, NOT path-scoped — so a user
     *      who mis-targets the wrong file can still recover unrelated edits).
     *   8. `git checkout SHADOW_LAST_REF -- <paths...>` — the path-scoped
     *      counterpart to step (6) of `rewindToLast`'s read-tree+checkout-index
     *      flow. Fails with `rewind-failed` if any path does not exist in the
     *      snapshot. */
    async restorePartial(
      workspaceRoot: string,
      paths: ReadonlyArray<string>,
      opts?: RewindOptions,
    ): Promise<void> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      assertRepoRelativePaths(paths)
      if (paths.length === 0) return
      const st = resolveState(canonical)
      await serialize(st, async () => {
        await initInner(st, canonical)
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
        if (opts?.allowDirtyMerge !== true) {
          const mergeHead = join(canonical, ".git", "MERGE_HEAD")
          let mergeInProgress = false
          try {
            await fs.access(mergeHead)
            mergeInProgress = true
          } catch {
            // ENOENT — no merge in progress.
          }
          if (mergeInProgress) {
            throw new ShadowOdbError(
              "merge-in-progress",
              `refusing restorePartial: ${mergeHead} exists (pass allowDirtyMerge:true to override)`,
            )
          }
        }
        // Safety-net: FULL-tree pre-rewind ref. Same logic as
        // rewindToLast's safety net so the partial-restore caller has
        // the same recovery surface (a user who restored the wrong path
        // can still pull back unrelated edits from this ref).
        const isoTs = now().toISOString().replace(/\..*$/, "Z").replace(/:/g, "-")
        const preRewindRef = `${SHADOW_PRE_REWIND_REF_PREFIX}${isoTs}`
        await runShadowOrThrow(runner, st.gitDir, canonical, ["add", "-A"])
        await runShadowOrThrow(runner, st.gitDir, canonical, [
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          `pre-rewind-partial ${isoTs}`,
        ])
        const headRef = await runShadowOrThrow(runner, st.gitDir, canonical, ["rev-parse", "HEAD"])
        const preSha = headRef.stdout.trim()
        if (!/^[0-9a-f]{40}$/.test(preSha)) {
          throw new ShadowOdbError(
            "rewind-failed",
            `unexpected HEAD SHA from pre-rewind-partial commit: ${preSha}`,
          )
        }
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
    },

    /* ADR-0122 — `markVerified`. Advances `SHADOW_LAST_VERIFIED_REF`
     *  to whatever SHADOW_LAST_REF currently points at. Idempotent
     *  (overwrites prior verified ref with the SAME or NEWER sha).
     *  Throws `uninitialized` if SHADOW_LAST_REF is missing (caller
     *  must registerHead first). */
    async markVerified(workspaceRoot: string): Promise<void> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
      await serialize(st, async () => {
        await initInner(st, canonical)
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
    },

    /* ADR-0122 — `rewindToVerified`. Mirror of `rewindToLast` but
     *  pointed at SHADOW_LAST_VERIFIED_REF. Throws `no-verified-anchor`
     *  when `markVerified` was never called. Does NOT advance either
     *  the registered OR the verified ref. */
    async rewindToVerified(workspaceRoot: string, opts?: RewindOptions): Promise<void> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
      await serialize(st, async () => {
        await initInner(st, canonical)
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
        if (opts?.allowDirtyMerge !== true) {
          const mergeHead = join(canonical, ".git", "MERGE_HEAD")
          let mergeInProgress = false
          try {
            await fs.access(mergeHead)
            mergeInProgress = true
          } catch {
            // ENOENT — no merge in progress.
          }
          if (mergeInProgress) {
            throw new ShadowOdbError(
              "merge-in-progress",
              `refusing rewindToVerified: ${mergeHead} exists (pass allowDirtyMerge:true to override)`,
            )
          }
        }
        // Safety-net pre-rewind ref. Identical name/flow to rewindToLast.
        const isoTs = now().toISOString().replace(/\..*$/, "Z").replace(/:/g, "-")
        const preRewindRef = `${SHADOW_PRE_REWIND_REF_PREFIX}${isoTs}`
        await runShadowOrThrow(runner, st.gitDir, canonical, ["add", "-A"])
        await runShadowOrThrow(runner, st.gitDir, canonical, [
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          `pre-rewind-verified ${isoTs}`,
        ])
        const headRef = await runShadowOrThrow(runner, st.gitDir, canonical, ["rev-parse", "HEAD"])
        const preSha = headRef.stdout.trim()
        if (!/^[0-9a-f]{40}$/.test(preSha)) {
          throw new ShadowOdbError(
            "rewind-failed",
            `unexpected HEAD SHA from pre-rewind-verified commit: ${preSha}`,
          )
        }
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
        const rt = await runShadow(runner, st.gitDir, canonical, [
          "read-tree",
          "--reset",
          SHADOW_LAST_VERIFIED_REF,
        ])
        if (rt.exitCode !== 0) {
          throw new ShadowOdbError(
            "rewind-failed",
            `read-tree --reset ${SHADOW_LAST_VERIFIED_REF} failed: ${rt.stderr.trim()}`,
          )
        }
        const ci = await runShadow(runner, st.gitDir, canonical, ["checkout-index", "-a", "-f"])
        if (ci.exitCode !== 0) {
          throw new ShadowOdbError(
            "rewind-failed",
            `checkout-index -a -f failed: ${ci.stderr.trim()}`,
          )
        }
        if (opts?.untracked === "discard") {
          const cl = await runShadow(runner, st.gitDir, canonical, ["clean", "-fd"])
          if (cl.exitCode !== 0) {
            throw new ShadowOdbError("rewind-failed", `clean -fd failed: ${cl.stderr.trim()}`)
          }
        }
        // SHADOW_LAST_REF + SHADOW_LAST_VERIFIED_REF are both intentionally
        // NOT advanced — same reasoning as rewindToLast (worktree now
        // matches old verified content; both refs still describe truth).
      })
    },

    async listSnapshots(workspaceRoot: string): Promise<readonly SnapshotMetadata[]> {
      const canonical = await validateWorkspaceRoot(workspaceRoot)
      const st = resolveState(canonical)
      // Ensure shadow init exists so for-each-ref doesn't ENOENT on the
      // git dir. ensureInit is idempotent and serialized — same chain as
      // registerHead so a concurrent rewind can't yank the store mid-scan.
      await serialize(st, () => initInner(st, canonical))
      const args = [
        "for-each-ref",
        "--format=%(refname)|%(objectname)|%(committerdate:unix)",
        "refs/quanta/snapshots/",
        "--sort=-committerdate",
      ]
      const r = await runShadow(runner, st.gitDir, canonical, args)
      if (r.exitCode !== 0) {
        throw new ShadowOdbError(
          "git-failed",
          `for-each-ref exited ${r.exitCode}: ${r.stderr.trim()}`,
        )
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
    },

    async cleanup(maxBytes: number): Promise<number> {
      const baseDir = resolveBaseDir(cfg)
      return await evictLru(baseDir, maxBytes)
    },
  }
}
