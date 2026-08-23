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

/**
 * Input to a family's MANIFEST-DRIVEN SELECTION (PMX-06 / aug-22 G4).
 *
 * The generic run path decides WHICH instances execute. For most families that
 * is the `--instance` filter and nothing else. A family whose campaigns are
 * defined by a published, digest-sealed sample (ProMax's `PMX-7 ⊂ PMX-14 ⊂
 * PMX-40 ⊂ PMX-170`) needs the manifest to be the AUTHORITY, or "we ran PMX-7"
 * is an unverifiable claim about whatever `--instance` happened to say.
 */
export interface SelectionInput {
  /** The env the composition root resolved from — never a fresh ambient read. */
  readonly env: NodeJS.ProcessEnv
  /** The corpus as this family's own reader decoded it, in dataset order. */
  readonly rows: readonly FamilyCorpusRow[]
  /** Caller label for refusal messages (`local-run`, `full-remote`, …). */
  readonly surface: string
}

/**
 * One on-box bootstrap command, as DATA.
 *
 * PMX-04. A family whose remote lane needs more than the shared box image (a
 * pinned upstream checkout, a dedicated interpreter, a platform/disk gate)
 * previously had two options, both bad: a shell script hidden inside
 * `setupBox`, which nothing can assert about; or a family branch in
 * `box-session.ts` / `ec2-lifecycle.ts`, which packet invariant 10 forbids.
 *
 * Expressing the bootstrap as an ordered argv list makes it a VALUE — a dry-run
 * can print it, a receipt can record it, and a test can replay it through a fake
 * executor — while the SEMANTICS stay with the family's own owner module.
 */
export interface FamilyBootstrapCommand {
  /** Family-defined phase label, surfaced in plans and receipts. */
  readonly step: string
  /**
   * WHICH CAMPAIGN PHASE this command may run in. Required, so a family cannot
   * add a command without classifying it (a new member of the union is a
   * compile error at every construction site, not a silent default).
   *
   * `agent` — runs on the box the AGENT will run on, before patch generation.
   * `grader` — runs only once model patches are captured, on grading material
   *   that invariant 3 forbids from co-existing with the agent.
   * `teardown` — REMOVES what the grader phase materialized. Bound to the same
   *   executor call as `grader` (it runs in that call's `finally`), because a
   *   teardown with its own call site is a teardown someone forgets: the box
   *   then carries the answer key into the NEXT chunk's agent phase.
   *
   * 🔴 REACHABILITY, aug-22: only `agent` has a production caller today. NOTHING
   * under `src/` executes the `grader` phase, so the `teardown` bound to it does
   * not run either — see `profiles/bootstrap-phase-wiring.ts`, which owns that
   * claim as checked data rather than as this comment.
   */
  readonly phase: FamilyBootstrapPhase
  /**
   * Does executing this command materialize or read ANSWER-KEY bytes on the box
   * (gold patch, test patch, eval script, golden output, derived image receipt)?
   *
   * A separate axis from {@link phase} ON PURPOSE: `phase` says where a family
   * INTENDS a command to run, `goldBearing` says what it does. The executor
   * cross-checks the two and refuses a gold-bearing command in the agent phase,
   * so a mislabelled phase fails closed instead of leaking.
   */
  readonly goldBearing: boolean
  /** argv — never a shell string. */
  readonly argv: readonly string[]
  /** Why this command is in the plan, for an operator reading a dry-run. */
  readonly purpose: string
  /**
   * The typed expectation this command's OUTPUT must satisfy: a sha256 the
   * command is expected to report for {@link FamilyBootstrapDigestExpectation.absolutePath}.
   *
   * It lives in the plan DATA rather than being piped into `sha256sum --check`
   * on stdin for two reasons: a stdin payload is not visible in a recorded argv,
   * so a campaign receipt could not prove WHICH digest was checked; and the
   * comparison then belongs to the executor, where a test can drive it, rather
   * than to a remote shell's exit status.
   */
  readonly verifies?: FamilyBootstrapDigestExpectation
  /**
   * The ABSENCE this command proves. See {@link FamilyBootstrapAbsenceProbe} —
   * a non-zero exit is classified as "the path EXISTS", not as a broken step.
   */
  readonly absenceProbe?: FamilyBootstrapAbsenceProbe
}

/**
 * This command PROVES an on-box path is ABSENT. A non-zero exit means the path
 * EXISTS, and for a gold-bearing path that is the leak itself, so the executor
 * refuses with the path named rather than reporting a generic step failure.
 *
 * It is a typed marker rather than a naming convention because the agent-phase
 * absence claim is asserted on the RENDERED command list: a probe is the ONE
 * kind of agent-phase command allowed to name a gold-bearing path (it names it
 * in order to assert nothing is there), and a classifier that cannot tell a
 * probe from a leak has to choose between forbidding the probe and permitting
 * the leak.
 */
export interface FamilyBootstrapAbsenceProbe {
  /** The ON-BOX absolute path this command proves is absent. */
  readonly absolutePath: string
}

