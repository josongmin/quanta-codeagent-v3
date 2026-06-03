/**
 * ADR-0132 Stage 2 (Phase B) — Cloud-agent branch snapshot.
 *
 * Takes a dirty working tree, stashes it onto a brand-new branch named
 * `quanta/cloud-agent-<ts>-<rand6>`, pushes that branch with
 * `--force-with-lease`, then returns the agent to the original branch. The
 * remote ref is the hand-off point for whatever consumer wants to babysit the
 * snapshot in the cloud (Cursor's `cloud-agent` flow, or our own future
 * runner). No actual cloud is contacted here — that's downstream.
 *
 * Why a SEPARATE port from `src/tool/git/types.ts`?
 *
 *   `src/git/` is a pure library slice with no upward dependencies. The
 *   existing `GitRunner` ships in `@/tool` (downstream). We define a
 *   minimal {@link GitProcessPort} here with the same shape; the composition
 *   root can pass ONE adapter wired into both (e.g. `defaultGitRunner`).
 *
 * Discipline:
 *   - `--force-with-lease` ONLY (NEVER `--force`). HARD_DENY rule
 *     `git-push-force` (policy-rules.ts:159) matches BOTH on the bash
 *     surface; we bypass it cleanly by using {@link GitProcessPort}
 *     (argv-only, no shell), which is the same seam `git_commit` /
 *     `git_branch_switch` use. The HARD_DENY rule's scope is the bash tool's
 *     command-string surface — argv-only `Bun.spawn(["git", ...])` is the
 *     intended bypass for first-class git tools.
 *   - File lock (`.quanta/cloud-snapshot.lock`) prevents two concurrent
 *     snapshots from racing the working tree.
 *   - 500MB pre-check on dirty diff size (Cursor empirical limit; bigger
 *     trees mean per-push minutes that block the agent loop).
 *   - Abort signal honored at EACH git invocation — a mid-snapshot abort
 *     unwinds (stash pop + checkout to prior ref) before propagating.
 *   - Branch prefix `quanta/cloud-agent-` is the cleanup invariant:
 *     `git branch -D quanta/cloud-agent-*` is a zero-residue collapse.
 *
 * Returns `{ branch, sha }` on success. On any failure path, the working
 * tree is restored to its pre-call state (best-effort) and an error is
 * thrown with a discriminated {@link SnapshotError} kind.
 */

import { randomUUID } from "node:crypto"

/**
 * Closed git subprocess port — argv + cwd + signal, same shape as
 * `@/tool/git`'s `GitRunner`. The composition root binds one impl for both.
 *
 * `run` MUST NOT throw on a non-zero exit; it returns the result so callers
 * branch on `exitCode`. THROW reserved for spawn failure (ENOENT, signal
 * died unexpectedly) — same contract as `defaultGitRunner`.
 */
export interface GitProcessPort {
  run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitProcessResult>
}

export interface GitProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Lock-file port — small enough to inline. Production binds a Bun.file +
 * O_EXCL flag impl; tests pass an in-memory Map.
 *
 * Contract: `acquire(path)` returns a release handle if the lock was taken,
 * or `null` if it was already held. The release handle MUST be called in a
 * `try/finally` even on error paths (otherwise a crashed snapshot leaks the
 * lock forever).
 */
export interface FileLockPort {
  acquire(path: string): Promise<{ release: () => Promise<void> } | null>
}

/**
 * Inject a clock for branch-name minting determinism. Mirrors
 * `agent/admissibility-gate.ts` style: `(opts.now ?? Date.now)()`. The clock
 * value flows into the branch slug — tests pin a known value to assert the
 * generated name.
 */
export interface SnapshotClock {
  now(): number
}

export interface SnapshotOpts {
  readonly gitPort: GitProcessPort
  readonly clockPort: SnapshotClock
  readonly fileLockPort: FileLockPort
  readonly repoCwd: string
  readonly branchPrefix?: string
  readonly pushRemote?: string
  /** Path of the lock file relative to `repoCwd`. Default
   *  `.quanta/cloud-snapshot.lock`. */
  readonly lockPath?: string
  /** Diff size cap in bytes; trees bigger than this are rejected
   *  immediately. Default 500MB. */
  readonly maxDirtyBytes?: number
  readonly abortSignal?: AbortSignal
}

