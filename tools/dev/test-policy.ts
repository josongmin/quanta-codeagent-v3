import { readFileSync } from "node:fs"
import { type CapabilityLane, capabilityMembershipFor } from "./test-capability-manifest"
import { policyTestResources } from "./test-resource-resolution"
import type { VerificationTier } from "./verification-result"

export type TestCost = "small" | "medium" | "large"
export type InputScope = "whole-tree" | "declared"
export type TestRunnerKind = "bun" | "vitest" | "external"

export interface TestPolicy {
  readonly id: string
  readonly runner: TestRunnerKind
  readonly tiers: readonly VerificationTier[]
  readonly cost: TestCost
  readonly resources: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly inputScope: InputScope
  readonly owner: string
  readonly alwaysRun: boolean
  readonly reviewNeeded: boolean
  /** Which population this file belongs to. Drives tier accounting reasons. */
  readonly class: TestPolicyClass
  /** Set only for `class: "capability"`. */
  readonly capabilityGroup?: string
  readonly capabilityLane?: CapabilityLane
}

export interface TestPolicyOverride {
  readonly id: string
  readonly reason: string
  readonly owner: string
  readonly expiresAt?: string
  readonly runner?: TestRunnerKind
  readonly tiers?: readonly VerificationTier[]
  readonly cost?: TestCost
  readonly resources?: readonly string[]
  readonly requiredCapabilities?: readonly string[]
  readonly inputScope?: InputScope
  readonly alwaysRun?: boolean
}

export interface TestPolicyFile {
  readonly schema: "quanta.test-policy-overrides.v1"
  readonly overrides: readonly TestPolicyOverride[]
}

/**
 * TIER MEMBERSHIP — what each tier NAME buys.
 *
 * # The defect this replaces
 *
 * `DEFAULT_KNOWN_TIERS` used to be `["prepush", "pr", "full", "nightly"]`, i.e.
 * every known test was auto-registered into every tier. MEASURED at this HEAD,
 * `run-test-shards.ts --suite=full --tier=<t> --discover-only`:
 *
 *     prepush  3937 files  digest 8dfb795621029afa
 *     pr       3937 files  digest 8dfb795621029afa
 *     full     3937 files  digest 8dfb795621029afa
 *     nightly  3943 files  digest 88835b86a44f19b5
 *
 * Three tier names, one population, one digest. "PR is the merge-blocking
 * deterministic set" and "full is everything" were the same sentence, so the
 * capability lane could be split by COMMAND (`test:real-toolchain`) while the
 * 17 lane files stayed in ordinary membership and got loaded twice.
 *
 * # The contract now
 *
 *   nightly  the whole discovered universe. Deterministic-exhaustive files AND
 *            every capability group, fanned out into per-capability jobs. It is
 *            the only tier that is a superset of all others, which is what makes
 *            "no file is in zero tiers" checkable.
 *   full     the deterministic population: universe MINUS nightly-exhaustive
 *            files MINUS the capability groups whose cost is network, a live
 *            model, an upstream clone or a wall-clock budget in minutes.
 *   pr       merge-blocking deterministic: `full` MINUS every file that requires
 *            an external / local-only / paid / live capability. A PR verdict may
 *            not depend on what happens to be installed on the runner.
 *   prepush  TODAY: the same deterministic population as `pr`, because the
 *            affected/changed half of its contract (`verification-selection.ts`)
 *            is still a dry run nothing consumes. The always-run CANARY is
 *            declared and ready; see `PREPUSH_NARROWED_TO_CANARY` for why
 *            flipping to canary-only before the selection lands would be a
 *            coverage collapse rather than a smaller tier.
 *
 * # Where membership comes from
 *
 * NOT from a keyword or a path guess. Exactly three sources, all explicit:
 *
 *   1. `tools/dev/test-capability-manifest.ts` — exact member ids per group.
 *      Only `lane-gated` groups move membership, and a group may only be
 *      lane-gated when its members carry this repo's OWN lane contract (the
 *      `-real-e2e.test.ts` suffix plus the `QUANTA_REAL_TOOLCHAIN_E2E` gate that
 *      `package.json` and `gate-manifest.ts` already treat as the lane).
 *      `tests/unit/dev/test-capability-lanes.test.ts` proves that from source.
 *   2. the `.nightly.`/`.nightly-` filename convention already in the corpus
 *      (6 files), unchanged.
 *   3. `tools/dev/test-policy-overrides.json` — exact ids with owner, reason and
 *      expiry. Pattern-wide promotion is forbidden; the canary set lives here.
 */
