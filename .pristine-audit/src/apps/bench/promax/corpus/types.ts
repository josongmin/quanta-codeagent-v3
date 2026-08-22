/**
 * PMX-02 — the two ProMax task VIEWS and the two artifacts that carry them.
 *
 * Packet invariant 3: *"Agent-visible data and grader-only data are different
 * TYPES and different storage ROOTS."* This file is the type half. There is
 * deliberately no union, no shared base interface, and no field that appears in
 * both: a function that has a {@link PromaxAgentTaskView} cannot be given a
 * grader view by accident, and neither view can be widened into the other
 * without a compile error at every construction site.
 */

/**
 * AGENT-VISIBLE. Exactly the five fields the ticket names — identity, the repo
 * checkout coordinates, the problem, and the PUBLIC language label used for
 * toolchain preflight.
 *
 * There is no `raw`, no `row`, no `imageName` and no bundle path. That is not
 * minimalism for its own sake: this struct is what a serialized agent artifact
 * consists of, and a closed struct makes "the agent artifact contains no grader
 * material" a property that can be asserted on BYTES rather than argued about.
 */
export interface PromaxAgentTaskView {
  readonly instanceId: string
  readonly repo: string
  readonly baseCommit: string
  readonly problemStatement: string
  readonly language: string
}

/**
 * GRADER-ONLY. Lives in a separate artifact, under a separate root, opened by
 * the harness adapter only AFTER model-patch capture.
 *
 * `workingDir` is preserved RAW because it is upstream metadata a receipt must
 * record, but nothing here may be used to alter pinned evaluator semantics — the
 * upstream evaluator applies patches under its own hard-coded `/testbed`, and
 * "helpfully" honouring a row's `working_dir` would silently fork the grader.
 */
export interface PromaxGraderTaskView {
  readonly instanceId: string
  /** Gold patch. */
  readonly patch: string
  /** Gold test patch. */
  readonly testPatch: string
  /** The pinned evaluator's per-instance script, from `eval.json`. */
  readonly evalScript: string
  readonly imageName: string
  /** RAW upstream value. Recorded, never used to change evaluator behavior. */
  readonly workingDir: string
  readonly environmentSetupCommit: string
}

/**
 * The upstream identity BOTH artifacts are stamped with, so a public artifact
 * and a grader bundle found on different machines can be proven to have been
 * produced from the same verified bytes.
 */
export interface PromaxArtifactSource {
  /** sha256 of the exact PMX-00 manifest bytes the preparation verified. */
  readonly manifestSha256: string
  readonly upstreamGitCommit: string
  readonly hfDatasetRevision: string
  readonly datasetSha256: string
  readonly evalSha256: string
}

/** Shared artifact envelope fields. */
interface PromaxArtifactEnvelope {
  readonly artifactVersion: 1
  readonly source: PromaxArtifactSource
  /** sha256 over the canonical JSON of `tasks` — an integrity seal independent
   *  of pretty-printing, so a hand-edited artifact is refused on read. */
  readonly contentSha256: string
}

export interface PromaxPublicTasksArtifact extends PromaxArtifactEnvelope {
  readonly artifact: "promax-public-tasks"
  readonly tasks: readonly PromaxAgentTaskView[]
}

export interface PromaxGraderBundleArtifact extends PromaxArtifactEnvelope {
  readonly artifact: "promax-grader-bundle"
  readonly tasks: readonly PromaxGraderTaskView[]
}

/** On-disk names. The public file is the ONLY thing the agent runtime opens. */
export const PROMAX_PUBLIC_TASKS_FILE = "public-tasks.json"
export const PROMAX_GRADER_BUNDLE_DIR = "grader-bundle"
export const PROMAX_GRADER_TASKS_FILE = "tasks.json"