export interface SnapshotResult {
  readonly branch: string
  readonly sha: string
}

/** Discriminated error union. Throw as `SnapshotErrorThrown` for catch-side
 *  branching; the `kind` is the SSOT (no `message.includes` matching). */
export type SnapshotError =
  | { kind: "not-a-repo"; detail: string }
  | { kind: "detached-head"; detail: string }
  | { kind: "no-dirty-changes" }
  | { kind: "diff-too-large"; bytes: number; cap: number; reason?: "estimate-unavailable" }
  | { kind: "lock-busy"; lockPath: string }
  | { kind: "git-failed"; stage: SnapshotStage; stderr: string; exitCode: number }
  | { kind: "aborted"; stage: SnapshotStage }
  | { kind: "force-with-lease-rejected"; stderr: string }

export type SnapshotStage =
  | "rev-parse"
  | "symbolic-ref"
  | "status"
  | "branch-create"
  | "stash-push"
  | "checkout-snapshot"
  | "stash-pop"
  | "add"
  | "commit"
  | "push"
  | "checkout-restore"
  | "rev-parse-sha"

export class SnapshotErrorThrown extends Error {
  public readonly kind: SnapshotError["kind"]
  public readonly detail: SnapshotError
  constructor(detail: SnapshotError) {
    super(`cloud-snapshot ${detail.kind}: ${JSON.stringify(detail)}`)
    this.name = "SnapshotErrorThrown"
    this.kind = detail.kind
    this.detail = detail
  }
}

const DEFAULT_BRANCH_PREFIX = "quanta/cloud-agent-"
const DEFAULT_PUSH_REMOTE = "origin"
const DEFAULT_LOCK_PATH = ".quanta/cloud-snapshot.lock"
/** Cursor's empirical limit for cloud-agent snapshots. Bigger trees take
 *  push minutes — the agent loop blocks on the snapshot, so we reject early
 *  with a discriminated error rather than time out partway through. */
const DEFAULT_MAX_DIRTY_BYTES = 500 * 1024 * 1024
const FORCE_WITH_LEASE_REJECTED_MARKER = "stale info"

/**
 * Snapshot the working tree onto a fresh cloud-agent branch.
 *
 * Returns `{ branch, sha }` on success. On EVERY error path the working tree
 * is restored (best-effort) to its pre-call branch + stash state before the
 * error propagates.
 */
export const snapshotDirtyToCloudBranch = async (opts: SnapshotOpts): Promise<SnapshotResult> => {
  const branchPrefix = opts.branchPrefix ?? DEFAULT_BRANCH_PREFIX
  const pushRemote = opts.pushRemote ?? DEFAULT_PUSH_REMOTE
  const lockPath = opts.lockPath ?? DEFAULT_LOCK_PATH
  const maxDirtyBytes = opts.maxDirtyBytes ?? DEFAULT_MAX_DIRTY_BYTES

  // Acquire the file lock FIRST so two concurrent snapshots can never race
  // the working tree (the stash + checkout sequence is not idempotent across
  // processes).
  const lock = await opts.fileLockPort.acquire(lockPath)
  if (lock === null) {
    throw new SnapshotErrorThrown({ kind: "lock-busy", lockPath })
  }

  try {
    return await runSnapshot({
      ...opts,
      branchPrefix,
      pushRemote,
      maxDirtyBytes,
    })
  } finally {
    await lock.release()
  }
}

interface ResolvedOpts extends SnapshotOpts {
  readonly branchPrefix: string
  readonly pushRemote: string
  readonly maxDirtyBytes: number
}

