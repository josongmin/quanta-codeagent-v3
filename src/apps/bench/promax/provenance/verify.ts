/**
 * PMX-00 — the ONE fail-closed bundle verification.
 *
 * Bytes in, verdict out. A campaign cannot reach dataset parsing or Docker
 * without narrowing `ok === true`, and every consumer (operator tool, bench
 * runtime) calls THIS function on the SAME bytes, so they cannot disagree.
 *
 * Failures ACCUMULATE rather than short-circuit: an operator fixing a frozen
 * bundle should see every defect at once, and per-code capping (see
 * `createFailureSink`) means a flood of one defect can never mask another's
 * code. The only early exits are the two points where continuing is impossible
 * — unparseable manifest bytes and an unparseable manifest schema.
 */
import { idSetEqualityFailures, parseDatasetIdentity, parseEvalIdentity } from "./corpus-identity"
import { decodeUtf8, instanceIdSetDigest, sha256Hex } from "./digest"
import { PROMAX_V1_SNAPSHOT, type ProMaxFrozenSnapshot } from "./frozen-snapshot"
import { createFailureSink, type FailureSink } from "./json"
import { parseManifest } from "./manifest"
import { isPinnedCommit } from "./selector"
import type {
  BundleBytes,
  ProMaxBundleSources,
  ProMaxFailure,
  ProMaxManifest,
  ProMaxVerification,
} from "./types"

/**
 * Which frozen upstream states this build is allowed to run. A manifest is not
 * self-authorizing: a self-consistent manifest for some future upstream commit
 * must be REFUSED until a human re-freezes and approves it (the ticket's stop
 * rule, enforced in code rather than by convention).
 */
export interface ProMaxVerifyPolicy {
  readonly approvedSnapshots?: readonly ProMaxFrozenSnapshot[] | undefined
}

/** Production default: only the re-verified v1 snapshot is approved. */
export const DEFAULT_APPROVED_SNAPSHOTS: readonly ProMaxFrozenSnapshot[] = [PROMAX_V1_SNAPSHOT]

const reject = (failures: readonly ProMaxFailure[]): ProMaxVerification => ({ ok: false, failures })

const checkPinnedSelectors = (manifest: ProMaxManifest, sink: FailureSink): void => {
  const pins: readonly (readonly [string, string])[] = [
    ["upstream_git_commit", manifest.upstream_git_commit],
    ["hf_dataset_revision", manifest.hf_dataset_revision],
  ]
  for (const [field, value] of pins) {
    if (!isPinnedCommit(value)) {
      sink.add(
        "selector_unpinned",
        `manifest \`${field}\` is "${value}", not a pinned 40-hex commit — ` +
          "moving refs would let upstream change under a frozen campaign",
      )
    }
  }
}

/** Compare a manifest against the approved frozen snapshot for its commit. */
const checkApprovedSnapshot = (
  manifest: ProMaxManifest,
  approved: readonly ProMaxFrozenSnapshot[],
  sink: FailureSink,
): void => {
  const snapshot = approved.find(
    (s) =>
      s.upstream_git_commit.toLowerCase() === manifest.upstream_git_commit.trim().toLowerCase(),
  )
  if (snapshot === undefined) {
    sink.add(
      "snapshot_drift",
      `manifest upstream_git_commit "${manifest.upstream_git_commit}" is not an APPROVED frozen snapshot ` +
        `(approved: ${approved.map((s) => `${s.label}@${s.upstream_git_commit}`).join(", ") || "none"}). ` +
        "Re-freeze and explicitly approve upstream before running it.",
    )
    return
  }
  const pairs: readonly (readonly [string, unknown, unknown])[] = [
    ["upstream_repo_url", manifest.upstream_repo_url, snapshot.upstream_repo_url],
    ["hf_repo_id", manifest.hf_repo_id, snapshot.hf_repo_id],
    ["hf_dataset_revision", manifest.hf_dataset_revision, snapshot.hf_dataset_revision],
    ["dataset_sha256", manifest.dataset_sha256, snapshot.dataset_sha256],
    ["eval_sha256", manifest.eval_sha256, snapshot.eval_sha256],
    ["evaluator_sha256", manifest.evaluator_sha256, snapshot.evaluator_sha256],
    ["dataset_count", manifest.dataset_count, snapshot.dataset_count],
    ["dataset_ids_sha256", manifest.dataset_ids_sha256, snapshot.ids_sha256],
    ["eval_ids_sha256", manifest.eval_ids_sha256, snapshot.ids_sha256],
  ]
  for (const [field, actual, expected] of pairs) {
    if (actual !== expected) {
      sink.add(
        "snapshot_drift",
        `manifest \`${field}\` is ${JSON.stringify(actual)} but approved snapshot ` +
          `${snapshot.label} declares ${JSON.stringify(expected)}`,
      )
    }
  }
}

