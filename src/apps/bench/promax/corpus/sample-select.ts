/**
 * PMX-06 (aug-22 residual G4) — the sample manifest as a SELECTION AUTHORITY.
 *
 * `tools/bench-promax/prepare-corpus.ts --samples-out` has emitted the
 * `PMX-7 / PMX-14 / PMX-40 / PMX-170` manifests since PMX-02, but nothing ever
 * SELECTED from them: a campaign that claimed "the seven PMX-7 ids" was running
 * whatever `--instance` happened to say, and the manifest was decoration. PMX-06's
 * gates ("run the seven PMX-7 IDs", "add the second deterministic ID per
 * language") are only checkable if the manifest is what decides.
 *
 * This module turns a manifest FILE into an ordered id list, and it is
 * fail-closed on every way the manifest and the corpus can disagree:
 *
 *  1. SELF-DIGEST — the manifest re-hashes to the `sha256` it carries. A
 *     hand-edited id list (the obvious "just add one instance" temptation) is
 *     refused, so the digest printed in a campaign log really identifies the set
 *     that ran.
 *  2. ALGORITHM VERSION — a manifest drawn by a different ordering rule is
 *     refused rather than silently reordered. `algorithm_version` is inside the
 *     hashed tuple, so a v2 draw is a genuinely different sample.
 *  3. DATASET REVISION — the manifest's `datasetRevision` must equal the FROZEN
 *     campaign revision this build grades ProMax against. A manifest drawn from a
 *     different upstream revision names ids from a different corpus; running it
 *     would compare two populations under one label.
 *  4. COVERAGE — every manifest id must exist in the corpus actually loaded, with
 *     no duplicates. A manifest/dataset mismatch fails here even when both are
 *     internally consistent.
 *
 * Ordering is the manifest's own order, verbatim — which is the algorithm's
 * global order — so a regenerated manifest selects a byte-identical sequence.
 *
 * PURE: text in, ids out. The file read lives with the profile port that calls
 * this, so the ordering/quota logic still has exactly ONE implementation
 * (`samples.ts`) shared by the operator tool and the runtime.
 */

import { PROMAX_V1_SNAPSHOT } from "../provenance/frozen-snapshot"
import {
  PROMAX_SAMPLE_ALGORITHM_VERSION,
  ProMaxSampleError,
  type ProMaxSampleManifest,
  proMaxSampleManifestDigest,
} from "./samples"

/** The env knob naming the manifest a run selects from. */
export const PROMAX_SAMPLE_ENV = "QUANTA_PROMAX_SAMPLE"

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const refuse = (surface: string, why: string): never => {
  throw new ProMaxSampleError(`[${surface}] promax sample manifest: ${why}`)
}

const strField = (
  record: Record<string, unknown>,
  key: string,
  surface: string,
  where: string,
): string => {
  const value = record[key]
  if (typeof value !== "string" || value.trim() === "") {
    refuse(surface, `${where} has no usable "${key}" (got ${JSON.stringify(value)}).`)
  }
  return value as string
}

/**
 * Decode + SELF-VERIFY one manifest. Returns the typed manifest, or throws
 * {@link ProMaxSampleError}. The digest check is what makes every later
 * assertion about "the PMX-7 set" mean something.
 */