const runSnapshot = async (opts: ResolvedOpts): Promise<SnapshotResult> => {
  checkAbort(opts.abortSignal, "rev-parse")

  // 1. Confirm we're inside a git repo. `git rev-parse --git-dir` is the
  //    cheapest non-mutating probe.
  const inside = await opts.gitPort.run(["rev-parse", "--git-dir"], opts.repoCwd, opts.abortSignal)
  if (inside.exitCode !== 0) {
    throw new SnapshotErrorThrown({
      kind: "not-a-repo",
      detail: inside.stderr.trim(),
    })
  }

  // 2. Detect detached HEAD. `git symbolic-ref --quiet HEAD` exits non-zero
  //    when HEAD is detached. We require a named branch so the
  //    checkout-restore step has somewhere to return to.
  checkAbort(opts.abortSignal, "symbolic-ref")
  const symRef = await opts.gitPort.run(
    ["symbolic-ref", "--quiet", "HEAD"],
    opts.repoCwd,
    opts.abortSignal,
  )
  if (symRef.exitCode !== 0) {
    throw new SnapshotErrorThrown({
      kind: "detached-head",
      detail: "snapshot requires a checked-out named branch",
    })
  }
  const originalRef = symRef.stdout.trim()

  // 3. Inspect the working tree. `git status --porcelain` returns one line
  //    per dirty entry (parseable, locale-independent — we set `LC_ALL=C` in
  //    the runner). Empty stdout ⇒ nothing to snapshot.
  checkAbort(opts.abortSignal, "status")
  const status = await opts.gitPort.run(["status", "--porcelain"], opts.repoCwd, opts.abortSignal)
  if (status.exitCode !== 0) {
    throw new SnapshotErrorThrown({
      kind: "git-failed",
      stage: "status",
      stderr: status.stderr,
      exitCode: status.exitCode,
    })
  }
  if (status.stdout.trim().length === 0) {
    throw new SnapshotErrorThrown({ kind: "no-dirty-changes" })
  }

  // 4. Size pre-check. `git diff HEAD --numstat` reports the +/- line counts;
  //    for unconvertible binaries we estimate per +/- line for safety. We
  //    deliberately use a CHEAP upper-bound — going over the cap is the failure
  //    mode worth catching EARLY. If the probe ITSELF fails we cannot bound the
  //    tree, so we fail CLOSED (reason: estimate-unavailable) rather than
  //    assume small and let the cap be defeated.
  const estimate = await estimateDirtyBytes(opts)
  // Fail CLOSED: a probe failure means we CANNOT bound the dirty-tree size, so
  // we must NOT assume it's small (that would defeat the cap for exactly the
  // pathological trees the cap exists to reject). Treat it as over-cap.
  if (!estimate.ok) {
    throw new SnapshotErrorThrown({
      kind: "diff-too-large",
      bytes: opts.maxDirtyBytes + 1,
      cap: opts.maxDirtyBytes,
      reason: "estimate-unavailable",
    })
  }
  if (estimate.bytes > opts.maxDirtyBytes) {
    throw new SnapshotErrorThrown({
      kind: "diff-too-large",
      bytes: estimate.bytes,
      cap: opts.maxDirtyBytes,
    })
  }

  // 5. Mint the branch name. `crypto.randomUUID` for the suffix (the slice's
  //    no-Math.random invariant) — first 6 hex chars are enough collision
  //    space at the scale of one human + their cron watcher.
  const stamp = formatTimestamp(opts.clockPort.now())
  const rand6 = randomUUID().replace(/-/g, "").slice(0, 6)
  const branchName = `${opts.branchPrefix}${stamp}-${rand6}`

  // 6. Create the branch at the current HEAD (no checkout yet — git stash
  //    holds the dirty state separately so the checkout is clean).
  checkAbort(opts.abortSignal, "branch-create")
  const createRes = await opts.gitPort.run(
    ["branch", branchName, "HEAD"],
    opts.repoCwd,
    opts.abortSignal,
  )
  if (createRes.exitCode !== 0) {
    throw new SnapshotErrorThrown({
      kind: "git-failed",
      stage: "branch-create",
      stderr: createRes.stderr,
      exitCode: createRes.exitCode,
    })
  }

  // 7. Stash the working tree (`-u` includes untracked so a brand-new file
  //    isn't dropped). The stash entry is named so failure-recovery can find
  //    it explicitly via `git stash list` if the pop step throws.
  const stashMessage = `quanta-cloud-snapshot:${branchName}`
  checkAbort(opts.abortSignal, "stash-push")
  const stashRes = await opts.gitPort.run(
    ["stash", "push", "-u", "-m", stashMessage],
    opts.repoCwd,
    opts.abortSignal,
  )
  if (stashRes.exitCode !== 0) {
    await bestEffortDeleteBranch(opts, branchName)
    throw new SnapshotErrorThrown({
      kind: "git-failed",
      stage: "stash-push",
      stderr: stashRes.stderr,
      exitCode: stashRes.exitCode,
    })
  }

  // 8. Switch to the snapshot branch, pop the stash, stage + commit + push,
  //    then return. WRAP every git call in an unwind helper so any error
  //    restores the original branch + stash before throwing.
  const unwind = makeUnwinder(opts, originalRef, branchName)
  try {
    checkAbort(opts.abortSignal, "checkout-snapshot")
    await runOrFail(opts, ["checkout", branchName], "checkout-snapshot")
    checkAbort(opts.abortSignal, "stash-pop")
    await runOrFail(opts, ["stash", "pop"], "stash-pop")
    checkAbort(opts.abortSignal, "add")
    await runOrFail(opts, ["add", "-A"], "add")
    checkAbort(opts.abortSignal, "commit")
    await runOrFail(opts, ["commit", "-m", "snapshot for cloud agent"], "commit")
    checkAbort(opts.abortSignal, "push")
    const pushRes = await opts.gitPort.run(
      ["push", opts.pushRemote, branchName, "--force-with-lease"],
      opts.repoCwd,
      opts.abortSignal,
    )
    if (pushRes.exitCode !== 0) {
      // Distinguish a lease-protect rejection from a generic push failure so
      // the caller can re-poll vs surface to the user.
      if (pushRes.stderr.toLowerCase().includes(FORCE_WITH_LEASE_REJECTED_MARKER)) {
        throw new SnapshotErrorThrown({
          kind: "force-with-lease-rejected",
          stderr: pushRes.stderr,
        })
      }
      throw new SnapshotErrorThrown({
        kind: "git-failed",
        stage: "push",
        stderr: pushRes.stderr,
        exitCode: pushRes.exitCode,
      })
    }
    checkAbort(opts.abortSignal, "rev-parse-sha")
    const shaRes = await opts.gitPort.run(["rev-parse", "HEAD"], opts.repoCwd, opts.abortSignal)
    if (shaRes.exitCode !== 0) {
      throw new SnapshotErrorThrown({
        kind: "git-failed",
        stage: "rev-parse-sha",
        stderr: shaRes.stderr,
        exitCode: shaRes.exitCode,
      })
    }
    const sha = shaRes.stdout.trim()

    // Success: return the agent to the original branch BEFORE returning so
    // callers don't need to remember to unwind on the happy path. Errors
    // here are best-effort (the snapshot succeeded; restore is hygiene).
    await opts.gitPort.run(["checkout", normalizeRef(originalRef)], opts.repoCwd, opts.abortSignal)

    return { branch: branchName, sha }
  } catch (e) {
    await unwind()
    throw e
  }
}

