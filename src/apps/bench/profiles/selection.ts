/**
 * The ONE family-aware INSTANCE SELECTION (PMX-06 / aug-22 G4).
 *
 * Mirrors `corpus-read.ts`: every surface that decides WHICH instances a run
 * executes comes through here, and here delegates to
 * {@link DatasetFamilyProfile.resolveSelection}. No consumer names a family, and
 * a family without the port is untouched — `undefined` means "the historical
 * `--instance` behaviour, unchanged", which is what keeps verified/live/pro
 * byte-identical.
 *
 * Why the two-authority case is a REFUSAL rather than an intersection: a sample
 * manifest is a sealed, digest-identified population. Letting `--instance` narrow
 * it would produce a run that reports the manifest's name and digest while having
 * executed a subset of it — precisely the "a campaign silently ran a different
 * set" failure the manifest exists to abolish. Two authorities ⇒ the operator
 * picks one.
 */
import type { DatasetFamily } from "../dataset-family-token"
import type { FamilyCorpusRow } from "./corpus-row"
import { resolveDatasetFamilyProfile } from "./registry"

export class DatasetSelectionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DatasetSelectionConflictError"
  }
}

export interface FamilySelectionArgs {
  readonly family: DatasetFamily
  readonly rows: readonly FamilyCorpusRow[]
  readonly env: NodeJS.ProcessEnv
  readonly surface: string
  /** The operator's `--instance` filter, when they passed one. */
  readonly instanceFilter?: string | undefined
}

/**
 * The ordered instance ids a manifest authority selects, or `undefined` when
 * this family has no selection authority configured.
 *
 * Throws {@link DatasetSelectionConflictError} when BOTH a manifest and an
 * `--instance` filter are present, and whatever the family's port throws when
 * the manifest and the corpus disagree.
 */
export const resolveFamilySelectedInstanceIds = (
  args: FamilySelectionArgs,
): readonly string[] | undefined => {
  const selected = resolveDatasetFamilyProfile(args.family).resolveSelection?.({
    env: args.env,
    rows: args.rows,
    surface: args.surface,
  })
  if (selected === undefined) return undefined
  const filter = args.instanceFilter
  if (filter !== undefined && filter !== "") {
    throw new DatasetSelectionConflictError(
      `[${args.surface}] two instance-selection authorities: a sample manifest selected ` +
        `${selected.length} instance(s) AND --instance="${filter}" was passed. REFUSING — a run ` +
        "that narrows a sealed sample still reports the sample's name and digest, so the two " +
        "cannot be combined. Drop --instance, or drop the manifest.",
    )
  }
  return selected
}

/**
 * Apply a manifest selection to already-decoded rows, in the MANIFEST's order.
 * Total: the family's port has already proven every id is present, and this
 * re-checks rather than trusting it (a row map miss would otherwise silently
 * shrink the run).
 */
export const applySelectionOrder = <T extends { readonly instanceId: string }>(
  rows: readonly T[],
  ids: readonly string[],
  surface: string,
): T[] => {
  const byId = new Map(rows.map((row) => [row.instanceId, row]))
  return ids.map((id) => {
    const row = byId.get(id)
    if (row === undefined) {
      throw new DatasetSelectionConflictError(
        `[${surface}] selected instance "${id}" is not among the loaded runnable rows. ` +
          "REFUSING a run that silently drops part of the sample it names.",
      )
    }
    return row
  })
}