const checkContentHashes = (
  manifest: ProMaxManifest,
  sources: ProMaxBundleSources,
  sink: FailureSink,
): void => {
  const files = [
    [
      "dataset",
      manifest.dataset_path,
      manifest.dataset_sha256,
      sources.dataset,
      "dataset_hash_mismatch",
    ],
    ["eval", manifest.eval_path, manifest.eval_sha256, sources.evalMeta, "eval_hash_mismatch"],
    [
      "evaluator",
      manifest.evaluator_path,
      manifest.evaluator_sha256,
      sources.evaluator,
      "evaluator_hash_mismatch",
    ],
  ] as const
  for (const [label, path, expected, bytes, code] of files) {
    const actual = sha256Hex(bytes)
    if (actual !== expected.trim().toLowerCase()) {
      sink.add(
        code,
        `${label} file ${path} hashes to ${actual} but the manifest declares ${expected} — ` +
          "the frozen bundle has been modified",
      )
    }
  }
}

const checkCrossSource = (sources: ProMaxBundleSources, sink: FailureSink): void => {
  const pairs: readonly (readonly [string, BundleBytes, BundleBytes | undefined])[] = [
    ["dataset", sources.dataset, sources.hfDataset],
    ["eval", sources.evalMeta, sources.hfEvalMeta],
  ]
  for (const [label, upstream, hf] of pairs) {
    if (hf === undefined) continue
    const upstreamHash = sha256Hex(upstream)
    const hfHash = sha256Hex(hf)
    if (upstreamHash !== hfHash) {
      sink.add(
        "cross_source_mismatch",
        `${label}: GitHub copy hashes to ${upstreamHash} but the Hugging Face copy hashes to ${hfHash} — ` +
          "this is exactly the untracked GitHub/HF hybrid the manifest exists to refuse",
      )
    }
  }
}

const checkCheckout = (
  manifest: ProMaxManifest,
  checkout: ProMaxBundleSources["checkout"],
  sink: FailureSink,
): void => {
  if (!checkout.detached) {
    sink.add(
      "checkout_not_detached",
      `upstream checkout is attached to ref "${checkout.ref ?? "(unknown)"}" — ` +
        "a campaign must run from a checkout DETACHED at the declared commit, " +
        "because a branch can move mid-run",
    )
  }
  const head = checkout.headCommit.trim().toLowerCase()
  const declared = manifest.upstream_git_commit.trim().toLowerCase()
  if (head !== declared) {
    sink.add(
      "checkout_commit_mismatch",
      `upstream checkout HEAD is ${checkout.headCommit} but the manifest declares ${manifest.upstream_git_commit}`,
    )
  }
}

// PMX-02: the id-set equality RULE moved to `corpus-identity.ts` so the corpus
// adapter enforces the same rule from the same owner. This is now only the
// sink adapter around it.
const checkIdSets = (
  datasetIds: readonly string[],
  evalIds: readonly string[],
  sink: FailureSink,
): void => {
  for (const failure of idSetEqualityFailures(datasetIds, evalIds)) {
    sink.add(failure.code, failure.message)
  }
}

