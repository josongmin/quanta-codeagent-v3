/**
 * PMX-00 — the ONE ProMax upstream-provenance surface.
 *
 * Both entrypoints that exist (the offline operator tool under
 * `tools/bench-promax/` and any future bench-runtime consumer) import
 * `verifyProMaxBundle` from HERE. Neither parses a manifest itself, so the two
 * cannot produce different verdicts or different manifest digests for the same
 * bytes.
 */
export {
  type CorpusIdentity,
  type CorpusParse,
  type EvalParse,
  idSetEqualityFailures,
  parseDatasetIdentity,
  parseEvalIdentity,
} from "./corpus-identity"
export { instanceIdSetDigest, sha256Hex } from "./digest"
export {
  PROMAX_V1_SNAPSHOT,
  PROMAX_V1_UPSTREAM_PATHS,
  type ProMaxFrozenSnapshot,
} from "./frozen-snapshot"
export { createFailureSink, describeValue, type FailureSink, isRecord } from "./json"
export { type ManifestParse, parseManifest } from "./manifest"
export { isPinnedCommit, requireExplicitBundleRoot, requirePinnedCommit } from "./selector"
export {
  type BundleBytes,
  PROMAX_FAILURE_CODES,
  PROMAX_FAILURE_REASONS,
  type ProMaxBundleSources,
  type ProMaxFailure,
  type ProMaxFailureCode,
  type ProMaxManifest,
  type ProMaxRejectedBundle,
  type ProMaxVerification,
  type ProMaxVerifiedBundle,
  type UpstreamCheckoutState,
} from "./types"
export {
  DEFAULT_APPROVED_SNAPSHOTS,
  type ProMaxVerifyPolicy,
  verifyProMaxBundle,
} from "./verify"
