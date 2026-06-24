/** Pure (collaborator-free) helpers for `defaultShadowOdb`.
 *
 *  Extracted verbatim from `default.ts` so the factory body and its
 *  per-method op functions (`default/ops.ts`) can share them without a
 *  circular import. Behavior is byte-identical — these were already
 *  module-level functions in `default.ts`. */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, sep } from "node:path"
import { errMessage } from "@/shared"
import type { GitRunner, GitRunResult } from "../git-runner"
import {
  SHADOW_LAST_REF,
  SHADOW_LAST_VERIFIED_REF,
  type ShadowOdbConfig,
  ShadowOdbError,
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
export const validateWorkspaceRoot = async (workspaceRoot: string): Promise<string> => {
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
    const msg = errMessage(err)
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
    const msg = errMessage(err)
    throw new ShadowOdbError("symlink-in-path", `realpath failed for ${workspaceRoot}: ${msg}`)
  }
}

/* ------------------------------------------------------------------ */
/* base dir                                                            */
/* ------------------------------------------------------------------ */

export const resolveBaseDir = (cfg: ShadowOdbConfig): string => {
  if (typeof cfg.baseDir === "string" && cfg.baseDir.length > 0) {
    return cfg.baseDir
  }
  const home = homedir()
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
export const runShadow = async (
  runner: GitRunner,
  gitDir: string,
  workTree: string,
  rest: readonly string[],
): Promise<GitRunResult> => {
  try {
    return await runner.run(shadowArgs(gitDir, workTree, rest), workTree)
  } catch (err) {
    const msg = errMessage(err)
    throw new ShadowOdbError("spawn-failed", `shadow git ${rest.join(" ")} failed: ${msg}`)
  }
}

/** Same as `runShadow` but treats non-zero exit as a typed error. Used
 *  for operations that MUST succeed (the ref update, the commit). */
export const runShadowOrThrow = async (
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
export const INIT_MARKER = ".quanta-shadow-init"

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
export const ensureNotNested = async (shadowDir: string, workspaceRoot: string): Promise<void> => {
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
export const assertSafeRef = (ref: string): void => {
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
export const assertRepoRelativePaths = (paths: ReadonlyArray<string>): void => {
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
