/**
 * TB21-04 — the pinned Terminal-Bench 2.1 dataset identity.
 *
 * Every constant here is copied from an authority, never chosen:
 *
 *   DATASET / DATASET_REF        harbor-framework/terminal-bench-2-1
 *                                @7131e4375048a0e408a8fb404b5f499d726b695b
 *                                leaderboard/src/leaderboard/core/hub.py
 *   EXPECTED_TASK_COUNT (89)     leaderboard/src/leaderboard/ci/static_analysis.py
 *   MIN_TRIALS_PER_TASK (5)      leaderboard/src/leaderboard/ci/static_analysis.py
 *
 * The per-task digests in `terminal-bench-2-1-tasks.json` are the canonical task
 * versions of that dataset ref, fetched from the Harbor package registry with
 * upstream's own query (`hub.dataset_task_digests`, i.e.
 * `PackageDatasetClient().get_dataset_metadata("<DATASET>@<DATASET_REF>")`) and
 * checked in so admission is offline and reproducible. They are NOT derived from
 * a directory listing or a task name — the digest IS the task version upstream
 * checks each trial against.
 */
import TASK_DIGESTS from "./terminal-bench-2-1-tasks.json" with { type: "json" }

/** The dataset every official 2.1 trial must have run. */
export const TERMINAL_BENCH_DATASET = "terminal-bench/terminal-bench-2-1"

/** The sha256 of the canonical dataset version. Identity is never inferred. */
export const TERMINAL_BENCH_DATASET_REF =
  "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"

/** Upstream `static_analysis.EXPECTED_TASK_COUNT`. */
export const EXPECTED_TASK_COUNT = 89

/** Upstream `static_analysis.MIN_TRIALS_PER_TASK`. */
export const MIN_TRIALS_PER_TASK = 5

const DIGESTS: Readonly<Record<string, string>> = TASK_DIGESTS as Readonly<Record<string, string>>

/** `org/name` ids of the 89 canonical tasks, in stable sorted order. */
export const CANONICAL_TASK_IDS: readonly string[] = Object.keys(DIGESTS).sort()

/** The canonical `sha256:` version of a task, or `undefined` when the task is
 *  not part of the pinned dataset (an unknown task, never a tolerated one). */
export const canonicalTaskRef = (taskId: string): string | undefined => DIGESTS[taskId]

/** Whether a task id belongs to the pinned dataset. */
export const isCanonicalTask = (taskId: string): boolean => taskId in DIGESTS

/**
 * Fail-closed drift guard: the checked-in manifest must still describe the
 * dataset the rest of this module claims. A manifest that silently loses or
 * gains a task would move every completeness verdict without a single test
 * changing, so this runs at module load.
 */
if (CANONICAL_TASK_IDS.length !== EXPECTED_TASK_COUNT) {
  throw new Error(
    `terminal-bench-2-1-tasks.json holds ${CANONICAL_TASK_IDS.length} tasks but ` +
      `${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF} has ${EXPECTED_TASK_COUNT}`,
  )
}
for (const [taskId, ref] of Object.entries(DIGESTS)) {
  if (!ref.startsWith("sha256:")) {
    throw new Error(`terminal-bench-2-1-tasks.json: ${taskId} has a non-digest ref ${ref}`)
  }
}