const checkManifestCounts = (
  manifest: ProMaxManifest,
  datasetIds: readonly string[],
  evalIds: readonly string[],
  languageCounts: Readonly<Record<string, number>>,
  sink: FailureSink,
): void => {
  if (datasetIds.length !== manifest.dataset_count) {
    sink.add(
      "dataset_count_mismatch",
      `dataset has ${datasetIds.length} rows but the manifest declares dataset_count ${manifest.dataset_count}`,
    )
  }
  const datasetDigest = instanceIdSetDigest(datasetIds)
  if (datasetDigest !== manifest.dataset_ids_sha256.trim().toLowerCase()) {
    sink.add(
      "ids_digest_mismatch",
      `dataset id-set digest is ${datasetDigest} but the manifest declares ${manifest.dataset_ids_sha256}`,
    )
  }
  const evalDigest = instanceIdSetDigest(evalIds)
  if (evalDigest !== manifest.eval_ids_sha256.trim().toLowerCase()) {
    sink.add(
      "ids_digest_mismatch",
      `eval id-set digest is ${evalDigest} but the manifest declares ${manifest.eval_ids_sha256}`,
    )
  }
  const languages = new Set([
    ...Object.keys(languageCounts),
    ...Object.keys(manifest.language_counts),
  ])
  for (const language of languages) {
    const observed = languageCounts[language] ?? 0
    const declared = manifest.language_counts[language] ?? 0
    if (observed !== declared) {
      sink.add(
        "language_counts_mismatch",
        `language \`${language}\`: corpus has ${observed} rows but the manifest declares ${declared}`,
      )
    }
  }
}

/**
 * Verify a frozen ProMax bundle. Returns a verdict; never throws for bad
 * CONTENT (malformed bytes are refusals, not exceptions) so a caller cannot
 * accidentally swallow a refusal in a catch block.
 */
export const verifyProMaxBundle = (
  sources: ProMaxBundleSources,
  policy: ProMaxVerifyPolicy = {},
): ProMaxVerification => {
  let manifestText: string
  try {
    manifestText = decodeUtf8(sources.manifest)
  } catch (err) {
    return reject([
      {
        code: "manifest_unparseable",
        message: `manifest bytes are not valid UTF-8: ${err instanceof Error ? err.message : String(err)}`,
      },
    ])
  }
  const parsed = parseManifest(manifestText)
  if (!parsed.ok) return reject(parsed.failures)
  const manifest = parsed.manifest

  const sink = createFailureSink()
  checkPinnedSelectors(manifest, sink)
  checkApprovedSnapshot(manifest, policy.approvedSnapshots ?? DEFAULT_APPROVED_SNAPSHOTS, sink)
  checkContentHashes(manifest, sources, sink)
  checkCrossSource(sources, sink)
  checkCheckout(manifest, sources.checkout, sink)

  const instanceIds = collectCorpusIdentity(manifest, sources, sink)

  const failures = sink.drain()
  if (failures.length > 0) return reject(failures)
  return { ok: true, manifest, manifestSha256: sha256Hex(sources.manifest), instanceIds }
}

/** Parse both corpus files and run every id-level check. Returns sorted ids. */
const collectCorpusIdentity = (
  manifest: ProMaxManifest,
  sources: ProMaxBundleSources,
  sink: FailureSink,
): readonly string[] => {
  let datasetText: string
  let evalText: string
  try {
    datasetText = decodeUtf8(sources.dataset)
    evalText = decodeUtf8(sources.evalMeta)
  } catch (err) {
    sink.add(
      "dataset_unparseable",
      `corpus bytes are not valid UTF-8: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }

  const dataset = parseDatasetIdentity(datasetText)
  const evalMeta = parseEvalIdentity(evalText)
  if (!dataset.ok) for (const f of dataset.failures) sink.add(f.code, f.message)
  if (!evalMeta.ok) for (const f of evalMeta.failures) sink.add(f.code, f.message)
  if (!dataset.ok || !evalMeta.ok) return []

  checkIdSets(dataset.identity.ids, evalMeta.ids, sink)
  checkManifestCounts(
    manifest,
    dataset.identity.ids,
    evalMeta.ids,
    dataset.identity.languageCounts,
    sink,
  )
  return [...dataset.identity.ids].sort()
}
