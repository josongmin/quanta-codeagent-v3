/**
 * GOAL-03 — the objective VERIFIER runtime (host adapter over the objective
 * slice's ports).
 *
 *   - {@link createObjectiveCheckRunner}: runs an IMMUTABLE stored check's exact
 *     argv through the shared argv core (`runArgv`: scrubbed env, per-call wrap,
 *     installed sandbox slot, bounded kill/timeout). Raw output never leaves
 *     this module — digest + byte length only.
 *   - {@link createWorkspaceEvidence}: the versioned canonical source digest
 *     (Git: HEAD + tracked/untracked non-ignored paths + mode/kind/target/content
 *     digest/length; non-Git: a bounded directory manifest with explicit ignore
 *     rules). Overflow is `cap-exceeded`, an unreadable tree `source-unavailable`.
 *   - {@link createObjectiveVerificationCoordinator}: `verify` runs the checks
 *     between two evidence captures and commits ONE batch only when the digest
 *     was stable; `reconcile` invalidates receipts whose digest no longer matches
 *     the live tree (cheap precheck first, full manifest only on change).
 *
 * Posture (README 결정 기록): workspace-write + digest invariance. A check may
 * write caches inside the workspace; if the canonical manifest changes, the run
 * yields ZERO receipts and `stale-source`. The authority recomputes `passed`;
 * this module never asserts a verdict.
 */

import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { createObjectiveJudgeObserver } from "@/agent/tier1/objective-judge-observer"
import type { AgentConfig } from "@/agent/types"
import {
  type CheckRunInput,
  type CheckRunResult,
  createObjectiveCapabilities,
  isEvidenceFailure,
  MAX_BATCH_DEADLINE_MS,
  MAX_CHECK_TIMEOUT_MS,
  MAX_CHECKS_PER_BATCH,
  type Objective,
  type ObjectiveCheckRunner,
  type ObjectiveCommands,
  type ObjectivePort,
  type ObjectiveReadPort,
  type ObjectiveVerificationPort,
  type ReconcileOutcome,
  type VerificationBatchResult,
  type VerificationOutcome,
  type VerifierObjectiveMutation,
  type WorkspaceEvidence,
  type WorkspaceEvidenceFailure,
  type WorkspaceEvidencePort,
} from "@/objective"
import { type RunArgvOptions, runArgv } from "@/runtime/run-argv"
import { errMessage, logger } from "@/shared"

