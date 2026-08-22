/**
 * PMX-00 hermetic bundle fixture.
 *
 * Builds a complete, self-consistent ProMax provenance bundle IN MEMORY: 170
 * dataset rows, 170 eval records, a placeholder evaluator, and a manifest whose
 * hashes/digests/counts are all derived from those exact bytes.
 *
 * NO NETWORK. NO UPSTREAM BYTES IN GIT. The only thing transcribed from
 * upstream is the public `[instance_id, language]` table in `promax-v1-ids.ts`.
 * Every gold-bearing field (`patch`, `test_patch`, `eval_script`,
 * `problem_statement`) is SYNTHETIC placeholder text.
 *
 * INDEPENDENT ORACLE: this fixture hashes with `node:crypto` DIRECTLY, never
 * through the module under test. If `sha256Hex` / `instanceIdSetDigest` were
 * wrong (or inert), the happy-path bundle would stop validating instead of
 * agreeing with itself — the manifest's hashes are a real second opinion, not
 * an echo.
 *
 * Mutation ordering models reality:
 *  - structural overrides (`dataset`, `evalMap`, `evaluator`) run BEFORE the
 *    manifest is hashed, so a structural defect is tested in isolation with the
 *    content hashes still consistent;
 *  - `tamper` runs AFTER, modelling a frozen manifest against a modified file,
 *    which is exactly what the sha256 gate exists to catch.
 */
import { createHash } from "node:crypto"
import type {
  ProMaxBundleSources,
  ProMaxVerifyPolicy,
  UpstreamCheckoutState,
} from "@/apps/bench/promax/provenance"
import { PROMAX_V1_SNAPSHOT, PROMAX_V1_UPSTREAM_PATHS } from "@/apps/bench/promax/provenance"
import { PROMAX_V1_ID_LANGUAGE_ROWS } from "./promax-v1-ids"

export type JsonRecord = Record<string, unknown>

/** sha256 of UTF-8 bytes, computed WITHOUT the module under test. */
export const oracleSha256 = (input: string): string =>
  createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex")

/**
 * The upstream id-set digest convention, re-derived independently:
 * sha256 over the sorted unique ids joined by "\n", with a trailing "\n".
 * (Confirmed on 2026-08-22 to reproduce the frozen snapshot digest from the
 * real 170-row corpus; the anti-vacuum test pins that.)
 */
export const oracleIdSetDigest = (ids: readonly string[]): string =>
  oracleSha256(`${[...new Set(ids)].sort().join("\n")}\n`)

/** A synthetic dataset row. `created_at` is a NUMBER, matching real upstream. */
const syntheticRow = (id: string, language: string, index: number): JsonRecord => {
  const row: JsonRecord = {
    instance_id: id,
    repo: "synthetic/promax-fixture",
    base_commit: "0".repeat(40),
    environment_setup_commit: "1".repeat(40),
    language,
    image_name: `synthetic.invalid/promax:${index}`,
    working_dir: index === 0 ? "/testbed/build" : "/testbed",
    problem_statement: "SYNTHETIC fixture problem statement — no upstream text.",
    hints_text: "",
    patch: "SYNTHETIC-NOT-GOLD",
    test_patch: "SYNTHETIC-NOT-GOLD",
    created_at: 1_700_000_000 + index,
  }
  // Upstream rows are NOT key-uniform: `pull_number` appears on 104/170 rows and
  // `issue_numbers` on 3/170. Reproduce that sparsity so the validator is proven
  // not to require optional fields.
  if (index % 2 === 0) row.pull_number = 1000 + index
  if (index < 3) row.issue_numbers = [index]
  return row
}

const pristineRows = (): JsonRecord[] =>
  PROMAX_V1_ID_LANGUAGE_ROWS.map(([id, language], i) => syntheticRow(id, language, i))

const pristineEvalMap = (rows: readonly JsonRecord[]): Record<string, JsonRecord> => {
  const out: Record<string, JsonRecord> = {}
  for (const row of rows) {
    const id = String(row.instance_id)
    out[id] = { instance_id: id, eval_script: `#!/bin/bash\necho SYNTHETIC-EVAL ${id}\n` }
  }
  return out
}

const PRISTINE_EVALUATOR = [
  '"""SYNTHETIC evaluator placeholder — not upstream test_run.py."""',
  "import subprocess",
  "",
  "def main() -> None:",
  '    subprocess.run("docker run --rm synthetic", shell=True, check=False)',
  "",
  'if __name__ == "__main__":',
  "    main()",
  "",
].join("\n")

const countLanguages = (rows: readonly JsonRecord[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const lang = String(row.language)
    counts[lang] = (counts[lang] ?? 0) + 1
  }
  return counts
}

export interface FixtureOverrides {
  /** structural: applied BEFORE hashing (manifest stays consistent). */
  readonly dataset?: (rows: JsonRecord[]) => JsonRecord[]
  readonly evalMap?: (map: Record<string, JsonRecord>) => Record<string, JsonRecord>
  readonly evaluator?: (src: string) => string
  /** applied to the manifest record AFTER its hashes are computed. */
  readonly manifest?: (m: JsonRecord) => JsonRecord
  readonly checkout?: Partial<UpstreamCheckoutState>
  /** post-hash file tampering — models a frozen manifest vs a modified file. */
  readonly tamper?: {
    readonly dataset?: (bytes: string) => string
    readonly evalMeta?: (bytes: string) => string
    readonly evaluator?: (bytes: string) => string
  }
  /** post-hash divergence of the Hugging Face copies from the GitHub copies. */
  readonly hf?: {
    readonly include?: boolean
    readonly dataset?: (bytes: string) => string
    readonly evalMeta?: (bytes: string) => string
  }
}

