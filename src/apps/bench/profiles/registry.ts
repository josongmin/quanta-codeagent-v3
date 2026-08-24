/**
 * jun-30 T4 — the `DatasetFamilyProfile` registry (the SSOT backend port).
 *
 * Each family is ONE profile object; every family-conditional behavior resolves
 * from here. The profile bodies delegate to family-AGNOSTIC leaves this layer
 * owns (`harness-spec.ts`, `pro-env-prefix.ts`, `pro-dataset-shape.ts`,
 * `pro-box-setup.ts`) plus the two harness engines, so Verified/Live/Pro behavior
 * is byte-identical — T4 only consolidates the scattered family string-compares
 * into one keyed lookup.
 *
 * aug-22 HIGH-4 — DIRECTION. This module used to import `buildProEnvPrefix`,
 * `assertProDatasetShape`, `resolveSwebenchPipSpec`/`Namespace` back OUT of
 * `remote/box-session*`, i.e. from its own consumers. The refactor had split
 * family-agnostic bodies out so the registry could wrap them, but nothing
 * re-routed: the consumers kept their raw `=== "pro"` / `=== "live"` branches and
 * the `remoteEnv` / `preflight` ports had ZERO production callers. The bodies now
 * live in profile-owned leaves and the consumers call the profile.
 *
 * Adding a family = one token in `DATASET_FAMILIES` + one profile object here.
 * Nothing else — executed end-to-end by `family-four-stop-rule.test.ts`.
 */
import { normalizeProRow } from "@/runner/batch/corpus/dataset"
import { type DatasetFamily, registerDatasetFamilyToken } from "../dataset-family-token"
import { evaluateWithProSwebench, type ProSwebenchOpts } from "../pro-swebench"
import { evaluateWithPythonSwebench, liveLocalGradeRefusal } from "../python-swebench"
import { stockOrLiveHarnessSpec } from "./harness-spec"
import { jsonlFamilyCorpusReader, officialJsonlCorpusReader } from "./jsonl-corpus"
import { setupProHarness } from "./pro-box-setup"
import { assertProDatasetShape } from "./pro-dataset-shape"
import { buildProEnvPrefix } from "./pro-env-prefix"
import { PROMAX_PROFILE } from "./promax"
import type { DatasetFamilyProfile, FamilyGradeEvaluator } from "./types"

/** The official-harness grade evaluator (verified/live). Delegates to the
 *  swebench harness; opts pass through unchanged EXCEPT that the profile's own
 *  TYPED family is stamped onto them (aug-22 HIGH-1) so the harness's local
 *  SWE-bench-Live refusal reads the resolved config rather than ambient env. */
const officialGradeEvaluator =
  (
    family: DatasetFamily,
    localGradeRefusal?: (namespace: string | undefined) => string | undefined,
  ): FamilyGradeEvaluator =>
  (instance, patch, opts) =>
    evaluateWithPythonSwebench(instance, patch, {
      ...(opts as Parameters<typeof evaluateWithPythonSwebench>[2]),
      datasetFamily: family,
      ...(localGradeRefusal !== undefined ? { localGradeRefusal } : {}),
    })

/** The ScaleAI Pro grade evaluator. The operator-injected harness opts (proOpts)
 *  MUST win and never be overridable by a caller's per-call opts (only `signal`
 *  is forwarded from the seam) — audit R2 #4 override footgun. */
const proGradeEvaluator =
  (proOpts: ProSwebenchOpts = {}): FamilyGradeEvaluator =>
  (instance, patch, opts) =>
    evaluateWithProSwebench(instance, patch, {
      ...(typeof opts === "object" && opts !== null && "signal" in opts
        ? { signal: (opts as { signal?: AbortSignal }).signal }
        : {}),
      ...proOpts,
    })

/** No on-box bootstrap beyond the shared box image (verified/live). Not even an
 *  ssh round-trip ⇒ those bootstraps are byte-identical to pre-T4. */
const noBoxSetup = async (): Promise<void> => {}

/** ADMITS every box. The three shipped SWE families grade on the shared box
 *  image, so there is nothing for them to refuse — and admission issues no
 *  command, so their provisioning sequence is byte-identical. */
const admitsAnyBox = (): void => {}