export const parseProMaxSampleManifest = (args: {
  readonly text: string
  readonly manifestPath: string
  readonly surface: string
}): ProMaxSampleManifest => {
  const { surface } = args
  const where = args.manifestPath
  let parsed: unknown
  try {
    parsed = JSON.parse(args.text)
  } catch (err) {
    refuse(surface, `${where} is not valid JSON (${err instanceof Error ? err.message : err}).`)
  }
  if (!isRecord(parsed)) refuse(surface, `${where} is not a JSON object.`)
  const record = parsed as Record<string, unknown>

  const name = strField(record, "name", surface, where)
  const algorithmVersion = strField(record, "algorithmVersion", surface, where)
  const datasetRevision = strField(record, "datasetRevision", surface, where)
  const seed = strField(record, "seed", surface, where)
  const sha256 = strField(record, "sha256", surface, where)

  const quotas = record.languageQuotas
  if (!isRecord(quotas)) refuse(surface, `${where} has no "languageQuotas" object.`)
  const languageQuotas: Record<string, number> = {}
  for (const [language, count] of Object.entries(quotas as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      refuse(surface, `${where} quota for "${language}" is not a non-negative integer.`)
    }
    languageQuotas[language] = count as number
  }

  const ids = record.instanceIds
  if (!Array.isArray(ids) || ids.length === 0) {
    refuse(surface, `${where} has no non-empty "instanceIds" array.`)
  }
  const instanceIds: string[] = []
  for (const id of ids as unknown[]) {
    if (typeof id !== "string" || id.trim() === "") {
      refuse(surface, `${where} contains a non-string instance id (${JSON.stringify(id)}).`)
    }
    instanceIds.push(id as string)
  }

  const parent = record.parentSubsetSha256
  if (parent !== null && typeof parent !== "string") {
    refuse(surface, `${where} "parentSubsetSha256" must be a string or null.`)
  }
  const parentSubsetSha256 = (parent ?? null) as string | null

  const manifest: ProMaxSampleManifest = {
    name,
    algorithmVersion,
    datasetRevision,
    seed,
    languageQuotas,
    instanceIds,
    parentSubsetSha256,
    sha256,
  }
  // 1 — SELF-DIGEST. Recomputed through the WRITER'S OWN recipe
  // ({@link proMaxSampleManifestDigest}), not a second copy of it, so a manifest
  // can never verify here and fail at the campaign-freeze boundary.
  const recomputed = proMaxSampleManifestDigest(manifest)
  if (recomputed !== sha256) {
    refuse(
      surface,
      `${where} does not match its own sha256 (declared ${sha256}, recomputed ${recomputed}). ` +
        "REFUSING a hand-edited sample manifest — regenerate it with " +
        "`tools/bench-promax/prepare-corpus.ts --samples-out`.",
    )
  }
  return manifest
}

export interface ProMaxSampleSelectionInput {
  readonly manifestText: string
  readonly manifestPath: string
  /** Instance ids the corpus actually decoded to, in dataset order. */
  readonly availableInstanceIds: readonly string[]
  /** The corpus revision this build grades against. Defaults to the frozen pin. */
  readonly datasetRevision?: string
  readonly surface: string
}

/**
 * THE selection authority: the ordered ids a run must execute for this manifest.
 * Throws {@link ProMaxSampleError} on any manifest/dataset disagreement — a
 * campaign must not silently run a different set than the one it names.
 */
export const selectProMaxSampleIds = (input: ProMaxSampleSelectionInput): readonly string[] => {
  const surface = input.surface
  const manifest = parseProMaxSampleManifest({
    text: input.manifestText,
    manifestPath: input.manifestPath,
    surface,
  })

  // 2 — ALGORITHM VERSION.
  if (manifest.algorithmVersion !== PROMAX_SAMPLE_ALGORITHM_VERSION) {
    refuse(
      surface,
      `${manifest.name} was drawn by ordering algorithm "${manifest.algorithmVersion}" but this ` +
        `build implements "${PROMAX_SAMPLE_ALGORITHM_VERSION}". A different algorithm is a ` +
        "different sample — REFUSING to run it under this label.",
    )
  }

  // 3 — DATASET REVISION.
  const expectedRevision = input.datasetRevision ?? PROMAX_V1_SNAPSHOT.hf_dataset_revision
  if (manifest.datasetRevision !== expectedRevision) {
    refuse(
      surface,
      `${manifest.name} was drawn from dataset revision ${manifest.datasetRevision} but this ` +
        `build's frozen ProMax corpus is ${expectedRevision}. The manifest names ids from a ` +
        "DIFFERENT corpus — REFUSING, a campaign that mixes revisions compares two populations " +
        "under one label.",
    )
  }

  // 4 — COVERAGE against the corpus that was actually loaded.
  const seen = new Set<string>()
  for (const id of manifest.instanceIds) {
    if (seen.has(id)) {
      refuse(surface, `${manifest.name} lists instance "${id}" twice — REFUSING a duplicated run.`)
    }
    seen.add(id)
  }
  const available = new Set(input.availableInstanceIds)
  const missing = manifest.instanceIds.filter((id) => !available.has(id))
  if (missing.length > 0) {
    const preview = missing.slice(0, 5).join(", ")
    const suffix = missing.length > 5 ? ` (+${missing.length - 5} more)` : ""
    refuse(
      surface,
      `${manifest.name} names ${missing.length} instance(s) the loaded corpus does not contain: ` +
        `${preview}${suffix}. REFUSING — the manifest and the dataset are not the same corpus.`,
    )
  }
  // The manifest's own order IS the algorithm's global order. Returned verbatim
  // so a regenerated manifest selects a byte-identical sequence.
  return manifest.instanceIds
}