/**
 * IS PREPUSH NARROWED YET? No, and this is why.
 *
 * The contract for `prepush` is "changed/affected + always-run canary". The
 * canary half is declared (see `alwaysRun` in `test-policy-overrides.json`); the
 * affected half is `verification-selection.ts`, which is still a dry run that no
 * gate or workflow consumes.
 *
 * Narrowing prepush to the canary alone with only half the contract in place is
 * not a smaller tier — it is a coverage collapse. Measured: `gate.ts prepush`
 * exports `QUANTA_VERIFICATION_TIER=prepush`, the shard runner reads it, and
 * `bun run prepush` would have selected **8** files instead of 3,941. The local
 * pre-push gate would have gone on printing a verdict over a universe 0.2% the
 * size of the one it claims.
 *
 * So prepush keeps the PR population until the affected-selection lands. The
 * canary is still declared and still meaningful — it is what `smoke` runs and
 * what the selection layer will union on top — it is simply not yet the whole
 * of prepush. Flip this flag in the same diff that wires the selection, not
 * before.
 */
const PREPUSH_NARROWED_TO_CANARY = false

/**
 * Does `prepush` still track the PR population?
 *
 * Exported so guards assert the CONTRACT rather than today's numbers: while this
 * is true, prepush and pr are expected to be equal and a test that demanded four
 * distinct sizes would be pinning a state the contract does not claim. When the
 * selection layer lands and the flag flips, the same guards tighten by
 * themselves.
 */
export const prepushTracksPrPopulation = (): boolean => !PREPUSH_NARROWED_TO_CANARY

const DEFAULT_KNOWN_TIERS: readonly VerificationTier[] = PREPUSH_NARROWED_TO_CANARY
  ? ["pr", "full", "nightly"]
  : ["prepush", "pr", "full", "nightly"]
/** An unenrolled file still runs somewhere, and `nightly` is the superset. */
const DEFAULT_UNKNOWN_TIERS: readonly VerificationTier[] = ["full", "nightly"]
const NIGHTLY_ONLY_TIERS: readonly VerificationTier[] = ["nightly"]
/** A capability that a provisioned runner can make deterministic. */
const PR_REQUIRED_CAPABILITY_TIERS: readonly VerificationTier[] = ["full", "nightly"]

export type TestPolicyClass =
  | "ordinary-deterministic"
  | "nightly-exhaustive"
  | "capability"
  | "unenrolled"

const capabilityTiers = (lane: CapabilityLane): readonly VerificationTier[] =>
  lane === "pr-required-deterministic" ? PR_REQUIRED_CAPABILITY_TIERS : NIGHTLY_ONLY_TIERS

const KNOWN_PREFIXES = [
  "tests/unit/",
  "tests/integration/",
  "tests/meta/",
  "tests/adversarial/",
  "tests/measurement/",
  "tests/contract/",
  "tests/e2e-pty/",
  "src/",
  "tools/",
  "apps/web-frontend/",
] as const

export const isKnownTestPath = (id: string): boolean =>
  KNOWN_PREFIXES.some((prefix) => id.startsWith(prefix) || id.startsWith(`./${prefix}`))

const pathRunner = (id: string): TestRunnerKind => {
  if (id.includes("apps/web-frontend/")) return "vitest"
  return "bun"
}