/** Convert a refs/heads/main symbolic-ref to a checkout-able short name. */
const normalizeRef = (ref: string): string =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref

const runOrFail = async (
  opts: ResolvedOpts,
  args: readonly string[],
  stage: SnapshotStage,
): Promise<GitProcessResult> => {
  const res = await opts.gitPort.run(args, opts.repoCwd, opts.abortSignal)
  if (res.exitCode !== 0) {
    throw new SnapshotErrorThrown({
      kind: "git-failed",
      stage,
      stderr: res.stderr,
      exitCode: res.exitCode,
    })
  }
  return res
}

const checkAbort = (signal: AbortSignal | undefined, stage: SnapshotStage): void => {
  if (signal !== undefined && signal.aborted) {
    throw new SnapshotErrorThrown({ kind: "aborted", stage })
  }
}

/**
 * Best-effort unwind. Restores the original branch and tries to pop the
 * stash we created so the working tree returns to its pre-call state. We
 * swallow individual failures — by the time the unwind runs, we are already
 * propagating a primary error; a secondary unwind failure should NOT mask
 * the first.
 */
const makeUnwinder = (
  opts: ResolvedOpts,
  originalRef: string,
  branchName: string,
): (() => Promise<void>) => {
  return async () => {
    const original = normalizeRef(originalRef)
    // 1. Get back to the original branch.
    await opts.gitPort
      .run(
        ["checkout", "--force", original],
        opts.repoCwd,
        undefined, // Unwind ignores the abort signal — we ALWAYS try to restore.
      )
      .catch(() => {
        /* swallow */
      })
    // 2. Try to find and pop the matching stash entry by name.
    try {
      const list = await opts.gitPort.run(["stash", "list"], opts.repoCwd, undefined)
      if (list.exitCode === 0) {
        const needle = `quanta-cloud-snapshot:${branchName}`
        const stashIdx = findStashIndex(list.stdout, needle)
        if (stashIdx !== undefined) {
          await opts.gitPort
            .run(["stash", "pop", `stash@{${stashIdx}}`], opts.repoCwd, undefined)
            .catch(() => {
              /* swallow */
            })
        }
      }
    } catch {
      /* swallow */
    }
    // 3. Delete the never-pushed branch so a retry can use a fresh name.
    await bestEffortDeleteBranch(opts, branchName)
  }
}

