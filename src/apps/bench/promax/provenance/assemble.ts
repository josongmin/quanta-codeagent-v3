/**
 * PMX-00 — the missing step between FETCH and VERIFY, as a pure plan.
 *
 * PMX-00's fetch writes an upstream tree (`gh/…`, `hf/…`) whose file names are
 * upstream's; `verify-bundle` consumes a bundle whose file names are the
 * bundle's, plus the manifest that lives in git. Bridging the two by hand is the
 * one place a wrong file can enter a directory that then reports VERIFIED.
 *
 * This module does the bridging as bytes-in / plan-out — no filesystem, no
 * network, no clock, matching the rest of `provenance/**`. The caller supplies
 * two ports and WRITES nothing until `ok === true`, so the ordering the ticket
 * needs ("hash before it lands") is structural rather than a convention: a
 * planned file exists only if its bytes already matched the manifest's declared
 * sha256.
 *
 * Three refusals, no guessing:
 *  - a source file that is not there is named, never skipped (silently skipping
 *    an `hf/` copy would also silently disable the verifier's GitHub/HF
 *    cross-source check, turning a weaker bundle into a passing one);
 *  - a source file whose bytes do not hash to the manifest's declared value is
 *    named with both hashes;
 *  - a destination that already holds bytes is refused outright, so an assembly
 *    can never mix a previous bundle's files with this one's.
 *
 * The manifest itself is copied verbatim and is NOT hash-checked here — it is
 * the document declaring the hashes. Its identity is established downstream by
 * `verifyProMaxBundle`, which compares every manifest field against the frozen
 * snapshot recorded in git and refuses an unapproved one.
 */
import { basename, join } from "node:path"
import { errMessage } from "@/shared"
import {
  PROMAX_BUNDLE_FILE_KEYS,
  PROMAX_BUNDLE_FILES,
  type ProMaxBundleFileKey,
} from "./bundle-layout"
import { decodeUtf8, sha256Hex } from "./digest"
import { parseManifest } from "./manifest"
import type { ProMaxManifest } from "./types"

/** Manifest fields naming an upstream path, and the hash declared for each. */
export type ProMaxManifestPathField = "dataset_path" | "eval_path" | "evaluator_path"
export type ProMaxManifestHashField = "dataset_sha256" | "eval_sha256" | "evaluator_sha256"

/** Where one bundle file's bytes come from. */
export interface ProMaxFetchedSource {
  /** subdirectory of the fetched tree: the GitHub copy or the Hugging Face one. */
  readonly dir: "gh" | "hf"
  readonly upstreamPathField: ProMaxManifestPathField
  readonly hashField: ProMaxManifestHashField
}
export type ProMaxBundleSourceSpec = "in-repo-manifest" | ProMaxFetchedSource

/**
 * CLOSED classification: every file the validator reads has exactly one
 * declared source. `satisfies Record<ProMaxBundleFileKey, …>` binds it in BOTH
 * directions — a new bundle file with no source, or a source for a file the
 * layout does not contain, is a COMPILE error.
 *
 * The fetched file NAME is derived from the manifest (`basename` of the
 * upstream path it declares), not hardcoded: the manifest is the authority on
 * which upstream files this bundle is made of, so a re-freeze that moves
 * `data/eval.json` moves the assembler with it instead of silently reading a
 * stale name.
 */
export const PROMAX_BUNDLE_SOURCES = {
  manifest: "in-repo-manifest",
  dataset: { dir: "gh", upstreamPathField: "dataset_path", hashField: "dataset_sha256" },
  evalMeta: { dir: "gh", upstreamPathField: "eval_path", hashField: "eval_sha256" },
  evaluator: { dir: "gh", upstreamPathField: "evaluator_path", hashField: "evaluator_sha256" },
  // The HF copies are checked against the SAME declared hash as the GitHub
  // ones. That is the untracked-hybrid refusal, applied at assembly time.
  hfDataset: { dir: "hf", upstreamPathField: "dataset_path", hashField: "dataset_sha256" },
  hfEvalMeta: { dir: "hf", upstreamPathField: "eval_path", hashField: "eval_sha256" },
} as const satisfies Record<ProMaxBundleFileKey, ProMaxBundleSourceSpec>

