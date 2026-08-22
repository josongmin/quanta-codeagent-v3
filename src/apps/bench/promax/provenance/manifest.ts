/**
 * PMX-00 manifest schema — fail-closed parse of the provenance document.
 *
 * Absent and mistyped are BOTH refusals, and the refusal always names the
 * field. Nothing is defaulted: a manifest missing `evaluator_sha256` is not a
 * manifest with an unknown evaluator, it is not a manifest.
 */
import { createFailureSink, describeValue, isRecord } from "./json"
import type { ProMaxFailure, ProMaxManifest } from "./types"

/** Every manifest field that must be a non-empty string. */
export const MANIFEST_STRING_FIELDS = [
  "captured_at",
  "upstream_repo_url",
  "upstream_git_commit",
  "hf_repo_id",
  "hf_dataset_revision",
  "dataset_path",
  "dataset_sha256",
  "eval_path",
  "eval_sha256",
  "evaluator_path",
  "evaluator_sha256",
  "dataset_ids_sha256",
  "eval_ids_sha256",
] as const

/** Every manifest field that must be a finite number. */
export const MANIFEST_NUMBER_FIELDS = ["schema_version", "dataset_count"] as const

export type ManifestParse =
  | { readonly ok: true; readonly manifest: ProMaxManifest }
  | { readonly ok: false; readonly failures: readonly ProMaxFailure[] }

const parseLanguageCounts = (raw: unknown, sink: ReturnType<typeof createFailureSink>): void => {
  if (!isRecord(raw)) {
    sink.add(
      "manifest_field_invalid",
      `manifest field \`language_counts\` must be an object of language -> count (got ${describeValue(raw)})`,
    )
    return
  }
  for (const [lang, count] of Object.entries(raw)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      sink.add(
        "manifest_field_invalid",
        `manifest field \`language_counts\`.${lang} must be a non-negative integer (got ${describeValue(count)})`,
      )
    }
  }
}

/** Parse manifest TEXT into a typed manifest, or refuse with named fields. */
export const parseManifest = (raw: string): ManifestParse => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          code: "manifest_unparseable",
          message: `manifest bytes are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      failures: [
        {
          code: "manifest_unparseable",
          message: `manifest JSON must be an object (got ${describeValue(parsed)})`,
        },
      ],
    }
  }

  const sink = createFailureSink()
  for (const field of MANIFEST_STRING_FIELDS) {
    const value = parsed[field]
    if (typeof value !== "string" || value.trim() === "") {
      sink.add(
        "manifest_field_invalid",
        `manifest field \`${field}\` must be a non-empty string (got ${describeValue(value)})`,
      )
    }
  }
  for (const field of MANIFEST_NUMBER_FIELDS) {
    const value = parsed[field]
    if (typeof value !== "number" || !Number.isFinite(value)) {
      sink.add(
        "manifest_field_invalid",
        `manifest field \`${field}\` must be a finite number (got ${describeValue(value)})`,
      )
    }
  }
  parseLanguageCounts(parsed.language_counts, sink)

  const failures = sink.drain()
  if (failures.length > 0) return { ok: false, failures }
  // every field was just checked field-by-field above
  return { ok: true, manifest: parsed as unknown as ProMaxManifest }
}
