/**
 * jun-30 T4 — `DatasetFamilyProfile`: the SINGLE per-family backend port.
 *
 * SWE-bench Pro/Live landed, but family behavior was smeared across owner layers,
 * each re-deciding the family with raw `=== "pro"` / `=== "live"` string compares:
 *   1. corpus-parse   — normalizeProRow vs identity      (dataset-family.ts)
 *   2. grade-harness  — Scale verifier vs official        (dataset-family.ts)
 *   3. remote env     — pip-spec / docker namespace / on-box Pro env prefix /
 *                       on-box harness bootstrap
 *                       (ec2-lifecycle.ts, box-session.ts)
 *   4. preflight      — Pro Scale-column shape check vs no-op (dataset-preflight.ts)
 *   5. remote preset  — Pro's LSP-optional default preset    (preset.ts)
 *
 * This interface makes those behaviors typed fields of ONE object, keyed in
 * {@link DATASET_FAMILY_PROFILES}. Adding a dataset family is: one token in
 * `DATASET_FAMILIES` + one profile object registered here — NOTHING in any
 * consumer module. That stop rule is executed end-to-end by
 * `family-four-stop-rule.test.ts`.
 *
 * aug-22 HIGH-4 — direction: every family-agnostic BODY a profile delegates to
 * now lives in a leaf the profile layer owns (`harness-spec.ts`,
 * `pro-env-prefix.ts`, `pro-dataset-shape.ts`, `pro-box-setup.ts`). The registry
 * no longer imports family logic back out of `remote/box-session*`, which is what
 * left the remote-env and preflight ports with zero production consumers.
 */
import type { PythonSwebenchResult } from "@/runner/batch/eval/verdict"
import type { DatasetFamily } from "../dataset-family-token"
import type { ProSwebenchOpts } from "../pro-swebench"
import type { BenchRunConfig } from "../run-config"
import type { Instance } from "../types"
import type { FamilyCorpusReader, FamilyCorpusRow } from "./corpus-row"

/** The grade evaluator shape shared by BOTH the official and the Pro verifier —
 *  it injects unchanged into the one `VerifyDeps.pythonSwebench` seam. */
export type FamilyGradeEvaluator = (
  instance: Instance,
  patch: string,
  opts?: unknown,
) => Promise<PythonSwebenchResult>

/** Input to a family's swebench harness-build resolution. All raw signals are
 *  passed IN (the profile never reads process.env), so local and remote paths
 *  resolve identically. */
export interface HarnessSpecInput {
  readonly datasetName: string
  /** Operator `QUANTA_SWEBENCH_PIP_SPEC` — wins over the derivation. */
  readonly pipSpecOverride?: string | undefined
  /** Operator `QUANTA_SWEBENCH_NAMESPACE` — wins over the derivation. */
  readonly namespaceOverride?: string | undefined
}

/** The resolved per-family swebench harness build. */
export interface HarnessSpec {
  /** `swebench` (verified/pro) vs the SWE-bench-Live fork (live). */
  readonly pipSpec: string
  /** `swebench` (verified/pro) vs `starryzhang` (live). */
  readonly namespace: string
}

/** Input to a family's ON-BOX env prefix. `datasetPath` is the BOX-side path of
 *  the shipped chunk (it doubles as the Scale `--raw_sample_path`), which is why
 *  this is a separate port from {@link HarnessSpecInput}: the shim/bootstrap
 *  callers resolve a pip-spec with no box-side dataset path in scope. */
export interface OnBoxEnvInput {
  readonly datasetPath: string
  /** env carrying the operator's per-family OVERRIDE knobs (for Pro: the
   *  dockerhub-username / model-name the on-box prefix forwards when set). */
  readonly env: NodeJS.ProcessEnv
}

/** Input to a family's preflight shape check.
 *
 *  PMX-02: the preflight body no longer opens the dataset file. It receives
 *  {@link readRows}, a thunk bound to the family's OWN {@link
 *  DatasetFamilyProfile.readCorpus} reader, so a family whose corpus is not
 *  JSONL is validated by the same reader that will later run it — and so the
 *  JSONL reader never grows a per-family branch. `datasetPath` remains, for
 *  refusal MESSAGES only. */
export interface PreflightInput {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[] | undefined
  readonly surface: string
  /** Decode the dataset through the family's reader. THROWS
   *  `RemoteDatasetPreflightError` when the file is unreadable or has no rows.
   *  Lazy on purpose: a family with a no-op preflight performs no read at all,
   *  so verified/live stay byte-identical. */
  readonly readRows: () => readonly FamilyCorpusRow[]
}

/** Input to a family's ON-BOX bootstrap step. Structurally typed (not the
 *  box-session `SpawnResult` import) so the profile layer keeps no edge into its
 *  consumer. */