/** Closed classification of every way an ASSEMBLY can be refused. */
export type ProMaxAssemblyFailureCode =
  | "manifest_invalid"
  | "source_absent"
  | "source_hash_mismatch"
  | "destination_not_empty"

/** Reason per code. `Record<…>` makes an unclassified code a compile error. */
export const PROMAX_ASSEMBLY_FAILURE_REASONS: Record<ProMaxAssemblyFailureCode, string> = {
  manifest_invalid: "the manifest that declares the hashes is itself not a manifest",
  source_absent: "a file the bundle is made of is not in the fetched upstream tree",
  source_hash_mismatch: "fetched bytes do not hash to the sha256 the manifest declares",
  destination_not_empty: "the destination already holds bytes; assembling would mix two bundles",
}

/** Runtime drift guard companion — the other direction of the same pin. */
export const PROMAX_ASSEMBLY_FAILURE_CODES = Object.keys(
  PROMAX_ASSEMBLY_FAILURE_REASONS,
) as readonly ProMaxAssemblyFailureCode[]

export interface ProMaxAssemblyFailure {
  readonly code: ProMaxAssemblyFailureCode
  readonly message: string
}

/** One file, already proven to match the manifest, waiting to be written. */
export interface ProMaxPlannedFile {
  readonly key: ProMaxBundleFileKey
  /** path relative to the bundle root. */
  readonly destRel: string
  /** path relative to the fetched upstream root, or the manifest's label. */
  readonly source: string
  readonly bytes: Uint8Array
  readonly sha256: string
  /** which manifest field declared `sha256`, or the manifest itself. */
  readonly declaredBy: ProMaxManifestHashField | "manifest-itself"
}

export type ProMaxAssemblyPlan =
  | {
      readonly ok: true
      readonly manifest: ProMaxManifest
      readonly files: readonly ProMaxPlannedFile[]
    }
  | { readonly ok: false; readonly failures: readonly ProMaxAssemblyFailure[] }

/** Effects the planner needs, injected so the module stays pure. */
export interface ProMaxAssemblyPorts {
  /** bytes at `relPath` under the fetched upstream root, or `undefined`. */
  readonly readSource: (relPath: string) => Uint8Array | undefined
  /** entries that already exist under the destination bundle root. */
  readonly listDestination: () => readonly string[]
}

export interface ProMaxAssemblyRequest {
  /** the EXACT bytes of the in-repo manifest; they are copied verbatim. */
  readonly manifestBytes: Uint8Array
  /** human label for the manifest's origin, used in the plan and in output. */
  readonly manifestLabel: string
  readonly ports: ProMaxAssemblyPorts
}

/**
 * Fail-closed drift guard: the source table and the bundle layout must name the
 * same files at RUNTIME too. `satisfies` alone is defeated by the realistic
 * "make it compile" move of widening the annotation to `Record<string, …>`.
 */
export const assertProMaxBundleLayoutInSync = (): void => {
  const layout = [...PROMAX_BUNDLE_FILE_KEYS].sort()
  const sources = Object.keys(PROMAX_BUNDLE_SOURCES).sort()
  const missing = layout.filter((k) => !sources.includes(k))
  const extra = sources.filter((k) => !layout.includes(k as ProMaxBundleFileKey))
  if (missing.length === 0 && extra.length === 0) return
  throw new Error(
    "promax assembly: the bundle layout and the source table have drifted — " +
      `${missing.length > 0 ? `no source declared for [${missing.join(", ")}]; ` : ""}` +
      `${extra.length > 0 ? `source declared for unknown bundle file(s) [${extra.join(", ")}]; ` : ""}` +
      "an assembled bundle would not be the shape the validator reads",
  )
}