const VERIFIED_PROFILE: DatasetFamilyProfile = {
  family: "verified",
  reportPartitionKey: "verified",
  gradesWithProHarness: false,
  // The official JSONL format, identity row normalization.
  readCorpus: officialJsonlCorpusReader,
  gradeEvaluator: () => officialGradeEvaluator("verified"),
  harnessSpec: (input) => stockOrLiveHarnessSpec(false, input),
  onBoxEnvPrefix: () => "",
  admitBox: admitsAnyBox,
  setupBox: noBoxSetup,
  preflight: () => {},
}

const LIVE_PROFILE: DatasetFamilyProfile = {
  family: "live",
  reportPartitionKey: "live",
  defaultDatasetName: "SWE-bench-Live/SWE-bench-Live",
  gradesWithProHarness: false,
  readCorpus: officialJsonlCorpusReader,
  // The LOCAL-grade guard travels WITH the profile (aug-22 HIGH-4): a host that
  // has neither the Live harness fork nor amd64 `starryzhang` images must refuse
  // loudly rather than KeyError. python-swebench.ts no longer knows what "live" is.
  gradeEvaluator: () => officialGradeEvaluator("live", liveLocalGradeRefusal),
  // The Live FORK + `starryzhang` images, regardless of what the dataset is
  // NAMED — the full-remote path ships a local JSONL path, not the HF id, so
  // keying only off the name made the fix inert (audit r2 BUG#1).
  harnessSpec: (input) => stockOrLiveHarnessSpec(true, input),
  onBoxEnvPrefix: () => "",
  admitBox: admitsAnyBox,
  setupBox: noBoxSetup,
  preflight: () => {},
}

const PRO_PROFILE: DatasetFamilyProfile = {
  family: "pro",
  // NEVER merged with `promax` (packet invariant 1) — different corpus,
  // evaluator, images and result semantics.
  reportPartitionKey: "pro",
  verifierLabel: "ScaleAI SWE-bench Pro harness",
  // Remote Pro spans Python, Go, JS and TS while the strict remote box proves
  // only Pyright, so the LSP-optional baseline is the honest default when the
  // operator chose no preset. Explicit selections still win (preset.ts).
  remoteDefaultPreset: "agentless-v1",
  gradesWithProHarness: true,
  // Pro rows ship lowercase `fail_to_pass` / `pass_to_pass`; without the
  // normalizer they degrade to the `testCmd:"true"` no-op (fake-green risk).
  readCorpus: jsonlFamilyCorpusReader(normalizeProRow),
  gradeEvaluator: (proOpts) => proGradeEvaluator(proOpts ?? {}),
  // Pro grades on the stock swebench build + namespace (its own Scale harness /
  // venv does the docker work), so the derivations agree with Verified — the
  // Pro-specific wiring is the on-box env prefix + bootstrap, not the pip-spec.
  harnessSpec: (input) => stockOrLiveHarnessSpec(false, input),
  onBoxEnvPrefix: (input) => buildProEnvPrefix(input.env, input.datasetPath),
  admitBox: admitsAnyBox,
  setupBox: setupProHarness,
  preflight: (input) =>
    assertProDatasetShape({
      rows: input.readRows(),
      ...(input.instanceIds !== undefined ? { instanceIds: input.instanceIds } : {}),
      surface: input.surface,
    }),
}

/** The BUILT-IN profiles, keyed by the CLOSED family union. `Record<DatasetFamily, …>`
 *  makes a new family a COMPILE error until it is registered here (exhaustive). */
export const DATASET_FAMILY_PROFILES: Readonly<Record<DatasetFamily, DatasetFamilyProfile>> = {
  verified: VERIFIED_PROFILE,
  live: LIVE_PROFILE,
  pro: PRO_PROFILE,
  // PMX-01 — ProMax is registered exactly HERE and nowhere else. It is a SWE
  // dataset family, never a benchmark suite, and never an alias of `pro`.
  promax: PROMAX_PROFILE,
}

/** The live registry. Seeded from the exhaustive built-in Record above (so the
 *  compile-time completeness guarantee is unchanged) and extensible at runtime
 *  through {@link registerDatasetFamilyProfile}. */
const REGISTRY = new Map<string, DatasetFamilyProfile>(Object.entries(DATASET_FAMILY_PROFILES))

/** Report partitions currently CLAIMED, so two families can never aggregate into
 *  one leaderboard row (packet invariant 1: `pro` and `promax` never share a
 *  report partition). Seeded from the built-ins, which the drift guard below
 *  proves are already distinct. */