const sha256 = (input: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`

// ─────────────────────────────────────────────────────────────────────────────
// Check runner
// ─────────────────────────────────────────────────────────────────────────────

export interface ObjectiveCheckRunnerOptions {
  readonly perCallWrap?: RunArgvOptions["perCallWrap"]
  readonly spawner?: RunArgvOptions["spawner"]
  readonly localEnv?: RunArgvOptions["localEnv"]
}

/** The production runner: exact argv, session cwd, scrubbed env, bounded time. */
export const createObjectiveCheckRunner = (
  options: ObjectiveCheckRunnerOptions = {},
): ObjectiveCheckRunner => ({
  async run(input: CheckRunInput): Promise<CheckRunResult> {
    const res = await runArgv([...input.argv], {
      cwd: input.cwd,
      timeoutMs: Math.min(
        Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? input.timeoutMs
          : MAX_CHECK_TIMEOUT_MS,
        MAX_CHECK_TIMEOUT_MS,
      ),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(options.perCallWrap !== undefined ? { perCallWrap: options.perCallWrap } : {}),
      ...(options.spawner !== undefined ? { spawner: options.spawner } : {}),
      ...(options.localEnv !== undefined ? { localEnv: options.localEnv } : {}),
    })
    return {
      exitCode: res.exitCode,
      timedOut: res.timedOut || res.aborted,
      stdoutDigest: sha256(res.stdout),
      stdoutBytes: res.stdout.byteLength,
      stderrDigest: sha256(res.stderr),
      stderrBytes: res.stderr.byteLength,
      durationMs: res.durationMs,
    }
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Workspace evidence
// ─────────────────────────────────────────────────────────────────────────────

export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly exitCode: number | null; readonly stdout: Uint8Array }>

export interface WorkspaceEvidenceOptions {
  readonly git?: GitRunner
  /** Hard caps — overflow is `cap-exceeded`, never a partial digest. */
  readonly maxFiles?: number
  readonly maxBytes?: number
  /** Non-Git ignore rules (path segments). */
  readonly ignore?: readonly string[]
  readonly now?: () => number
}

const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_IGNORE: readonly string[] = [".git", "node_modules", ".cache", "dist", "target"]
const MANIFEST_VERSION = "quanta-workspace-manifest-v1"
const PRECHECK_VERSION = "quanta-workspace-precheck-v1"

const defaultGit: GitRunner = async (args, cwd) => {
  const res = await runArgv(["git", ...args], { cwd, timeoutMs: 60_000 })
  return { exitCode: res.exitCode, stdout: res.stdout }
}

const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes)

const field = (hash: ReturnType<typeof createHash>, value: string | Uint8Array): void => {
  hash.update(`${typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength}:`)
  hash.update(value)
  hash.update("|")
}

const unavailable = (reason: string): WorkspaceEvidenceFailure => ({
  kind: "source-unavailable",
  reason,
})
const capExceeded = (reason: string): WorkspaceEvidenceFailure => ({ kind: "cap-exceeded", reason })

/** Hash one path entry (mode / kind / symlink target / content digest / length). */
const hashEntry = async (
  hash: ReturnType<typeof createHash>,
  root: string,
  rel: string,
  budget: { files: number; bytes: number; maxFiles: number; maxBytes: number },
): Promise<WorkspaceEvidenceFailure | null> => {
  const abs = join(root, rel)
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(abs)
  } catch (e) {
    logger.warn(`objective.evidence.lstat ${rel}: ${errMessage(e)}`)
    // Listed by git but gone from disk (a deletion in the working tree): the
    // absence itself is part of the state.
    field(hash, rel)
    field(hash, "missing")
    return null
  }
  budget.files += 1
  if (budget.files > budget.maxFiles) return capExceeded(`more than ${budget.maxFiles} files`)
  field(hash, rel)
  field(hash, String(st.mode & 0o777777))
  if (st.isSymbolicLink()) {
    field(hash, "symlink")
    field(hash, await readlink(abs))
    return null
  }
  if (st.isDirectory()) {
    field(hash, "dir")
    return null
  }
  field(hash, "file")
  budget.bytes += st.size
  if (budget.bytes > budget.maxBytes) return capExceeded(`more than ${budget.maxBytes} bytes`)
  const content = await readFile(abs)
  field(hash, sha256(content))
  field(hash, String(content.byteLength))
  return null
}

const digestPaths = async (
  root: string,
  head: string,
  paths: readonly string[],
  opts: { maxFiles: number; maxBytes: number },
  now: () => number,
): Promise<WorkspaceEvidence | WorkspaceEvidenceFailure> => {
  const hash = createHash("sha256")
  field(hash, MANIFEST_VERSION)
  field(hash, head)
  const budget = { files: 0, bytes: 0, maxFiles: opts.maxFiles, maxBytes: opts.maxBytes }
  const sorted = [...new Set(paths)].sort()
  for (const rel of sorted) {
    const failure = await hashEntry(hash, root, rel, budget)
    if (failure !== null) return failure
  }
  return {
    sourceDigest: `${MANIFEST_VERSION}:${hash.digest("hex")}`,
    precheck: "",
    capturedAt: now(),
    fileCount: budget.files,
  }
}

const walkDirectory = async (
  root: string,
  ignore: ReadonlySet<string>,
  maxFiles: number,
): Promise<string[] | WorkspaceEvidenceFailure> => {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (e) {
      return unavailable(`readdir ${relative(root, dir) || "."}: ${errMessage(e)}`)
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(abs)
      else out.push(relative(root, abs).split(sep).join("/"))
    }
    if (out.length > maxFiles) return capExceeded(`more than ${maxFiles} files`)
  }
  return out
}

/** Git-aware (falls back to a bounded directory manifest outside a repo). */
export const createWorkspaceEvidence = (
  options: WorkspaceEvidenceOptions = {},
): WorkspaceEvidencePort => {
  const git = options.git ?? defaultGit
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE)
  const now = options.now ?? Date.now

  const headOf = async (cwd: string): Promise<string | null> => {
    try {
      const res = await git(["rev-parse", "--is-inside-work-tree"], cwd)
      if (res.exitCode !== 0 || decode(res.stdout).trim() !== "true") return null
      const head = await git(["rev-parse", "HEAD"], cwd)
      // An unborn branch (no commits yet) is still a repo: HEAD identity is "none".
      return head.exitCode === 0 ? decode(head.stdout).trim() : "no-head"
    } catch (e) {
      logger.warn(`objective.evidence.git: ${errMessage(e)}`)
      return null
    }
  }

  return {
    async precheck(cwd) {
      const head = await headOf(cwd)
      const hash = createHash("sha256")
      field(hash, PRECHECK_VERSION)
      if (head === null) {
        // Non-Git: the precheck IS the full manifest (no cheaper identity exists).
        const full = await this.capture(cwd)
        return isEvidenceFailure(full) ? full : full.sourceDigest
      }
      try {
        const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd)
        if (status.exitCode !== 0) return unavailable("git status failed")
        field(hash, head)
        field(hash, status.stdout)
        return `${PRECHECK_VERSION}:${hash.digest("hex")}`
      } catch (e) {
        return unavailable(errMessage(e))
      }
    },
    async capture(cwd) {
      const head = await headOf(cwd)
      if (head === null) {
        const paths = await walkDirectory(cwd, ignore, maxFiles)
        if (!Array.isArray(paths)) return paths
        return digestPaths(cwd, "non-git", paths, { maxFiles, maxBytes }, now)
      }
      try {
        const ls = await git(["ls-files", "-co", "--exclude-standard", "-z"], cwd)
        if (ls.exitCode !== 0) return unavailable("git ls-files failed")
        const paths = decode(ls.stdout)
          .split("\0")
          .filter((p) => p.length > 0)
        if (paths.length > maxFiles) return capExceeded(`more than ${maxFiles} files`)
        return digestPaths(cwd, head, paths, { maxFiles, maxBytes }, now)
      } catch (e) {
        return unavailable(errMessage(e))
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinator
// ─────────────────────────────────────────────────────────────────────────────

export type ObjectiveVerificationCoordinator = ObjectiveVerificationPort

export interface CoordinatorDeps {
  readonly read: ObjectiveReadPort
  readonly verifier: ObjectiveCommands<VerifierObjectiveMutation>
  readonly runner: ObjectiveCheckRunner
  readonly evidence: WorkspaceEvidencePort
  readonly workspaceCwd: string
  readonly now?: () => number
}

type CheckedCriterion = Extract<Objective["successCriteria"][number], { kind: "checked" }>

const failureOutcome = (
  f: WorkspaceEvidenceFailure,
): Extract<VerificationOutcome, { kind: "source-unavailable" | "cap-exceeded" }> =>
  f.kind === "cap-exceeded"
    ? { kind: "cap-exceeded", reason: f.reason }
    : { kind: "source-unavailable", reason: f.reason }

const isChecked = (c: Objective["successCriteria"][number]): c is CheckedCriterion =>
  c.kind === "checked"

/** Run the selected checks sequentially under the batch deadline. */
const runChecks = async (
  deps: CoordinatorDeps,
  checked: readonly CheckedCriterion[],
  deadline: number,
  now: () => number,
  signal: AbortSignal | undefined,
): Promise<
  | VerificationBatchResult[]
  | { readonly kind: "cancelled" | "runner-unavailable"; readonly reason: string }
> => {
  const results: VerificationBatchResult[] = []
  for (const c of checked) {
    const remaining = deadline - now()
    if (signal?.aborted === true || remaining <= 0) return { kind: "cancelled", reason: "" }
    let run: CheckRunResult
    try {
      run = await deps.runner.run({
        argv: c.check.argv,
        cwd: deps.workspaceCwd,
        timeoutMs: Math.min(c.check.timeoutMs, remaining),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (e) {
      const reason = errMessage(e)
      logger.warn(`objective.verifier.runner: ${reason}`)
      return { kind: "runner-unavailable", reason }
    }
    results.push({
      criterionId: c.id,
      checkId: c.check.id,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      stdoutDigest: run.stdoutDigest,
      stderrDigest: run.stderrDigest,
    })
  }
  return results
}

/** Commit the batch; a concurrent NON-generation mutation is absorbed by one
 *  bounded reread/retry, a generation change is a typed rejection. */
const commitBatch = (
  deps: CoordinatorDeps,
  threadId: string,
  objectiveId: string,
  checked: readonly CheckedCriterion[],
  sourceDigest: string,
  results: readonly VerificationBatchResult[],
  now: () => number,
): VerificationOutcome => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const live = deps.read.readDomain(threadId)
    if (live.state?.objective.objectiveId !== objectiveId) {
      return { kind: "rejected", reason: "objective-mismatch" }
    }
    const res = deps.verifier.commit(threadId, {
      kind: "applyVerificationBatch",
      batch: {
        objectiveId,
        expectedRevision: live.revision,
        sourceDigest,
        verifiedAt: now(),
        results,
      },
    })
    if (res.ok) {
      const committed = deps.read.get(threadId)?.successCriteria ?? []
      const passed = checked.filter(
        (c) => committed.find((x) => x.id === c.id)?.met === true,
      ).length
      return { kind: "verified", passed, failed: checked.length - passed, revision: res.revision }
    }
    if (res.reason !== "stale") return { kind: "rejected", reason: res.reason }
  }
  return { kind: "freshness-unresolved" }
}

export const createObjectiveVerificationCoordinator = (
  deps: CoordinatorDeps,
): ObjectiveVerificationCoordinator => {
  const now = deps.now ?? Date.now
  let cached: { precheck: string; digest: string } | undefined

  const invalidate = (
    threadId: string,
    objectiveId: string,
    checkIds: readonly string[],
    reason: "stale-source" | "runner-unavailable" | "cancelled",
    observed?: string,
  ): void => {
    if (checkIds.length === 0) return
    deps.verifier.commit(threadId, {
      kind: "invalidateVerification",
      objectiveId,
      checkIds,
      reason,
      ...(observed !== undefined ? { observedSourceDigest: observed } : {}),
    })
  }

  /** Full digest, skipping the manifest rehash when the cheap precheck is unchanged. */
  const currentDigest = async (): Promise<string | WorkspaceEvidenceFailure> => {
    const pre = await deps.evidence.precheck(deps.workspaceCwd)
    if (isEvidenceFailure(pre)) return pre
    if (cached !== undefined && cached.precheck === pre) return cached.digest
    const full = await deps.evidence.capture(deps.workspaceCwd)
    if (isEvidenceFailure(full)) return full
    cached = { precheck: pre, digest: full.sourceDigest }
    return full.sourceDigest
  }

  /** Select the immutable stored checks this run covers. */
  const selectChecks = (
    objective: Objective,
    criterionIds: readonly string[] | undefined,
  ): CheckedCriterion[] | Extract<VerificationOutcome, { kind: "no-checks" | "cap-exceeded" }> => {
    const wanted = criterionIds === undefined ? null : new Set(criterionIds)
    const checked = objective.successCriteria
      .filter(isChecked)
      .filter((c) => wanted === null || wanted.has(c.id))
    if (checked.length === 0) return { kind: "no-checks" }
    if (checked.length > MAX_CHECKS_PER_BATCH) {
      return { kind: "cap-exceeded", reason: `more than ${MAX_CHECKS_PER_BATCH} checks` }
    }
    return checked
  }

  /** After the checks ran: the tree must be byte-identical to the pre-run capture. */
  const settleRun = async (
    threadId: string,
    objective: Objective,
    checked: readonly CheckedCriterion[],
    beforeDigest: string,
    results: readonly VerificationBatchResult[],
  ): Promise<VerificationOutcome> => {
    const after = await deps.evidence.capture(deps.workspaceCwd)
    if (isEvidenceFailure(after)) return failureOutcome(after)
    if (after.sourceDigest !== beforeDigest) {
      invalidate(
        threadId,
        objective.objectiveId,
        checked.map((c) => c.check.id),
        "stale-source",
        after.sourceDigest,
      )
      return { kind: "stale-source" }
    }
    cached = undefined
    return commitBatch(
      deps,
      threadId,
      objective.objectiveId,
      checked,
      after.sourceDigest,
      results,
      now,
    )
  }

  const verify: ObjectiveVerificationPort["verify"] = async (threadId, criterionIds, signal) => {
    const objective = deps.read.readDomain(threadId).state?.objective
    if (objective === undefined) return { kind: "rejected", reason: "objective-missing" }
    const checked = selectChecks(objective, criterionIds)
    if (!Array.isArray(checked)) return checked
    const before = await deps.evidence.capture(deps.workspaceCwd)
    if (isEvidenceFailure(before)) return failureOutcome(before)
    const results = await runChecks(deps, checked, now() + MAX_BATCH_DEADLINE_MS, now, signal)
    if (!Array.isArray(results)) {
      invalidate(
        threadId,
        objective.objectiveId,
        checked.map((c) => c.check.id),
        results.kind,
      )
      return results.kind === "cancelled" ? { kind: "cancelled" } : results
    }
    return settleRun(threadId, objective, checked, before.sourceDigest, results)
  }

  /** Invalidate the named checks (bounded CAS retry). */
  const invalidateStale = (
    threadId: string,
    objectiveId: string,
    checkIds: readonly string[],
    digest: string,
  ): ReconcileOutcome => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = deps.verifier.commit(threadId, {
        kind: "invalidateVerification",
        objectiveId,
        checkIds,
        reason: "stale-source",
        observedSourceDigest: digest,
      })
      if (res.ok || res.reason !== "stale") return { kind: "invalidated", checkIds }
    }
    return { kind: "freshness-unresolved" }
  }

  const reconcile: ObjectiveVerificationPort["reconcile"] = async (threadId) => {
    const objective = deps.read.readDomain(threadId).state?.objective
    if (objective === undefined) return { kind: "no-objective" }
    const verified = objective.successCriteria
      .filter(isChecked)
      .filter((c) => c.met && c.completion?.source === "verifier")
    if (verified.length === 0) return { kind: "fresh", verified: 0 }
    const digest = await currentDigest()
    if (isEvidenceFailure(digest)) {
      return digest.kind === "cap-exceeded"
        ? { kind: "cap-exceeded", reason: digest.reason }
        : { kind: "source-unavailable", reason: digest.reason }
    }
    const stale = verified.filter((c) => c.completion?.sourceDigest !== digest)
    if (stale.length === 0) return { kind: "fresh", verified: verified.length }
    return invalidateStale(
      threadId,
      objective.objectiveId,
      stale.map((c) => c.check.id),
      digest,
    )
  }

  return { verify, reconcile }
}

// ─────────────────────────────────────────────────────────────────────────────
// Host wire (AgentConfig slot)
// ─────────────────────────────────────────────────────────────────────────────

/** Compose the production verifier over the session's objective port + cwd.
 *  Caller-override-safe: a pre-set slot is preserved; no objective ⇒ no wire. */
export const maybeWireObjectiveVerifier = (cfg: {
  objective?: ObjectivePort | undefined
  objectiveVerifier?: ObjectiveVerificationPort | undefined
  cwd?: string | undefined
}): void => {
  if (cfg.objectiveVerifier !== undefined || cfg.objective === undefined) return
  const caps = createObjectiveCapabilities(cfg.objective)
  cfg.objectiveVerifier = createObjectiveVerificationCoordinator({
    read: caps.read,
    verifier: caps.verifier,
    runner: createObjectiveCheckRunner(),
    evidence: createWorkspaceEvidence(),
    workspaceCwd: cfg.cwd ?? process.cwd(),
  })
}

/** GOAL-02 — compose the SHADOW judge observer when `QUANTA_GOAL_JUDGE=shadow`
 *  and an objective authority exists. Telemetry only; GOAL-04 registers it with
 *  the session task lifecycle. Caller-override-safe. */
export const maybeWireObjectiveJudgeObserver = (
  cfg: AgentConfig,
  config: { readonly goalJudgeMode: "off" | "shadow" },
): void => {
  const slot = cfg as AgentConfig & {
    objectiveJudgeObserver?: AgentConfig["objectiveJudgeObserver"]
  }
  if (slot.objectiveJudgeObserver !== undefined) return
  if (config.goalJudgeMode !== "shadow" || cfg.objective === undefined) return
  slot.objectiveJudgeObserver = createObjectiveJudgeObserver({ llm: cfg.llm })
}
