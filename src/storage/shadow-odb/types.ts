/** Shadow git ODB — closed-port contract (ADR-0108).
 *
 *  We absorb Cursor's `gix-snapshot` shadow-ODB pattern: a *separate* git
 *  directory under `~/.quanta/snapshots/<workspace-hash>/` that records
 *  point-in-time snapshots of the user workspace WITHOUT ever touching
 *  the user's own `.git`. The pivot is `GIT_DIR` + `GIT_WORK_TREE`
 *  environment override: a single `git` invocation can be re-pointed at
 *  our shadow store while still reading/writing the user's working tree.
 *
 *  This port is **closed** — every collaborator (filesystem, runner,
 *  base dir, clock) is injectable so tests can drive the full state
 *  machine without a real `~/.quanta` and without a real `git` binary
 *  in adversarial paths (HELL-10). The default factory wires real
 *  implementations.
 *
 *  Default-OFF: the port is registered/instantiated by callers
 *  explicitly. Nothing in this slice mutates the user's repo or
 *  consumes disk unless the caller invokes `init`/`registerHead`. */

import type { GitRunner } from "@/tool/git"

/** Result of `init` — exposed so callers can log the resolved shadow dir. */
export interface ShadowInitResult {
  /** Absolute path to the shadow `.git`-bearing directory (one per workspace). */
  shadowDir: string
  /** 16-hex SHA-256 prefix of the workspace absolute path. */
  workspaceHash: string
}

export interface ShadowOdb {
  /** Initialize (idempotent) the shadow store for `workspaceRoot`.
   *
   *  - Rejects relative paths (HELL-9).
   *  - Rejects paths whose components contain symlinks (HELL-8) — we
   *    must not silently follow a link that retargets `GIT_WORK_TREE`
   *    to a directory the user didn't expect to be snapshotted.
   *  - Idempotent: calling twice with the same workspace returns the
   *    same `shadowDir` and never re-`git init`s an already-init'd store
   *    (HELL-1).
   *  - On first init we create the shadow dir with `git init` (non-bare
   *    so that `GIT_WORK_TREE` overrides cleanly). We deliberately do
   *    NOT create an initial commit; the first `registerHead` does. */
  init(workspaceRoot: string): Promise<ShadowInitResult>

  /** Record the current workspace state as a new commit in the shadow
   *  store and advance the `quanta/snapshots/last-registered` ref to it.
   *
   *  Returns the new commit SHA. Concurrent invocations against the
   *  same workspace are serialized inside the implementation so the ref
   *  update is well-ordered (HELL-11). */
  registerHead(workspaceRoot: string): Promise<string>

  /** Unified diff between `quanta/snapshots/last-registered` and the
   *  current working tree. Empty string when nothing changed (HELL-7).
   *  Throws if `init`/`registerHead` was never called for this workspace. */
  diffSinceLast(workspaceRoot: string): Promise<string>

  /** Unified diff between `quanta/snapshots/last-registered` (anchored on
   *  `anchorWorkspace`) and the working tree at `comparisonWorkspace` —
   *  i.e. compare a CANDIDATE workspace against the snapshot we captured
   *  on a DIFFERENT workspace. Empty string when there is no divergence.
   *  Throws `ShadowOdbError("uninitialized")` when `registerHead` was
   *  never called for `anchorWorkspace`.
   *
   *  Both paths obey the same path-safety invariants as `init` /
   *  `registerHead` (absolute + non-symlink-leaf). Implementation
   *  re-points `--work-tree=<comparisonWorkspace>` at the candidate
   *  while keeping `--git-dir=<shadowDir>/.git` on the anchor's shadow
   *  store. Used by ADR-0116 branch-search delta measurement. */
  diffWorkspaceSinceLast(anchorWorkspace: string, comparisonWorkspace: string): Promise<string>

  /** Restore tracked files in `workspaceRoot` to the state captured by the
   *  last `registerHead` call.
   *
   *  SAFETY NET: BEFORE the destructive checkout, this method captures the
   *  CURRENT worktree state to a brand-new ref under
   *  `SHADOW_PRE_REWIND_REF_PREFIX` with a UTC-ISO-second timestamp suffix.
   *  Recovery is then: `git --git-dir=<shadow>/.git checkout-index -a -f`
   *  against that ref. The pre-rewind ref is NEVER overwritten — successive
   *  rewinds add new refs.
   *
   *  Semantics:
   *    - Tracked file MODIFIED since snapshot → restored to snapshot content.
   *    - File DELETED from worktree since snapshot → re-created.
   *    - File ADDED to worktree since snapshot (= untracked from shadow's
   *      POV) → policy per `opts.untracked` (preserve default).
   *    - `<workspace>/.git/MERGE_HEAD` exists → throws "merge-in-progress"
   *      unless `opts.allowDirtyMerge === true`.
   *    - SHADOW_LAST_REF missing → throws "uninitialized".
   *    - Workspace must be absolute + non-symlink-leaf (same as init/
   *      registerHead).
   *
   *  Concurrent calls against the same workspace are serialized by the same
   *  per-workspace lock that protects `registerHead` (the lock is shared so
   *  registerHead can't race with rewindToLast). */
  rewindToLast(workspaceRoot: string, opts?: RewindOptions): Promise<void>