const CLAIMED_PARTITIONS = new Map<string, string>()
for (const profile of Object.values(DATASET_FAMILY_PROFILES)) {
  const owner = CLAIMED_PARTITIONS.get(profile.reportPartitionKey)
  if (owner !== undefined) {
    // A built-in collision is a BUILD error, surfaced the moment this module is
    // imported rather than as two campaigns quietly summed together.
    throw new Error(
      `bench: dataset families "${owner}" and "${profile.family}" both claim report partition ` +
        `"${profile.reportPartitionKey}". Every family must partition separately.`,
    )
  }
  CLAIMED_PARTITIONS.set(profile.reportPartitionKey, profile.family)
}

/**
 * The registry's ONE extension point: add a family's profile (and, in the same
 * call, its selector token, so `--dataset-family <new>` parses through the single
 * `normalizeDatasetFamilyToken` owner). This is what makes the T4 stop rule
 * checkable rather than merely asserted — `family-four-stop-rule.test.ts`
 * registers a synthetic family #4 through this call and NOTHING else, then drives
 * the real production entry point of every family-conditional layer.
 *
 * Fail-closed: re-registering an already-known family THROWS rather than silently
 * swapping behavior out from under an in-flight run. Returns a disposer that
 * removes both the profile and the token.
 */
export const registerDatasetFamilyProfile = (profile: DatasetFamilyProfile): (() => void) => {
  if (REGISTRY.has(profile.family)) {
    throw new Error(
      `bench: dataset family "${profile.family}" is already registered. ` +
        "REFUSING to replace a live family profile — pick a distinct family name.",
    )
  }
  // PMX-01 — the report partition is an EXCLUSIVE claim. Two families sharing one
  // key would merge campaigns with different corpora, evaluators and result
  // semantics into a single leaderboard row, which is precisely what packet
  // invariant 1 forbids for `pro` / `promax`.
  const partitionOwner = CLAIMED_PARTITIONS.get(profile.reportPartitionKey)
  if (partitionOwner !== undefined) {
    throw new Error(
      `bench: dataset family "${profile.family}" claims report partition ` +
        `"${profile.reportPartitionKey}", which is already owned by "${partitionOwner}". ` +
        "REFUSING — two families that share a report partition silently merge two different " +
        "corpora/evaluators into one score.",
    )
  }
  // PMX-04 — the two box-grade ports are ONE decision in two fields. A family
  // that grades in its own grader phase writes a PATCH-GEN-ONLY bench report, in
  // which every instance is an explicit "harness not wired" infra error by
  // construction — so without the second port its verdicts have no honest source
  // at all.
  //
  // Checked HERE because registration is the earliest reachable moment and costs
  // nothing. Discovering it later means the box was already provisioned, the
  // agent already ran, and the ANSWER KEY was already materialized before the
  // refusal — the same "guard that fires after the spend" shape that made
  // `admitBox` a separate port from `setupBox` in the first place.
  if (profile.boxGrade !== undefined && profile.parseBoxGradeVerdicts === undefined) {
    throw new Error(
      `bench: dataset family "${profile.family}" declares \`boxGrade\` but no ` +
        "`parseBoxGradeVerdicts`. REFUSING — a family that grades in its own grader phase runs " +
        "patch-gen with its grading shim OFF, so its bench report records every instance as an " +
        "infra error by construction and carries no verdict this run could read. Declare both " +
        "ports, or neither.",
    )
  }
  REGISTRY.set(profile.family, profile)
  CLAIMED_PARTITIONS.set(profile.reportPartitionKey, profile.family)
  const dropToken = registerDatasetFamilyToken(profile.family)
  return () => {
    REGISTRY.delete(profile.family)
    CLAIMED_PARTITIONS.delete(profile.reportPartitionKey)
    dropToken()
  }
}

/** Resolve the ONE profile for a family. Keyed lookup — the caller reads
 *  `.readCorpus` / `.gradeEvaluator` / `.harnessSpec` / `.onBoxEnvPrefix` /
 *  `.setupBox` / `.preflight`, never a raw family string-compare. */
export const resolveDatasetFamilyProfile = (family: DatasetFamily): DatasetFamilyProfile => {
  const profile = REGISTRY.get(family)
  if (profile === undefined) {
    throw new Error(
      `bench: no DatasetFamilyProfile registered for dataset family "${family}". ` +
        "REFUSING to fall back to Verified — that silently mis-grades.",
    )
  }
  return profile
}