/** Plan ONE fetched file: resolve its name from the manifest, read, hash. */
const planFetchedFile = (
  key: ProMaxBundleFileKey,
  spec: ProMaxFetchedSource,
  manifest: ProMaxManifest,
  ports: ProMaxAssemblyPorts,
): ProMaxPlannedFile | ProMaxAssemblyFailure => {
  const sourceRel = join(spec.dir, basename(manifest[spec.upstreamPathField]))
  const bytes = ports.readSource(sourceRel)
  if (bytes === undefined) {
    return {
      code: "source_absent",
      message:
        `${PROMAX_BUNDLE_FILES[key]} is assembled from \`${sourceRel}\` (manifest ` +
        `\`${spec.upstreamPathField}\` = ${manifest[spec.upstreamPathField]}) but that file is ` +
        "not in the fetched upstream tree — REFUSING to assemble a partial bundle, " +
        "which would silently weaken the checks the validator then reports as passing",
    }
  }
  const expected = manifest[spec.hashField].trim().toLowerCase()
  const actual = sha256Hex(bytes)
  if (actual !== expected) {
    return {
      code: "source_hash_mismatch",
      message:
        `${sourceRel} hashes to ${actual} but the manifest declares ` +
        `\`${spec.hashField}\` = ${expected} — REFUSING to copy it into ` +
        `${PROMAX_BUNDLE_FILES[key]}; a bundle cannot be wrong by copy`,
    }
  }
  return {
    key,
    destRel: PROMAX_BUNDLE_FILES[key],
    source: sourceRel,
    bytes,
    sha256: actual,
    declaredBy: spec.hashField,
  }
}

const isFailure = (v: ProMaxPlannedFile | ProMaxAssemblyFailure): v is ProMaxAssemblyFailure =>
  "code" in v

const parseManifestBytes = (
  bytes: Uint8Array,
): { ok: true; manifest: ProMaxManifest } | { ok: false; failures: ProMaxAssemblyFailure[] } => {
  let text: string
  try {
    text = decodeUtf8(bytes)
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          code: "manifest_invalid",
          message: `manifest bytes are not valid UTF-8: ${errMessage(err)}`,
        },
      ],
    }
  }
  const parsed = parseManifest(text)
  if (parsed.ok) return { ok: true, manifest: parsed.manifest }
  return {
    ok: false,
    failures: parsed.failures.map((f) => ({
      code: "manifest_invalid" as const,
      message: `[${f.code}] ${f.message}`,
    })),
  }
}

/**
 * Plan the whole assembly. Returns bytes ONLY when every file was found and
 * every hash matched, so a caller that writes `plan.files` cannot write a file
 * that was never checked.
 */
export const planProMaxBundleAssembly = (req: ProMaxAssemblyRequest): ProMaxAssemblyPlan => {
  assertProMaxBundleLayoutInSync()

  const existing = req.ports.listDestination()
  const destinationFailures: ProMaxAssemblyFailure[] =
    existing.length === 0
      ? []
      : [
          {
            code: "destination_not_empty",
            message:
              `the destination bundle root already holds ${existing.length} entr` +
              `${existing.length === 1 ? "y" : "ies"} (${[...existing].sort().slice(0, 8).join(", ")}` +
              `${existing.length > 8 ? ", …" : ""}) — REFUSING to assemble over it, because the ` +
              "result would mix bytes from two bundles and still look VERIFIED. " +
              "Assemble into a fresh directory, or remove the old one deliberately.",
          },
        ]

  const parsed = parseManifestBytes(req.manifestBytes)
  if (!parsed.ok) return { ok: false, failures: [...parsed.failures, ...destinationFailures] }
  const manifest = parsed.manifest

  const files: ProMaxPlannedFile[] = []
  const failures: ProMaxAssemblyFailure[] = [...destinationFailures]
  for (const key of PROMAX_BUNDLE_FILE_KEYS) {
    const spec: ProMaxBundleSourceSpec = PROMAX_BUNDLE_SOURCES[key]
    if (spec === "in-repo-manifest") {
      files.push({
        key,
        destRel: PROMAX_BUNDLE_FILES[key],
        source: req.manifestLabel,
        bytes: req.manifestBytes,
        sha256: sha256Hex(req.manifestBytes),
        declaredBy: "manifest-itself",
      })
      continue
    }
    const planned = planFetchedFile(key, spec, manifest, req.ports)
    if (isFailure(planned)) failures.push(planned)
    else files.push(planned)
  }

  if (failures.length > 0) return { ok: false, failures }
  return { ok: true, manifest, files }
}