/**
 * One SOURCE-AWARE resolution, shared with the planner.
 *
 * This used to call `classifyTestResource(id, "")` with an EMPTY source, so the
 * path heuristic always won and `policy.resources` described a file nobody had
 * read. Measured: 362 of 3,962 files disagreed with what the planner computed
 * from the real source — the policy layer's `resources` field was fiction, and
 * the scheduler was not consuming it anyway.
 *
 * The three out-of-band prefixes are kept inside the shared resolver: their
 * `exclusive` marker is a statement about the COMMAND that runs them, not about
 * the file's source.
 */
const pathResources = (id: string): readonly string[] => policyTestResources(id)

/** Which population a discovered id belongs to. One decision, in one place. */
const classifyPolicy = (
  id: string,
): {
  readonly known: boolean
  readonly klass: TestPolicyClass
  readonly capability: ReturnType<typeof capabilityMembershipFor>
} => {
  const known = isKnownTestPath(id)
  if (!known) return { known, klass: "unenrolled", capability: undefined }
  if (/\.nightly(?:\.|-)/u.test(id)) {
    return { known, klass: "nightly-exhaustive", capability: undefined }
  }
  // Capability membership is DECLARED, exact-id, and only honoured for groups
  // whose members carry the lane env gate — see the manifest header.
  const capability = capabilityMembershipFor(id)
  return {
    known,
    klass: capability === undefined ? "ordinary-deterministic" : "capability",
    capability,
  }
}

const tiersForClass = (
  klass: TestPolicyClass,
  capability: ReturnType<typeof capabilityMembershipFor>,
): readonly VerificationTier[] => {
  if (klass === "nightly-exhaustive") return NIGHTLY_ONLY_TIERS
  if (klass === "unenrolled") return DEFAULT_UNKNOWN_TIERS
  if (capability !== undefined) return capabilityTiers(capability.lane)
  return DEFAULT_KNOWN_TIERS
}

const defaultPolicy = (id: string): TestPolicy => {
  const { known, klass, capability } = classifyPolicy(id)
  return {
    id,
    runner: pathRunner(id),
    tiers: tiersForClass(klass, capability),
    cost: "medium",
    resources: known ? pathResources(id) : ["exclusive"],
    // The group's declared needs, so a consumer never has to re-derive them
    // from a filename. Empty for everything else.
    requiredCapabilities: capability === undefined ? [] : [capability.groupId],
    inputScope: "whole-tree",
    owner: known ? "default-rule" : "unowned",
    alwaysRun: false,
    reviewNeeded: !known,
    class: klass,
    ...(capability === undefined
      ? {}
      : { capabilityGroup: capability.groupId, capabilityLane: capability.lane }),
  }
}

/** Everything one override row must satisfy. Throws with the offending id. */
const assertOverrideRow = (row: TestPolicyOverride, nowMs: number): void => {
  if (row.id === "" || row.owner === "" || row.reason === "") {
    throw new Error("override requires id, owner, and reason")
  }
  // A membership exception with no end date is a permanent private rule. Every
  // override here moves a file INTO or OUT OF a blocking tier, so the date is
  // the only thing that forces a re-read.
  if (row.expiresAt === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(row.expiresAt)) {
    throw new Error(`override ${row.id} needs an expiresAt of the form YYYY-MM-DD`)
  }
  // ...and the date is COMPARED to the clock. An audit found this field
  // validated for FORMAT only: `expiresAt: "2020-01-01"` loaded clean and kept
  // moving a file out of the PR tier five years later. Both sibling ledgers
  // (`module-load-effect-guard.ts`, `tools/test-resilience/quarantine.ts`)
  // already expire their entries against `Date.now()`; the one that decides
  // TIER MEMBERSHIP did not, which is the one where an expiry silently lapsing
  // removes a file from a blocking gate.
  //
  // End of day, like the sibling guard: an entry that expires today is still
  // valid today.
  const expiresAtMs = Date.parse(`${row.expiresAt}T23:59:59Z`)
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`override ${row.id} has an unparseable expiresAt ${row.expiresAt}`)
  }
  if (expiresAtMs < nowMs) {
    throw new Error(
      `override ${row.id} EXPIRED ${row.expiresAt} (owner ${row.owner}): ` +
        "re-read the exception and either renew it with a reason or delete it. " +
        "A lapsed tier override silently keeps a file out of a blocking gate.",
    )
  }
  // prepush IS the always-run canary. Letting the two drift apart would make
  // "always-run" a label rather than a membership.
  const inPrepush = row.tiers?.includes("prepush") ?? false
  if (inPrepush !== (row.alwaysRun ?? false)) {
    throw new Error(
      `override ${row.id}: prepush membership and alwaysRun must agree — prepush is the ` +
        "always-run canary, so a file in one and not the other is a contradiction",
    )
  }
  if (inPrepush && !(row.tiers ?? []).includes("pr")) {
    throw new Error(
      `override ${row.id}: a prepush canary that a PR does not also run cannot block a merge`,
    )
  }
}

