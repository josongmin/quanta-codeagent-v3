/**
 * LEAF — the OFFICIAL SWE-bench JSONL corpus reader (verified / live / pro).
 *
 * This is the historical format: one JSON object per line. Two behaviors that
 * look like sloppiness are load-bearing and are preserved EXACTLY:
 *
 *  1. Row-level tolerance. A blank or unparseable line is skipped, never thrown
 *     on. Operators hand-edit chunk files; a stray line must not kill a campaign.
 *  2. TWO levels of strictness over the same line. A row keyed only by `id`, or
 *     missing `problem_statement`, is still a ROW (the remote preflight and the
 *     selection check have always counted it, and refusing it here would start
 *     rejecting datasets that run today) but it is NOT a runnable TASK. That is
 *     why `task` is optional rather than the row being dropped.
 *
 * Row coercion itself is delegated to `parseSwebenchJsonl` — the ONE owner of
 * "which upstream fields make a SwebenchTask" — applied per line. Re-deriving
 * that here is exactly how the third parser got out of sync in the first place.
 */
import { parseSwebenchJsonl, toInstance } from "@/runner/batch/corpus/dataset"
import { errMessage, logger } from "@/shared"
import type { FamilyCorpusReader, FamilyCorpusRow } from "./corpus-row"

/** Identity as the dataset layer has always resolved it: the official
 *  `instance_id`, falling back to a custom `id`. */
const datasetTaskIdOf = (row: Record<string, unknown>): string | undefined => {
  const official = row.instance_id
  if (typeof official === "string" && official !== "") return official
  const custom = row.id
  return typeof custom === "string" && custom !== "" ? custom : undefined
}

/** One JSONL line → a row, or `undefined` when the line carries no identity.
 *  Tolerant by design (see the module doc); never throws. */
const rowFromLine = (
  trimmed: string,
  normalize: (raw: Record<string, unknown>) => Record<string, unknown>,
): FamilyCorpusRow | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    // Skipping stays the behavior (module doc #1: a stray line must not kill a
    // campaign) — but the SKIP itself is now attributed. A dropped line is a
    // dropped INSTANCE, and until now a hand-edited chunk file just quietly ran
    // fewer tasks with no signal anywhere that the corpus lost rows.
    logger.warn(`jsonl-corpus.rowFromLine: skipped malformed line: ${errMessage(e)}`)
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const instanceId = datasetTaskIdOf(record)
  if (instanceId === undefined) return undefined
  // The ONE row-coercion owner, on this one line. Yields 0 or 1 task.
  const task = parseSwebenchJsonl(trimmed, normalize)[0]
  return {
    instanceId,
    record,
    // VERBATIM — a slice of a JSONL corpus stays byte-identical to its source, so
    // no rewriting can inject or drop anything.
    sourceLine: trimmed,
    ...(task !== undefined
      ? { task: { checkout: task, toInstance: (repoPath) => toInstance(task, repoPath) } }
      : {}),
  }
}

/**
 * Build a JSONL reader for a family, given its per-row normalizer (Pro maps its
 * lowercase `fail_to_pass` onto the official uppercase keys; verified/live use
 * the identity).
 */
export const jsonlFamilyCorpusReader =
  (normalize: (raw: Record<string, unknown>) => Record<string, unknown>): FamilyCorpusReader =>
  (text: string): readonly FamilyCorpusRow[] => {
    const out: FamilyCorpusRow[] = []
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "") continue
      const row = rowFromLine(trimmed, normalize)
      if (row !== undefined) out.push(row)
    }
    return out
  }

/** The identity-normalizer JSONL reader (verified / live). */
export const officialJsonlCorpusReader: FamilyCorpusReader = jsonlFamilyCorpusReader((r) => r)
