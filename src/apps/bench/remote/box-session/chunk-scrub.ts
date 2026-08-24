/**
 * LEAF — the per-chunk STALE-ARTIFACT SCRUB, and the drift guard that keeps it
 * exhaustive.
 *
 * ## 🔴 Why this is a classification and not a list (aug-22 A-B)
 *
 * The scrub existed to fail closed on stale box-side artifacts: a warm box, or a
 * box whose previous run crashed, still holds the PREVIOUS chunk's outputs at
 * the same fixed paths, and fetching those after a failure mis-attributes one
 * chunk's results to another. It was written as a hand-maintained array of
 * paths — and it had drifted: it scrubbed preds, report, run.log, run.exit, the
 * closure sidecar, the trajectory cassette and the observe dir, but NOT
 * `paths.dataset`.
 *
 * The dataset is the one that matters most. For ProMax every corpus row carries
 * `patch` and `test_patch` beside its public fields, so a stale on-box dataset
 * is not merely stale — it is ANSWER-KEY BYTES sitting at a fixed path while the
 * next chunk's agent runs with an unsandboxed shell.
 *
 * So the scrub is now derived from {@link CHUNK_PATH_SCRUB_POLICY}, a
 * `Record<keyof ChunkPaths, …>`: every field of {@link ChunkPaths} must be
 * classified, and the union has NO "leave it" member. Adding a path to
 * `ChunkPaths` is therefore a COMPILE error until someone says how the chunk
 * boundary disposes of it — which is the property the old array could not have,
 * since an array can be complete only by memory.
 *
 * ## Ordering: the scrub runs BEFORE the dataset upload
 *
 * It used to run after, which is why the dataset could not simply be added to
 * the list — doing that alone would delete the file the run was about to grade.
 * The caller now scrubs first and uploads second, which is also the coherent
 * order: "clear everything this chunk owns, then place this chunk's input".
 */
import type { ChunkPaths } from "./types"

/**
 * How the chunk boundary disposes of one on-box path.
 *
 * Deliberately WITHOUT an "exempt"/"keep" member: a future field that genuinely
 * must survive a chunk boundary needs a new member, a rationale and a reader —
 * not a silent omission from a list.
 */
export type ChunkPathScrubKind =
  /** `rm -f` — a file this chunk rewrites. */
  | "file"
  /** `rm -f`, but only when the run is recording (the path is not written otherwise). */
  | "file-when-recording"
  /** `rm -rf` then `mkdir -p` — a directory the run expects to exist and own. */
  | "dir-recreate"

/**
 * EVERY {@link ChunkPaths} field, classified. The compiler enforces totality in
 * one direction (`Record<keyof ChunkPaths, …>`); the runtime drift guard in the
 * hellgate enforces the other (no key here that is not a real path).
 *
 * Key ORDER is not semantic — these all land in one `rm -f` — so `dataset` is
 * appended rather than inserted, which keeps the emitted command's historical
 * prefix (`rm -f ~/preds.jsonl …`) that an existing scrub-ordering rail pins.
 */
export const CHUNK_PATH_SCRUB_POLICY: Readonly<Record<keyof ChunkPaths, ChunkPathScrubKind>> = {
  preds: "file",
  report: "file",
  runLog: "file",
  trajectory: "file-when-recording",
  observeDir: "dir-recreate",
  // aug-22 A-B — the omission this module exists to make impossible. Gold-bearing
  // for ProMax, whose rows carry `patch` / `test_patch`.
  dataset: "file",
  // PMX-04 — the grade artifact of a family that grades in its own grader phase.
  // A leftover would be fetched as THIS run's verdicts on a reused box: the
  // evaluator writes it only on success, so a run that dies early would be
  // graded against the previous run's numbers.
  passRate: "file",
  // PMX-04 — the converted predictions a box-grading family hands its evaluator.
  // Scrubbed like every other derived artifact so a leftover cannot be graded as
  // this run's submission.
  boxGradePredictions: "file",
}

/** The bench writes its exit code beside its log. */
export const runExitPathFor = (paths: ChunkPaths): string =>
  paths.runLog.replace(/run\.log$/, "run.exit")

/** The closure-diagnostics sidecar sits beside the report. */
export const closureDiagnosticsPathFor = (paths: ChunkPaths): string =>
  paths.report.replace(/\.json$/, ".closure-diagnostics.json")

/**
 * Per-INSTANCE trajectory directory on the box. The recorder splits each run's
 * localize/repro/repair phases into `<dir>/trajectories/<ts>-<instanceId>.jsonl`
 * (+ `.meta.json` sidecar) — one FILE per instance (SWE-agent shape) — where
 * `<dir>` is the parent of the configured `QUANTA_BENCH_RECORD_TRAJECTORY`
 * cassette path. So the fetchable directory is `dirname(paths.trajectory)/trajectories`.
 */
export const trajectoriesDirFor = (paths: ChunkPaths): string =>
  `${paths.trajectory.replace(/\/[^/]*$/, "")}/trajectories`

/** The on-box paths this chunk scrubs, split by how they are removed. Pure and
 *  exported so the exhaustiveness claim is checkable without a box. */
export const chunkScrubTargets = (
  paths: ChunkPaths,
  recordTrajectory: boolean,
): { readonly files: readonly string[]; readonly dirs: readonly string[] } => {
  const files: string[] = []
  const dirs: string[] = []
  for (const [key, kind] of Object.entries(CHUNK_PATH_SCRUB_POLICY) as ReadonlyArray<
    [keyof ChunkPaths, ChunkPathScrubKind]
  >) {
    const path = paths[key]
    if (kind === "file") files.push(path)
    else if (kind === "file-when-recording") {
      if (recordTrajectory) files.push(path)
    } else dirs.push(path)
  }
  // DERIVED paths — not `ChunkPaths` fields, so not policy-classified, but
  // written by the same chunk and therefore equally stale on reuse.
  files.push(runExitPathFor(paths), closureDiagnosticsPathFor(paths))
  if (recordTrajectory) dirs.push(trajectoriesDirFor(paths))
  return { files, dirs }
}

/**
 * The single remote command the scrub issues. `dir-recreate` paths are removed
 * and recreated; every other directory is removed only (the trajectory dir is
 * recreated by the recorder itself).
 */
export const buildChunkScrubCommand = (paths: ChunkPaths, recordTrajectory: boolean): string => {
  const { files, dirs } = chunkScrubTargets(paths, recordTrajectory)
  const recreated = new Set(
    (Object.keys(CHUNK_PATH_SCRUB_POLICY) as ReadonlyArray<keyof ChunkPaths>)
      .filter((key) => CHUNK_PATH_SCRUB_POLICY[key] === "dir-recreate")
      .map((key) => paths[key]),
  )
  const removals = dirs.map((dir) => `rm -rf ${dir}; `).join("")
  const recreations = [...recreated].map((dir) => `mkdir -p ${dir}`).join("; ")
  return `rm -f ${files.join(" ")}; ${removals}${recreations}`
}
