/**
 * LEAF — the ONE shape a dataset row takes after a family has decoded it.
 *
 * ## Why a family-owned reader at all
 *
 * Before PMX-02 there were three independent parsers of the same dataset file:
 * `parseSwebenchJsonl` (the run path), `readParsedDatasetRows` (the remote
 * preflight/selection path), and `planMicrochunks`' own line splitter (the pool
 * chunking path). They agreed only because all three happened to assume "one
 * JSON object per line". A family whose corpus is an official JSON ARRAY breaks
 * that assumption, and the failure mode is the worst kind: two of the three
 * silently see ZERO rows, so a run reports "nothing to do" or ships an empty
 * chunk instead of refusing.
 *
 * This type is what makes ONE reader serve all three consumers without any of
 * them losing behavior:
 *
 *  - `record`      — the row AS IT APPEARS IN THE FILE. Preflight and per-family
 *                    shape checks inspect this, which is why it must NOT be a
 *                    projection: the ProMax gold-leak check exists precisely to
 *                    notice `patch` in a chunk that should not have one.
 *  - `sourceLine`  — the bytes a chunk slice re-serializes. For JSONL families it
 *                    is the VERBATIM source line (so a slice is byte-identical to
 *                    its source, as before); for a family whose corpus ships gold
 *                    inline it is the PUBLIC projection, so a slice cannot carry
 *                    gold even if the source did.
 *  - `task`        — present only when the row forms a runnable task. Rows that
 *                    do not are still VISIBLE as rows, which preserves the
 *                    deliberately-permissive preflight reader's behavior (it
 *                    accepted rows keyed only by `id`, with no problem statement).
 *
 * The `task` half is a CLOSURE rather than a data field on purpose: it is the
 * only thing that reaches the agent side, and a closure lets each family decide
 * what it closes over. The historical families close over the whole upstream row
 * (unchanged); ProMax closes over its narrow public view, so gold has no route
 * to `Instance` at all rather than a route that is merely unused.
 */
import type { Instance } from "@/apps/bench/types"
import type { RepoCheckoutSpec } from "@/runner/batch/corpus/public-task"

export interface FamilyCorpusTask {
  /** Exactly what repository preparation needs — never a row object. */
  readonly checkout: RepoCheckoutSpec
  /** Build the runner Instance once the checkout exists. */
  readonly toInstance: (repoPath: string) => Instance
}

export interface FamilyCorpusRow {
  readonly instanceId: string
  /** The row as it appears in the dataset file. NOT a projection — see above. */
  readonly record: Record<string, unknown>
  /** One JSON line representing this row, for chunk slicing. */
  readonly sourceLine: string
  /** Present only when the row forms a runnable task. */
  readonly task?: FamilyCorpusTask
  /**
   * The row's PUBLIC upstream language label, when its family publishes one.
   *
   * aug-22 G3. The strict-LSP-grounding preflight used to identify a task's
   * language from the GOLD PATCH's diff headers. For a family that ships gold
   * inline that is forbidden (PMX-02: nothing derived from the gold patch may
   * choose localization files, LSP targets, prompts or tools), and for a
   * CORRECTLY-projected row it does not even work — there is no gold to read, so
   * every task grounded as "unknown language" and the lane could not launch.
   *
   * A family sets this ONLY from a field it publishes to the agent side. Absent
   * ⇒ the historical diff-header derivation, so verified/live/pro are
   * byte-identical: they publish no language, and a JSONL family cannot acquire
   * one by accident because only its own reader can populate this field.
   */
  readonly publicLanguage?: string
}

/** A family's dataset FORMAT reader: file text → ordered rows. */
export type FamilyCorpusReader = (text: string) => readonly FamilyCorpusRow[]

/** The rows that form runnable tasks, in dataset order. */
export const runnableTasksOf = (
  rows: readonly FamilyCorpusRow[],
): readonly (FamilyCorpusRow & { readonly task: FamilyCorpusTask })[] =>
  rows.filter(
    (row): row is FamilyCorpusRow & { readonly task: FamilyCorpusTask } => row.task !== undefined,
  )
