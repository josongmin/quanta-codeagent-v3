/**
 * PMX-00 — the ProMax upstream provenance contract.
 *
 * One fail-closed manifest proves WHICH ProMax dataset, eval metadata,
 * evaluator, and instance set a campaign used. The failure mode this exists to
 * refuse: a Hugging Face dataset revision and a mismatched GitHub evaluator
 * commit silently forming an untracked hybrid that nobody can reproduce.
 *
 * Everything here is PURE and HERMETIC — bytes in, verdict out. No network, no
 * `process.env`, no filesystem, no clock. The operator tool and the runtime
 * both call {@link ProMaxVerification}-returning functions on the SAME bytes and
 * therefore cannot disagree.
 *
 * OWNERSHIP (PMX-00 owns source identity and bundle validation ONLY):
 *  - dataset→agent projection / nested sampling ....... PMX-02
 *  - evaluator invocation / outcome classification .... PMX-03
 *  - Docker pull/inspect/platform receipts ............ PMX-04
 *  - report aggregation / dashboard rendering ......... PMX-05
 * No consumer may create a second relaxed schema, silently fill absent fields,
 * or re-fetch moving upstream.
 */

/** Raw bundle input. Bytes are authoritative; a `string` is encoded as UTF-8. */
export type BundleBytes = Uint8Array | string

/**
 * The frozen upstream provenance manifest. Field names are snake_case because
 * this interface IS the on-disk JSON document schema — there is deliberately no
 * second camelCase spelling for the same record to drift against.
 */
export interface ProMaxManifest {
  readonly schema_version: number
  /** ISO-8601 instant at which the snapshot was frozen and verified. */
  readonly captured_at: string
  readonly upstream_repo_url: string
  /** 40-hex. Never a branch name — see {@link requirePinnedCommit}. */
  readonly upstream_git_commit: string
  readonly hf_repo_id: string
  /** 40-hex HF commit revision. Never `main`. */
  readonly hf_dataset_revision: string
  readonly dataset_path: string
  readonly dataset_sha256: string
  readonly eval_path: string
  readonly eval_sha256: string
  readonly evaluator_path: string
  readonly evaluator_sha256: string
  readonly dataset_count: number
  /** sha256 of the sorted unique instance-id set — see `instanceIdSetDigest`. */
  readonly dataset_ids_sha256: string
  readonly eval_ids_sha256: string
  readonly language_counts: Readonly<Record<string, number>>
}

/**
 * Observed state of the local upstream checkout. Supplied BY the caller (git is
 * an effect; this module stays pure). A campaign may only run from a checkout
 * detached exactly at the manifest's commit.
 */
export interface UpstreamCheckoutState {
  readonly detached: boolean
  readonly headCommit: string
  /** the symbolic ref the checkout is on when NOT detached (e.g. `main`). */
  readonly ref?: string | undefined
}

/** Every byte source a verification consumes. */
export interface ProMaxBundleSources {
  readonly manifest: BundleBytes
  readonly dataset: BundleBytes
  readonly evalMeta: BundleBytes
  readonly evaluator: BundleBytes
  /**
   * Optional second copy of the data files fetched from Hugging Face. When
   * present they must be BYTE-IDENTICAL to the GitHub copies — that is the
   * check which refuses a HF-revision / GitHub-commit hybrid.
   */
  readonly hfDataset?: BundleBytes | undefined
  readonly hfEvalMeta?: BundleBytes | undefined
  readonly checkout: UpstreamCheckoutState
}

/**
 * Closed classification of every way a bundle can be refused. Adding a member
 * without adding its reason to `PROMAX_FAILURE_REASONS` fails to compile, and a
 * runtime drift guard pins the two in the other direction.
 */
export type ProMaxFailureCode =
  | "manifest_unparseable"
  | "manifest_field_invalid"
  | "selector_unpinned"
  | "snapshot_drift"
  | "dataset_unparseable"
  | "eval_unparseable"
  | "dataset_hash_mismatch"
  | "eval_hash_mismatch"
  | "evaluator_hash_mismatch"
  | "cross_source_mismatch"
  | "instance_id_invalid"
  | "instance_id_duplicated"
  | "dataset_field_invalid"
  | "eval_script_missing"
  | "eval_key_mismatch"
  | "id_set_unequal"
  | "dataset_count_mismatch"
  | "ids_digest_mismatch"
  | "language_counts_mismatch"
  | "checkout_not_detached"
  | "checkout_commit_mismatch"

/** One refusal. `message` always names the offending id/field/value. */
export interface ProMaxFailure {
  readonly code: ProMaxFailureCode
  readonly message: string
}

export interface ProMaxVerifiedBundle {
  readonly ok: true
  readonly manifest: ProMaxManifest
  /** sha256 over the EXACT manifest bytes supplied (not a re-serialization). */
  readonly manifestSha256: string
  /** sorted unique instance ids. Identity only — never row content. */
  readonly instanceIds: readonly string[]
}

export interface ProMaxRejectedBundle {
  readonly ok: false
  readonly failures: readonly ProMaxFailure[]
}

/**
 * Fail-closed verdict. A consumer that wants instance ids MUST narrow on
 * `ok === true`, so there is no way to reach dataset parsing or Docker with an
 * unverified bundle.
 */
export type ProMaxVerification = ProMaxVerifiedBundle | ProMaxRejectedBundle

/**
 * Human-readable reason per code. `Record<ProMaxFailureCode, string>` is the
 * exhaustiveness lever: a new code that is not classified here is a COMPILE
 * error, not a silently unexplained refusal.
 */
export const PROMAX_FAILURE_REASONS: Record<ProMaxFailureCode, string> = {
  manifest_unparseable: "manifest bytes are not parseable JSON",
  manifest_field_invalid: "a required manifest field is missing or mistyped",
  selector_unpinned: "a commit/revision selector is absent, blank, or a moving ref",
  snapshot_drift: "manifest disagrees with the frozen v1 snapshot recorded in git",
  dataset_unparseable: "dataset bytes are not a JSON array of objects",
  eval_unparseable: "eval bytes are not a JSON object keyed by instance id",
  dataset_hash_mismatch: "dataset bytes do not hash to the manifest sha256",
  eval_hash_mismatch: "eval bytes do not hash to the manifest sha256",
  evaluator_hash_mismatch: "evaluator bytes do not hash to the manifest sha256",
  cross_source_mismatch: "GitHub and Hugging Face copies are not byte-identical",
  instance_id_invalid: "an instance_id is absent, non-string, or blank",
  instance_id_duplicated: "an instance_id appears more than once",
  dataset_field_invalid: "a required dataset field has the wrong primitive type",
  eval_script_missing: "an eval record has an absent or blank eval_script",
  eval_key_mismatch: "an eval map key disagrees with its record's instance_id",
  id_set_unequal: "dataset and eval instance-id sets are not exactly equal",
  dataset_count_mismatch: "dataset row count disagrees with the manifest count",
  ids_digest_mismatch: "computed instance-id set digest disagrees with the manifest",
  language_counts_mismatch: "observed language counts disagree with the manifest",
  checkout_not_detached: "upstream checkout is on a moving ref, not detached",
  checkout_commit_mismatch: "upstream checkout HEAD is not the manifest commit",
}

/** Runtime drift guard companion — the other direction of the same pin. */
export const PROMAX_FAILURE_CODES = Object.keys(
  PROMAX_FAILURE_REASONS,
) as readonly ProMaxFailureCode[]
