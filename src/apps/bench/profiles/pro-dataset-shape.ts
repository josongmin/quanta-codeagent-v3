/**
 * LEAF — the ScaleAI Pro dataset SHAPE check, owned by the profile layer.
 *
 * aug-22 HIGH-4: this body lived in `remote/box-session/dataset-preflight.ts` (a
 * CONSUMER) behind a `family !== "pro"` early-return (`assertProDatasetGradeable`),
 * and the registry imported it BACK from that consumer. The family gate is now the
 * PRO profile's `preflight` field; the preflight module calls the profile and no
 * longer knows what "pro" means.
 *
 * PMX-02: it no longer OPENS the dataset either — it receives already-decoded
 * rows from the family's own reader. A shape check that re-read the file would be
 * a second parser, and a second parser is how "pro" and "promax" would end up
 * disagreeing about what the corpus contains.
 */
import { RemoteDatasetPreflightError } from "../remote/box-session/dataset-rows"
import type { FamilyCorpusRow } from "./corpus-row"

/** Columns Scale's `swe_bench_pro_eval.py` dereferences in `create_entryscript` (a KeyError on any
 *  absent one ⇒ that instance errors ⇒ `eval_results[id]=False` with NO run-marker ⇒ our verifier
 *  reads it as infra). A trimmed/derived JSONL, or a Verified-shaped file mislabeled
 *  `--dataset-family pro`, would pass the generic launchable check yet burn a box to all-infra. */
const PRO_REQUIRED_COLUMNS = ["before_repo_set_cmd", "selected_test_files_to_run"] as const

const proRowMissingFields = (row: Record<string, unknown>): string[] => {
  const missing: string[] = PRO_REQUIRED_COLUMNS.filter(
    (c) => row[c] === undefined || row[c] === null,
  )
  // LOWERCASE `fail_to_pass` specifically (non-null): Scale's create_entryscript reads
  // `eval(raw_sample["fail_to_pass"])` — lowercase-only, NO uppercase fallback. An uppercase-only
  // FAIL_TO_PASS row would KeyError in Scale, so the uppercase form does NOT satisfy this. (The
  // official Pro JSONL ships lowercase; a null decodes to the no-op grade selection.)
  if (row.fail_to_pass === undefined || row.fail_to_pass === null) missing.push("fail_to_pass")
  return missing
}

/**
 * FAIL-CLOSED Pro-dataset shape check. Refuses LOCALLY (before a box is launched) a
 * dataset whose rows lack the Scale-harness-required columns, rather than discovering
 * it as an all-infra remote slice. Family-agnostic: the caller (the PRO profile's
 * `preflight` field) has already decided this applies.
 */
export const assertProDatasetShape = (args: {
  readonly rows: readonly FamilyCorpusRow[]
  readonly instanceIds?: readonly string[] | undefined
  readonly surface: string
}): void => {
  const rows = args.rows
  // Only validate the OPERATOR-SELECTED rows when an `--instance` filter is provided — an
  // unselected malformed row must not refuse a run that targets a single sound instance. With no
  // filter (`instanceIds` absent/empty) the whole dataset is validated, unchanged.
  const selected =
    args.instanceIds !== undefined && args.instanceIds.length > 0
      ? new Set(args.instanceIds)
      : undefined
  const offenders: string[] = []
  for (const { instanceId, record } of rows) {
    if (selected !== undefined && !selected.has(instanceId)) continue
    const missing = proRowMissingFields(record)
    if (missing.length > 0) offenders.push(`${instanceId} (missing: ${missing.join(", ")})`)
  }
  if (offenders.length === 0) return
  const preview = offenders.slice(0, 5).join("; ")
  const suffix = offenders.length > 5 ? ` (+${offenders.length - 5} more)` : ""
  throw new RemoteDatasetPreflightError(
    `[${args.surface}] dataset-family=pro but ${offenders.length} row(s) lack Scale-harness-required ` +
      `columns (before_repo_set_cmd / selected_test_files_to_run / fail_to_pass): ${preview}${suffix}. ` +
      "Refusing a remote run that would grade as all-infra. Use the official scaleapi Pro JSONL.",
  )
}
