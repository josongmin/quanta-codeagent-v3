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
 *    `registerHead`.
 *
 *  Implementation note: the path/git-invocation helpers live in
 *  `./default-helpers` and the per-method operation bodies live in
 *  `./default/ops` — both take the factory's closed-over collaborators
 *  (`runner`, `now`, `cfg`, `states`) as explicit params so the factory
 *  body below stays a thin set of delegations. */

import { defaultGitRunner, type GitRunner } from "../git-runner"
import { evictLru } from "./cleanup"
import {
  type OdbDeps,
  opDiffSinceLast,
  opDiffWorkspaceSinceLast,
  opInit,
  opListSnapshots,
  opMarkVerified,
  opRegisterHead,
  opRestorePartial,
  opRewindToLast,
  opRewindToVerified,
  type WorkspaceState,
} from "./default/ops"
import { resolveBaseDir } from "./default-helpers"
import type {
  RewindOptions,
  ShadowInitResult,
  ShadowOdb,
  ShadowOdbConfig,
  SnapshotMetadata,
} from "./types"

/** Build a `ShadowOdb` from optional collaborators. */
export const defaultShadowOdb = (cfg: ShadowOdbConfig = {}): ShadowOdb => {
  const runner: GitRunner = cfg.runner ?? defaultGitRunner
  const now = cfg.now ?? ((): Date => new Date())

  /** Per-workspaceHash state. We resolve `shadowDir` lazily inside
   *  `init` so a `cleanup` call doesn't require any prior `init`. */
  const states = new Map<string, WorkspaceState>()

  const deps: OdbDeps = { runner, now, cfg, states }

  return {
    init: (workspaceRoot: string): Promise<ShadowInitResult> => opInit(deps, workspaceRoot),

    registerHead: (workspaceRoot: string): Promise<string> => opRegisterHead(deps, workspaceRoot),

    diffSinceLast: (workspaceRoot: string): Promise<string> => opDiffSinceLast(deps, workspaceRoot),

    diffWorkspaceSinceLast: (
      anchorWorkspace: string,
      comparisonWorkspace: string,
    ): Promise<string> => opDiffWorkspaceSinceLast(deps, anchorWorkspace, comparisonWorkspace),

    rewindToLast: (workspaceRoot: string, opts?: RewindOptions): Promise<void> =>
      opRewindToLast(deps, workspaceRoot, opts),

    restorePartial: (
      workspaceRoot: string,
      paths: ReadonlyArray<string>,
      opts?: RewindOptions,
    ): Promise<void> => opRestorePartial(deps, workspaceRoot, paths, opts),

    markVerified: (workspaceRoot: string): Promise<void> => opMarkVerified(deps, workspaceRoot),

    rewindToVerified: (workspaceRoot: string, opts?: RewindOptions): Promise<void> =>
      opRewindToVerified(deps, workspaceRoot, opts),

    listSnapshots: (workspaceRoot: string): Promise<readonly SnapshotMetadata[]> =>
      opListSnapshots(deps, workspaceRoot),

    async cleanup(maxBytes: number): Promise<number> {
      const baseDir = resolveBaseDir(cfg)
      return await evictLru(baseDir, maxBytes)
    },
  }
}