export const loadPolicyOverrides = (
  path: string,
  /** Injected so a test can drive the expiry boundary without waiting for it. */
  nowMs: number = Date.now(),
): TestPolicyFile => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TestPolicyFile
  if (parsed.schema !== "quanta.test-policy-overrides.v1") {
    throw new Error(`unknown policy override schema: ${String(parsed.schema)}`)
  }
  if (!Array.isArray(parsed.overrides)) throw new Error("overrides must be an array")
  const seen = new Set<string>()
  for (const row of parsed.overrides) {
    assertOverrideRow(row, nowMs)
    if (seen.has(row.id)) throw new Error(`duplicate override: ${row.id}`)
    seen.add(row.id)
  }
  return parsed
}

export const resolveTestPolicy = (
  id: string,
  overrides: readonly TestPolicyOverride[] = [],
): TestPolicy => {
  const matches = overrides.filter((row) => row.id === id)
  if (matches.length > 1) throw new Error(`conflicting overrides for ${id}`)
  const base = defaultPolicy(id)
  const over = matches[0]
  if (over === undefined) return base
  const tiers = over.tiers ?? base.tiers
  if (tiers.length === 0) throw new Error(`tier gap: ${id}`)
  // A capability member is physically separated from the ordinary tiers by the
  // manifest; letting a hand-written override put it back into `pr` would undo
  // the split invisibly, one row at a time.
  if (base.class === "capability" && tiers.includes("pr")) {
    throw new Error(
      `override ${id} puts a capability-group member (${String(base.capabilityGroup)}) back into ` +
        "the merge-blocking PR tier. Remove it from the capability manifest instead, in a diff " +
        "that says why the capability is no longer external.",
    )
  }
  return {
    id,
    runner: over.runner ?? base.runner,
    tiers,
    cost: over.cost ?? base.cost,
    resources: over.resources ?? base.resources,
    requiredCapabilities: over.requiredCapabilities ?? base.requiredCapabilities,
    inputScope: over.inputScope ?? base.inputScope,
    owner: over.owner,
    alwaysRun: over.alwaysRun ?? base.alwaysRun,
    reviewNeeded: false,
    class: base.class,
    ...(base.capabilityGroup === undefined
      ? {}
      : { capabilityGroup: base.capabilityGroup, capabilityLane: base.capabilityLane }),
  }
}

export const resolveTestPopulation = (
  ids: readonly string[],
  overrides: readonly TestPolicyOverride[] = [],
): readonly TestPolicy[] => {
  const unique = [...new Set(ids)].sort((left, right) => left.localeCompare(right))
  return unique.map((id) => resolveTestPolicy(id, overrides))
}

export const selectTestPoliciesForTier = (
  policies: readonly TestPolicy[],
  tier: VerificationTier,
): readonly TestPolicy[] => policies.filter((policy) => policy.tiers.includes(tier))

export const policyDigest = (policies: readonly TestPolicy[]): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(policies)).digest("hex")

