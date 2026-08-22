/**
 * TB21-04 — Harbor raw-result discovery. FILESYSTEM ONLY.
 *
 * This module locates trial records and reads their bytes. It classifies
 * nothing, scores nothing, and decides nothing: parsing, taxonomy, admission and
 * scoring live in `report.ts` / `scoring.ts` as pure functions over what this
 * returns. Keeping the split hard is what lets every scoring rail run on
 * in-memory fixtures instead of a temp tree.
 *
 * The on-disk layout is harbor's, not ours (harbor 0.21.0, pinned in
 * `adapters/terminal-bench/uv.lock`):
 *
 *   job_dir/
 *     <trial_name>/
 *       result.json          # TrialResult, written by harbor/trial/trial.py:419
 *                            #   self.paths.result_path.write_text(...)
 *                            #   result_path = trial_dir / "result.json"
 *                            #     (harbor/models/trial/paths.py:270)
 *       config.json          # TrialConfig
 *       agent/trajectory.json  # the ATIF trajectory (agent logs_dir)
 *       verifier/reward.json
 *
 * `result.json` is the scoring authority: it carries the trial UUID, the task id
 * AND its canonical `sha256:` ref, the verifier rewards, the exception, the
 * timings, the agent telemetry and the trial's own resolved config. Nothing here
 * infers a trial id, a reward or a task version from a directory name — the stop
 * rule in the ticket forbids exactly that, and it is unnecessary.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { errMessage, logger } from "@/shared"

/** One trial directory's raw bytes plus the filesystem facts a pure parser
 *  cannot know. `raw` is `undefined` exactly when the record could not be read
 *  or parsed — never a placeholder object. */
export interface HarborTrialFile {
  /** Absolute path of the `result.json` that was read (or attempted). */
  readonly sourcePath: string
  readonly jobDir: string
  readonly trialDir: string
  readonly trialDirName: string
  /** The parsed `result.json`, or `undefined` when unreadable/unparseable. */
  readonly raw: unknown
  /** Why `raw` is missing. Present only on failure. */
  readonly readError?: string
  /** Absolute path of the ATIF trajectory, when the agent actually wrote one. */
  readonly trajectoryPath?: string
}

const RESULT_FILENAME = "result.json"
const CONFIG_FILENAME = "config.json"
/** `quanta_terminal_atif.ATIF_FILENAME`, written into harbor's agent logs dir. */
const ATIF_FILENAME = "trajectory.json"

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch (e) {
    // `false` stays the answer, but this predicate gates the WHOLE results scan
    // (`scanHarborJobDir` returns `[]` when the job dir fails it), so an
    // unreadable job directory used to be reported as "this run produced no
    // trials" — a fs fault wearing a legitimate result's clothes.
    logger.warn(`harbor-results.isDirectory: ${path}: ${errMessage(e)}`)
    return false
  }
}

const readTrial = (jobDir: string, trialDirName: string): HarborTrialFile | undefined => {
  const trialDir = join(jobDir, trialDirName)
  const sourcePath = join(trialDir, RESULT_FILENAME)
  const hasResult = existsSync(sourcePath)
  // A directory with a config but no result is a trial that never produced one:
  // real evidence of an incomplete run, so it is surfaced rather than skipped.
  if (!hasResult && !existsSync(join(trialDir, CONFIG_FILENAME))) return undefined

  const trajectory = join(trialDir, "agent", ATIF_FILENAME)
  const base = {
    sourcePath,
    jobDir,
    trialDir,
    trialDirName,
    ...(existsSync(trajectory) ? { trajectoryPath: trajectory } : {}),
  }
  if (!hasResult) {
    return { ...base, raw: undefined, readError: `no ${RESULT_FILENAME} in ${trialDir}` }
  }
  let text: string
  try {
    text = readFileSync(sourcePath, "utf8")
  } catch (error) {
    return { ...base, raw: undefined, readError: `unreadable: ${errMessage(error)}` }
  }
  if (text.trim() === "") {
    return { ...base, raw: undefined, readError: `empty ${RESULT_FILENAME}` }
  }
  try {
    return { ...base, raw: JSON.parse(text) as unknown }
  } catch (error) {
    return { ...base, raw: undefined, readError: `unparseable JSON: ${errMessage(error)}` }
  }
}

/** Every trial record under one Harbor job directory, in stable directory order. */
export const scanHarborJobDir = (jobDir: string): readonly HarborTrialFile[] => {
  if (!isDirectory(jobDir)) return []
  const out: HarborTrialFile[] = []
  for (const entry of readdirSync(jobDir).sort()) {
    if (!isDirectory(join(jobDir, entry))) continue
    const file = readTrial(jobDir, entry)
    if (file !== undefined) out.push(file)
  }
  return out
}

/** Every trial record under several job directories, job order preserved. */
export const scanHarborJobDirs = (jobDirs: readonly string[]): readonly HarborTrialFile[] =>
  jobDirs.flatMap((dir) => scanHarborJobDir(dir))
