/**
 * LEAF — the FULL-REMOTE `expected` instance set.
 *
 * ## Why this is its own module and its own authority order
 *
 * PMX-06 made a family's sample manifest the selection AUTHORITY, but only on
 * the LOCAL path (`filterSwebenchTasks`). `grade --mode full` kept building its
 * expected set the old way: `--instance` if present, else every id in the
 * dataset file. So a remote campaign could name PMX-7 in its provenance and run
 * a completely different set of instances, with no artifact able to contradict
 * it — precisely the failure the manifest exists to abolish.
 *
 * The order below is therefore NOT "manifest as a fallback":
 *
 *   1. the family's manifest authority, when the operator named one — its ids,
 *      in its ORDER, each re-checked against the decoded corpus;
 *   2. otherwise the operator's `--instance` list;
 *   3. otherwise every id in the dataset, in dataset order.
 *
 * A manifest AND an `--instance` filter is a REFUSAL, not an intersection
 * (`resolveFamilySelectedInstanceIds` owns that rule, so the local and remote
 * surfaces cannot drift apart on it).
 *
 * BYTE-IDENTICAL for every family with no selection port: the manifest branch is
 * `undefined` and the remaining two steps are exactly what the CLI did inline.
 * An UNREADABLE dataset still yields the `--instance` list rather than throwing,
 * which is the historical behaviour the relaunch reconciler depends on.
 */
import type { DatasetFamily } from "../dataset-family-token"
import { readFamilyCorpusFile } from "../profiles/corpus-read"
import { applySelectionOrder, resolveFamilySelectedInstanceIds } from "../profiles/selection"

export interface FullRemoteExpectedInput {
  readonly datasetPath: string
  /** The RESOLVED family — never a fresh ambient read inside this leaf. */
  readonly family: DatasetFamily
  /** The env the composition root resolved from. */
  readonly env: NodeJS.ProcessEnv
  /** The operator's `--instance` filter, when they passed one. */
  readonly instanceFilter?: string | undefined
  /** Caller label for refusal messages. */
  readonly surface: string
}

/** Split an `--instance` selector exactly as the CLI always has. */
const splitInstanceFilter = (filter: string): string[] =>
  filter
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")

/**
 * The instance set a full-remote launch is accountable for. This is the
 * DENOMINATOR the relaunch reconciler and (PMX-03) the official-grade receipt
 * both measure coverage against, so getting it from the manifest is what makes
 * "this campaign ran PMX-7" checkable rather than asserted.
 */
export const resolveFullRemoteExpectedInstanceIds = (
  input: FullRemoteExpectedInput,
): readonly string[] => {
  // Decoded through the family's ONE reader. `undefined` (unreadable) degrades
  // to an empty row list rather than throwing: the launch path has its own,
  // louder preflight for that, and this function must not change WHEN the
  // operator learns about an unreadable dataset.
  const rows = readFamilyCorpusFile(input.datasetPath, input.family) ?? []
  const selected = resolveFamilySelectedInstanceIds({
    family: input.family,
    rows,
    env: input.env,
    surface: input.surface,
    ...(input.instanceFilter !== undefined ? { instanceFilter: input.instanceFilter } : {}),
  })
  if (selected !== undefined) {
    // Re-check every id against the decoded corpus, in MANIFEST order. A row-map
    // miss would otherwise silently shrink the campaign the manifest names.
    return applySelectionOrder(
      rows.map((r) => ({ instanceId: r.instanceId })),
      selected,
      input.surface,
    ).map((r) => r.instanceId)
  }
  const filter = input.instanceFilter
  if (filter !== undefined && filter !== "") return splitInstanceFilter(filter)
  return rows.map((row) => row.instanceId)
}