  /** Enumerate ALL refs under `refs/quanta/snapshots/` for this workspace's
   *  shadow store. Returns newest-first by committer date. Empty array when
   *  no refs exist (init never called, or store deleted). */
  listSnapshots(workspaceRoot: string): Promise<readonly SnapshotMetadata[]>

  /** Best-effort LRU eviction across all per-workspace shadow dirs.
   *
   *  Walks `<baseDir>/snapshots/*`, sums `du`-style sizes, and removes
   *  oldest (by mtime) directories until the total is under
   *  `maxBytes`. Returns the number of workspace shadow stores
   *  evicted. Never touches anything outside `<baseDir>/snapshots/`. */
  cleanup(maxBytes: number): Promise<number>
}

/** Constructor seam for the default implementation. Every collaborator
 *  is optional so production code wires nothing; tests inject fakes. */
export interface ShadowOdbConfig {
  /** Override the base directory (default: `~/.quanta`). Tests point at
   *  a tmpdir so per-test state is isolated. */
  baseDir?: string
  /** Inject a git runner. Default: `defaultGitRunner`. Tests can pass
   *  a fake to assert env / argv without spawning real `git`, or to
   *  simulate spawn-error (HELL-10). */
  runner?: GitRunner
  /** Inject a monotonic clock; used for commit timestamps and LRU mtime
   *  tie-breaks. Default: `() => new Date()`. */
  now?: () => Date
}

/** Discriminated error returned by collaborator failures (spawn / FS /
 *  ref-name validation). We *throw* a `ShadowOdbError` so callers get
 *  a typed surface without losing the stack — null-collapse is
 *  forbidden (HELL-10). */
export class ShadowOdbError extends Error {
  readonly code: ShadowOdbErrorCode
  constructor(code: ShadowOdbErrorCode, message: string) {
    super(message)
    this.name = "ShadowOdbError"
    this.code = code
  }
}

export type ShadowOdbErrorCode =
  | "relative-path"
  | "symlink-in-path"
  | "spawn-failed"
  | "git-failed"
  | "uninitialized"
  | "invalid-ref"
  | "not-implemented"
  | "nested-shadow"
  | "merge-in-progress"
  | "rewind-failed"

/** Canonical ref name used to advance the snapshot pointer. Hard-coded
 *  so tests + audits can grep for it and so a malicious caller cannot
 *  pass an arbitrary ref name through the public API (HELL-14). */
export const SHADOW_LAST_REF = "refs/quanta/snapshots/last-registered" as const

/** Canonical prefix for safety-net refs created right before `rewindToLast`
 *  performs its destructive checkout. Each rewind appends a UTC-ISO-second
 *  timestamp suffix (with `:` replaced by `-` because git refuses colons
 *  in ref names) so successive rewinds NEVER overwrite each other's
 *  recovery point — `git for-each-ref` can list them all. Example:
 *  `refs/quanta/snapshots/pre-rewind-2026-05-24T03-14-15Z`.
 *  Hard-coded for the same reason `SHADOW_LAST_REF` is hard-coded
 *  (path traversal / ref injection defense). */
export const SHADOW_PRE_REWIND_REF_PREFIX = "refs/quanta/snapshots/pre-rewind-" as const

/** Options for `rewindToLast`. All fields optional; absent uses safest default. */
export interface RewindOptions {
  /** Treatment of files that exist in the worktree but NOT in the snapshot.
   *  - `"preserve"` (default): leave untracked files alone — safest.
   *  - `"discard"`: `git clean -fd` after the checkout to fully match snapshot. */
  readonly untracked?: "preserve" | "discard"
  /** When `true`, proceed even if `<workspace>/.git/MERGE_HEAD` exists.
   *  Default `false` — a half-finished merge is almost always something the
   *  user wants to resolve, not blow away. */
  readonly allowDirtyMerge?: boolean
}

/** One snapshot ref's metadata. Sorted newest-first by `listSnapshots`. */
export interface SnapshotMetadata {
  /** Full ref name, e.g. `refs/quanta/snapshots/last-registered` or
   *  `refs/quanta/snapshots/pre-rewind-2026-05-24T03-14-15Z`. */
  readonly ref: string
  /** 40-hex commit sha the ref points at. */
  readonly sha: string
  /** Unix epoch seconds — git's committerdate:unix for the ref's target. */
  readonly timestampSec: number
}

/** Default cap for `cleanup`. 1 GiB — large enough for hundreds of
 *  workspace snapshots, small enough that an idle laptop reclaims
 *  space within a session. Overridable via `QUANTA_SHADOW_ODB_MAX_BYTES`. */
export const DEFAULT_SHADOW_ODB_MAX_BYTES = 1024 * 1024 * 1024