/** The campaign phases a bootstrap command can belong to. Closed union: adding
 *  a member forces every construction site and classifier to be revisited. */
export const FAMILY_BOOTSTRAP_PHASES = ["agent", "grader", "teardown"] as const

export type FamilyBootstrapPhase = (typeof FAMILY_BOOTSTRAP_PHASES)[number]

/** A digest a bootstrap command's stdout must report. */
export interface FamilyBootstrapDigestExpectation {
  /** Family-facing label for the artifact — a repo-relative path, typically. */
  readonly path: string
  /** The ON-BOX absolute path the digest is taken over. */
  readonly absolutePath: string
  /** The sha256 the command's output must contain. */
  readonly sha256: string
}

/**
 * A family's REMOTE BOOTSTRAP specification: what a box must become before this
 * family can grade on it.
 *
 * Deliberately narrow and generic. Remote code CARRIES this (owner split:
 * "remote does not rediscover family behavior") and must not reach through it
 * for family-specific semantics — the evaluator/image decisions stay in the
 * family's own owner module, and only their RESULT travels here.
 */
export interface FamilyRemoteBootstrap {
  readonly family: DatasetFamily
  readonly commands: readonly FamilyBootstrapCommand[]
  /**
   * GRADER-side parallelism. Deliberately a separate number from the agent's
   * patch-generation concurrency: they bound different resources (a Docker
   * daemon versus a model rate limit) and collapsing them is how a box ends up
   * grading 16-wide because the operator wanted 16 agents.
   */
  readonly graderWorkers: number
  /** Extra operator-facing dry-run lines describing what would be bootstrapped. */
  readonly planNotes: readonly string[]
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
 * Input to the family ADMISSION gate.
 *
 * 🔴 It carries NO `ssh` ON PURPOSE. Admission's whole job is to run BEFORE the
 * box has been mutated on this family's behalf, and a port that cannot reach the
 * box cannot mutate it — the ordering guarantee is a property of the TYPE rather
 * than of where the call happens to sit today.
 */
export interface FamilyAdmissionInput {
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
  /**
   * layer 3b′ — ADMISSION. "May this family run on a box at all?"
   *
   * REQUIRED, and separate from {@link setupBox}, because those are two
   * different questions that were conflated into one late call: `setupBox` both
   * REFUSES (ProMax) and MUTATES (Pro clones a harness + builds a venv), and it
   * runs at the END of `bootstrapBox` — after mkdir, after a full `src/` rsync,
   * after an scp and a `bun install`. So a family that refuses this lane refused
   * it only once the box had already been provisioned and rewritten on its
   * behalf, which is how a refusal that a receipt cites as its guard ends up
   * firing against a box that has already been mutated.
   *
   * Throw to refuse; return to admit. Admitting families implement it as a
   * no-op, so their provisioning stays byte-identical — it cannot even issue an
   * ssh round trip ({@link FamilyAdmissionInput} carries no transport).
   */
  readonly admitBox: (input: FamilyAdmissionInput) => void
  /** layer 3c — extra ON-BOX provisioning this family needs during bootstrap.
   *  Pro ⇒ clone the Scale harness + build its venv; verified/live ⇒ no-op (not
   *  even an ssh round-trip, so their bootstrap is byte-identical). */
  readonly setupBox: (input: BoxSetupInput) => Promise<void>
  /** layer 4 — preflight: Pro ⇒ fail-closed Scale-column shape check; else no-op.
   *  Throws RemoteDatasetPreflightError on a malformed Pro dataset. */
  readonly preflight: (input: PreflightInput) => void
  /**
   * layer 6 — MANIFEST-DRIVEN SELECTION (PMX-06 / aug-22 G4). The ORDERED
   * instance ids this run must execute, or `undefined` when the operator named
   * no manifest.
   *
   * Absent port (verified/live/pro) ⇒ the selection path is byte-identical to
   * before: the generic consumer calls `profile.resolveSelection?.(…)` and a
   * `undefined` result leaves the historical `--instance` filter untouched.
   *
   * FAIL-CLOSED by contract: an implementation that cannot prove the manifest and
   * the loaded corpus are the same population must THROW, never fall back to
   * "run everything" — a campaign silently running a different set than the one
   * it names is the whole failure this port exists to prevent.
   */
  readonly resolveSelection?: (input: SelectionInput) => readonly string[] | undefined
  /**
   * layer 7 — the REMOTE BOOTSTRAP specification (PMX-04). What this family
   * needs a grading box to become, derived from the ALREADY-RESOLVED typed
   * config, never a fresh env read.
   *
   * Absent port (verified/live/pro) ⇒ `undefined` ⇒ every remote surface behaves
   * byte-identically to before: the generic consumer calls
   * `profile.remoteBootstrap?.(cfg)` and adds nothing when there is nothing.
   *
   * It is a PORT rather than a static object because the specification depends
   * on the run (its concurrency, its operator knobs), and it returns DATA rather
   * than performing IO because the ticket requires "argv and ordering are
   * testable without executing anything".
   */
  readonly remoteBootstrap?: (cfg: BenchRunConfig) => FamilyRemoteBootstrap
}