export interface BoxSetupInput {
  readonly ssh: (
    cmd: string,
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>
  readonly log: (m: string) => void
}

/**
 * The ONE per-family backend port. Every family-conditional behavior is a field
 * here; consumers resolve the profile via {@link resolveDatasetFamilyProfile}
 * and call the field, never a raw family string-compare.
 */
export interface DatasetFamilyProfile {
  readonly family: DatasetFamily
  /**
   * The REPORT PARTITION this family's runs are aggregated under (PMX-05 reads
   * it; BFND-02's envelope stamps `datasetFamily`).
   *
   * Why it is a field rather than "just the family string": packet invariant 1
   * says `pro` and `promax` never share a report partition, and an invariant
   * that lives only in prose is one careless `reportPartitionKey: "pro"` away
   * from merging two campaigns with different corpora, evaluators and result
   * semantics into one leaderboard row. Declaring it makes the claim checkable —
   * `registerDatasetFamilyProfile` REFUSES a profile whose key is already taken,
   * so a collision is a startup error, not a silently wrong number.
   */
  readonly reportPartitionKey: string
  /** Human-readable grading-harness label for dry-run plans. Undefined ⇒ the
   *  default (official swebench) label. Pro ⇒ the ScaleAI harness label. */
  readonly verifierLabel?: string
  /**
   * Extra lines this family wants on a REMOTE dry-run plan, derived from the
   * ALREADY-RESOLVED typed config (never a fresh env read). Undefined ⇒ no
   * lines, which is what keeps verified/live/pro plans byte-identical.
   *
   * Generic on purpose: the plan builders call `profile.planNotes?.(cfg)` and
   * name no family, so a new family's operator-facing plan detail is part of its
   * ONE profile object rather than a conditional in `remote/full.ts` /
   * `commands/pool.ts`.
   */
  readonly planNotes?: (cfg: BenchRunConfig) => readonly string[]
  /** The default `--dataset-name` when the operator passes none. Undefined for
   *  verified/pro (they default to the official Verified dataset downstream);
   *  live ⇒ the SWE-bench-Live HF id (a Live run grades a DIFFERENT dataset). */
  readonly defaultDatasetName?: string
  /** layer 5 — the REMOTE default bench preset when the operator selected none.
   *  Pro ⇒ `agentless-v1` (Pro spans Python/Go/JS/TS while the strict remote box
   *  proves only Pyright, so the LSP-optional baseline is the honest default).
   *  Undefined ⇒ the normal preset precedence is unchanged. */
  readonly remoteDefaultPreset?: string
  /** Whether this family grades via the ScaleAI Pro harness (a DIFFERENT
   *  `pythonSwebench` dep-builder wired with harness dir / venv / raw-sample
   *  path) rather than the official swebench harness. Pro ⇒ true. This is the
   *  typed discriminant the local grade-dep builder switches on, so no consumer
   *  re-derives it with a raw `family === "pro"` compare. */
  readonly gradesWithProHarness: boolean
  /**
   * layer 1 — CORPUS PARSE. The ONE reader for this family's dataset FORMAT:
   * file text → ordered {@link FamilyCorpusRow}s.
   *
   * PMX-02 replaced the previous per-ROW `parseRow` hook with this per-FILE port.
   * `parseRow` could only ever describe a normalization of a row that some OTHER
   * module had already split out of the file, which silently hard-coded "the file
   * is JSONL" into three separate consumers (the run path, the remote preflight,
   * and the pool chunk slicer). A family whose corpus is an official JSON ARRAY
   * cannot be expressed that way at all: two of those three would see zero rows.
   *
   * Every dataset consumer — local run, local dry-run, full-remote preflight,
   * pool preflight, pool chunk slicing, instance-id enumeration — resolves the
   * profile and calls THIS. `family-four-stop-rule.test.ts` and
   * `promax-one-reader.test.ts` prove there is no bypass parser by replacing this
   * one function with a failing fake and observing every surface fail.
   */
  readonly readCorpus: FamilyCorpusReader
  /** layer 2 — grade-harness selection: Pro ⇒ Scale verifier; else official. Both
   *  return the same PythonSwebenchResult shape. */
  readonly gradeEvaluator: (proOpts?: ProSwebenchOpts) => FamilyGradeEvaluator
  /** layer 3a — the swebench harness build (pip-spec + prebuilt-image namespace)
   *  this family's box grades with. */
  readonly harnessSpec: (input: HarnessSpecInput) => HarnessSpec
  /** layer 3b — the `KEY=val ` prefix prepended to the on-box bench command.
   *  Non-empty ONLY for Pro (Scale harness dir / venv python / raw-sample path +
   *  overrides). "" for verified/live ⇒ byte-identical. */
  readonly onBoxEnvPrefix: (input: OnBoxEnvInput) => string
  /** layer 3c — extra ON-BOX provisioning this family needs during bootstrap.
   *  Pro ⇒ clone the Scale harness + build its venv; verified/live ⇒ no-op (not
   *  even an ssh round-trip, so their bootstrap is byte-identical). */
  readonly setupBox: (input: BoxSetupInput) => Promise<void>
  /** layer 4 — preflight: Pro ⇒ fail-closed Scale-column shape check; else no-op.
   *  Throws RemoteDatasetPreflightError on a malformed Pro dataset. */
  readonly preflight: (input: PreflightInput) => void
}
