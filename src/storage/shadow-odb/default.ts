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
  SHADOW_LAST_REF,
  type ShadowInitResult,
  type ShadowOdb,
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

/** SHADOW_LAST_REF is the only ref we ever write. We additionally
 *  guard against accidental future code paths that build a ref from
 *  user input: the resolver rejects anything that doesn't match the
 *  hard-coded prefix. */
const assertSafeRef = (ref: string): void => {
  if (ref !== SHADOW_LAST_REF) {
    throw new ShadowOdbError("invalid-ref", `refusing non-canonical ref name: ${ref}`)
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

    async rewindToLast(_workspaceRoot: string): Promise<void> {
      // Intentionally unimplemented — see ADR-0108. Surfacing as
      // `not-implemented` (not generic Error) so callers can branch
      // cleanly when the follow-up ADR ships.
      throw new ShadowOdbError(
        "not-implemented",
        "rewindToLast is not yet implemented — destructive op gated on a follow-up ADR",
      )
    },

    async cleanup(maxBytes: number): Promise<number> {
      const baseDir = resolveBaseDir(cfg)
      return await evictLru(baseDir, maxBytes)
    },
  }
}
