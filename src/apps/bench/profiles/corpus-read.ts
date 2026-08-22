/**
 * The ONE family-aware dataset READ.
 *
 * Every surface that needs the rows of a dataset file — local run, local
 * dry-run, full-remote preflight, pool preflight, pool chunk slicing, instance-id
 * enumeration for relaunch reconciliation and box tags — comes through here, and
 * here delegates to {@link DatasetFamilyProfile.readCorpus}. That is what makes
 * "no bypass parser" a checkable claim: substitute one family's `readCorpus` with
 * a failing fake and every one of those surfaces fails, before any repository is
 * prepared and before any box is provisioned.
 *
 * The file/format split is deliberate:
 *  - {@link readFamilyCorpusText} is PURE (text in, rows out) so it is trivially
 *    testable and so the format decision lives entirely in the profile;
 *  - the two file-reading wrappers own only the "can I open this?" question, and
 *    they keep the historical distinction between `undefined` (unreadable) and
 *    `[]` (readable but empty), which callers already branch on.
 */
import { readFileSync } from "node:fs"
import type { DatasetFamily } from "../dataset-family-token"
import { RemoteDatasetPreflightError } from "../remote/box-session/dataset-rows"
import type { FamilyCorpusRow } from "./corpus-row"
import { resolveDatasetFamilyProfile } from "./registry"

/** Decode dataset TEXT through the family's ONE reader. Pure. */
export const readFamilyCorpusText = (
  text: string,
  family: DatasetFamily,
): readonly FamilyCorpusRow[] => resolveDatasetFamilyProfile(family).readCorpus(text)

/** Read + decode a dataset FILE. `undefined` when the file cannot be read at all
 *  (matching the historical reader, whose callers treat that as "unknown" rather
 *  than "empty"). Row-level malformation is the reader's business, not this
 *  function's. */
export const readFamilyCorpusFile = (
  path: string,
  family: DatasetFamily,
): readonly FamilyCorpusRow[] | undefined => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  return readFamilyCorpusText(text, family)
}

/**
 * Read + decode a dataset FILE, refusing loudly. Used everywhere a run is about
 * to spend something (a box, a clone, an LLM call) on the strength of a dataset
 * that turned out to be unreadable or empty.
 */
export const loadFamilyCorpusRowsOrThrow = (args: {
  readonly datasetPath: string
  readonly surface: string
  readonly family: DatasetFamily
}): readonly FamilyCorpusRow[] => {
  const rows = readFamilyCorpusFile(args.datasetPath, args.family)
  if (rows === undefined) {
    throw new RemoteDatasetPreflightError(
      `[${args.surface}] local dataset ${args.datasetPath} could not be read before launch. Refusing to spend a remote box on an unreadable dataset.`,
    )
  }
  if (rows.length === 0) {
    throw new RemoteDatasetPreflightError(
      `[${args.surface}] local dataset ${args.datasetPath} contains no parseable task rows. Refusing a remote empty-dataset run.`,
    )
  }
  return rows
}

/** Every instance id in a dataset file, in dataset order, decoded through the
 *  family's reader. Best-effort: an unreadable file ⇒ `[]`. */
export const readFamilyDatasetInstanceIds = (
  path: string,
  family: DatasetFamily,
): readonly string[] => (readFamilyCorpusFile(path, family) ?? []).map((row) => row.instanceId)