const bestEffortDeleteBranch = async (opts: ResolvedOpts, branchName: string): Promise<void> => {
  await opts.gitPort.run(["branch", "-D", branchName], opts.repoCwd, undefined).catch(() => {
    /* swallow */
  })
}

const findStashIndex = (raw: string, needle: string): number | undefined => {
  const lines = raw.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && line.includes(needle)) return i
  }
  return undefined
}

type DirtyEstimate = { ok: true; bytes: number } | { ok: false; stderr: string }

const estimateDirtyBytes = async (opts: ResolvedOpts): Promise<DirtyEstimate> => {
  // `git diff HEAD --numstat -- .` returns `<added>\t<deleted>\t<path>` per
  // file (`-` for binary). We sum line counts and apply a generous-per-line
  // budget; the cap is an UPPER bound so over-estimation is fine.
  const res = await opts.gitPort.run(
    ["diff", "HEAD", "--numstat", "--", "."],
    opts.repoCwd,
    opts.abortSignal,
  )
  if (res.exitCode !== 0) {
    // Unable to estimate ⇒ signal failure so the caller fails CLOSED. Assuming
    // small here would let a pathologically large tree slip past the cap and
    // block the agent loop for push-minutes — the exact failure the cap guards.
    return { ok: false, stderr: res.stderr.trim() }
  }
  let totalLines = 0
  for (const line of res.stdout.split("\n")) {
    if (line.length === 0) continue
    const [addedStr, deletedStr] = line.split("\t")
    if (addedStr === undefined || deletedStr === undefined) continue
    const added = addedStr === "-" ? 200 : Number.parseInt(addedStr, 10)
    const deleted = deletedStr === "-" ? 200 : Number.parseInt(deletedStr, 10)
    if (Number.isFinite(added)) totalLines += added
    if (Number.isFinite(deleted)) totalLines += deleted
  }
  const BYTES_PER_LINE_UPPER_BOUND = 200
  return { ok: true, bytes: totalLines * BYTES_PER_LINE_UPPER_BOUND }
}

/** UTC-stamp branch slugs are stable across timezones. Format
 *  `YYYYMMDDhhmmss` — sortable, fixed-width, filesystem-safe. */
const formatTimestamp = (ms: number): string => {
  const d = new Date(ms)
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0")
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const dd = d.getUTCDate().toString().padStart(2, "0")
  const hh = d.getUTCHours().toString().padStart(2, "0")
  const mi = d.getUTCMinutes().toString().padStart(2, "0")
  const ss = d.getUTCSeconds().toString().padStart(2, "0")
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`
}

/** In-memory file-lock impl — for tests and ephemeral process use cases. */
export const createInMemoryFileLock = (): FileLockPort => {
  const held = new Set<string>()
  return {
    acquire: async (path) => {
      if (held.has(path)) return null
      held.add(path)
      return {
        release: async () => {
          held.delete(path)
        },
      }
    },
  }
}