export interface FixtureBundle {
  readonly sources: ProMaxBundleSources
  /**
   * Approval policy naming a snapshot derived from this bundle's PRISTINE
   * bytes. Injected because the fixture's file bodies are synthetic, so their
   * content hashes cannot equal the real upstream ones — the approval gate
   * itself is exercised separately (and against the real default registry) in
   * `provenance-snapshot.test.ts`. Manifest overrides are applied AFTER the
   * snapshot is derived, so tampering with the manifest still trips drift.
   */
  readonly policy: ProMaxVerifyPolicy
  readonly manifestJson: string
  readonly manifestRecord: JsonRecord
  readonly datasetJson: string
  readonly evalJson: string
  readonly evaluatorSource: string
  /** the ids actually present in the built dataset bytes. */
  readonly datasetIds: readonly string[]
}

export const buildFixtureBundle = (o: FixtureOverrides = {}): FixtureBundle => {
  const rows = o.dataset ? o.dataset(pristineRows()) : pristineRows()
  const evalMap = o.evalMap ? o.evalMap(pristineEvalMap(rows)) : pristineEvalMap(rows)
  const evaluatorSource = o.evaluator ? o.evaluator(PRISTINE_EVALUATOR) : PRISTINE_EVALUATOR

  const datasetJson = JSON.stringify(rows)
  const evalJson = JSON.stringify(evalMap)
  const datasetIds = rows.map((r) => String(r.instance_id))

  const baseManifest: JsonRecord = {
    schema_version: 1,
    captured_at: "2026-08-22T00:00:00.000Z",
    upstream_repo_url: PROMAX_V1_SNAPSHOT.upstream_repo_url,
    upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
    hf_repo_id: PROMAX_V1_SNAPSHOT.hf_repo_id,
    hf_dataset_revision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
    dataset_path: PROMAX_V1_UPSTREAM_PATHS.dataset,
    dataset_sha256: oracleSha256(datasetJson),
    eval_path: PROMAX_V1_UPSTREAM_PATHS.evalMeta,
    eval_sha256: oracleSha256(evalJson),
    evaluator_path: PROMAX_V1_UPSTREAM_PATHS.evaluator,
    evaluator_sha256: oracleSha256(evaluatorSource),
    dataset_count: rows.length,
    dataset_ids_sha256: oracleIdSetDigest(datasetIds),
    eval_ids_sha256: oracleIdSetDigest(Object.keys(evalMap)),
    language_counts: countLanguages(rows),
  }
  // Derived from the PRISTINE manifest, before any manifest override.
  const policy: ProMaxVerifyPolicy = {
    approvedSnapshots: [
      {
        label: "fixture-v1",
        upstream_repo_url: String(baseManifest.upstream_repo_url),
        upstream_git_commit: String(baseManifest.upstream_git_commit),
        hf_repo_id: String(baseManifest.hf_repo_id),
        hf_dataset_revision: String(baseManifest.hf_dataset_revision),
        dataset_sha256: String(baseManifest.dataset_sha256),
        eval_sha256: String(baseManifest.eval_sha256),
        evaluator_sha256: String(baseManifest.evaluator_sha256),
        dataset_count: Number(baseManifest.dataset_count),
        ids_sha256: String(baseManifest.dataset_ids_sha256),
        language_counts: baseManifest.language_counts as Record<string, number>,
      },
    ],
  }

  const manifestRecord = o.manifest ? o.manifest(baseManifest) : baseManifest
  const manifestJson = JSON.stringify(manifestRecord)

  const datasetBytes = o.tamper?.dataset ? o.tamper.dataset(datasetJson) : datasetJson
  const evalBytes = o.tamper?.evalMeta ? o.tamper.evalMeta(evalJson) : evalJson
  const evaluatorBytes = o.tamper?.evaluator ? o.tamper.evaluator(evaluatorSource) : evaluatorSource

  const checkout: UpstreamCheckoutState = {
    detached: o.checkout?.detached ?? true,
    headCommit: o.checkout?.headCommit ?? PROMAX_V1_SNAPSHOT.upstream_git_commit,
    ref: o.checkout?.ref,
  }

  const includeHf = o.hf?.include ?? true
  const sources: ProMaxBundleSources = {
    manifest: manifestJson,
    dataset: datasetBytes,
    evalMeta: evalBytes,
    evaluator: evaluatorBytes,
    ...(includeHf
      ? {
          hfDataset: o.hf?.dataset ? o.hf.dataset(datasetBytes) : datasetBytes,
          hfEvalMeta: o.hf?.evalMeta ? o.hf.evalMeta(evalBytes) : evalBytes,
        }
      : {}),
    checkout,
  }

  return {
    sources,
    policy,
    manifestJson,
    manifestRecord,
    datasetJson,
    evalJson,
    evaluatorSource,
    datasetIds,
  }
}

/** codes present in a rejected verdict, for concise assertions. */
export const failureCodes = (v: {
  ok: boolean
  failures?: readonly { code: string }[]
}): string[] => (v.failures ?? []).map((f) => f.code)