/* ────────────────────────────────────────────────────────────────────────── *
 *  TIER ACCOUNTING — selected + excluded must equal the universe
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Why one file is not in one tier, in the file's own terms.
 *
 * The runner previously reported a tier as a LIST OF SELECTED FILES and an
 * `excluded: []` that was hard-coded empty. So "PR runs 3,915 of 3,937" and
 * "PR runs 3,915 and the corpus is 3,915" printed identically, and a file that
 * fell out of every tier — the actual coverage loss this whole split risks —
 * was invisible from the discovery output. A reason per excluded file is what
 * makes the difference legible.
 */
export interface TierExclusion {
  readonly path: string
  readonly reason: string
}

export interface TierMembership {
  readonly tier: VerificationTier
  readonly selected: readonly string[]
  readonly excluded: readonly TierExclusion[]
  /** `selected.length + excluded.length`, which must equal the universe size. */
  readonly universe: number
}

const exclusionReason = (policy: TestPolicy, tier: VerificationTier): string => {
  switch (policy.class) {
    case "nightly-exhaustive":
      return `nightly-exhaustive (filename convention .nightly.) — runs in nightly only, not ${tier}`
    case "capability":
      return (
        `capability group ${String(policy.capabilityGroup)} ` +
        `(lane ${String(policy.capabilityLane)}) — external capability required, ` +
        `so it runs in its own fanned-out job, not in ${tier}`
      )
    case "ordinary-deterministic":
      return tier === "prepush"
        ? PREPUSH_NARROWED_TO_CANARY
          ? "not in the always-run canary; prepush selects changed/affected files plus the canary"
          : "excluded from prepush for the same reason as pr; prepush still tracks the PR population until verification-selection.ts is wired"
        : `not registered for ${tier} by tools/dev/test-policy-overrides.json`
    case "unenrolled":
      return `unenrolled path (no owner); defaults to ${DEFAULT_UNKNOWN_TIERS.join("+")}, not ${tier}`
  }
}

/**
 * Tier selection WITH its complement. Every discovered file lands in exactly
 * one of the two lists, so the caller can check the sum instead of trusting it.
 */
export const selectTierMembership = (
  policies: readonly TestPolicy[],
  tier: VerificationTier,
): TierMembership => {
  const selected: string[] = []
  const excluded: TierExclusion[] = []
  for (const policy of policies) {
    if (policy.tiers.includes(tier)) selected.push(policy.id)
    else excluded.push({ path: policy.id, reason: exclusionReason(policy, tier) })
  }
  return { tier, selected, excluded, universe: policies.length }
}

/** Throws unless `selected + excluded` reconstructs the universe EXACTLY. */
export const assertTierAccounting = (
  membership: TierMembership,
  universe: readonly string[],
): void => {
  const accounted = membership.selected.length + membership.excluded.length
  if (accounted !== universe.length) {
    throw new Error(
      `[test-policy] tier=${membership.tier} accounting is short: ` +
        `${membership.selected.length} selected + ${membership.excluded.length} excluded = ` +
        `${accounted}, but the universe holds ${universe.length}`,
    )
  }
  const seen = new Set([...membership.selected, ...membership.excluded.map((row) => row.path)])
  if (seen.size !== universe.length) {
    throw new Error(
      `[test-policy] tier=${membership.tier} accounting double-counts: ${seen.size} distinct ` +
        `ids across selected+excluded, universe ${universe.length}`,
    )
  }
  const missing = universe.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    throw new Error(
      `[test-policy] tier=${membership.tier} lost ${missing.length} discovered file(s) from both ` +
        `sides of the accounting: ${missing.slice(0, 5).join(", ")}`,
    )
  }
  const blank = membership.excluded.filter((row) => row.reason.trim() === "")
  if (blank.length > 0) {
    throw new Error(
      `[test-policy] tier=${membership.tier} excluded ${blank.length} file(s) with no reason; ` +
        "an unexplained exclusion is indistinguishable from a lost file",
    )
  }
}

/** The always-run canary: the files `prepush` runs before anything is changed. */
export const canaryPolicyIds = (policies: readonly TestPolicy[]): readonly string[] =>
  policies
    .filter((policy) => policy.alwaysRun)
    .map(({ id }) => id)
    .sort((left, right) => left.localeCompare(right))
