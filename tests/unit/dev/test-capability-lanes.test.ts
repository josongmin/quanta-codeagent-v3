import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  CAPABILITY_GROUPS,
  type CapabilityGroup,
  capabilityGroupFingerprint,
  capabilityMembershipFor,
  capabilityProducerFloors,
  laneGatedMemberIds,
  validateCapabilityManifest,
} from "../../../tools/dev/test-capability-manifest"
import {
  assertTierAccounting,
  canaryPolicyIds,
  loadPolicyOverrides,
  prepushTracksPrPopulation,
  resolveTestPopulation,
  selectTestPoliciesForTier,
  selectTierMembership,
  type TestPolicy,
} from "../../../tools/dev/test-policy"
import { discoverInventory } from "../../../tools/dev/test-shard-discovery"
import {
  capabilityProducers,
  REQUIRED_PRODUCERS,
  requiredProducerIds,
  validateCapabilityResult,
} from "../../../tools/dev/verification-required-producers"
import type { VerificationTier } from "../../../tools/dev/verification-result"

/**
 * TVH-03 / TVH-02 — the capability lane is a MEMBERSHIP, not a command.
 *
 * # What was measured at HEAD, before this landed
 *
 *     bun tools/dev/run-test-shards.ts --suite=full --tier=<t> --discover-only
 *
 *     tier      files  digest(16)
 *     prepush    3937  8dfb795621029afa
 *     pr         3937  8dfb795621029afa
 *     full       3937  8dfb795621029afa
 *     nightly    3943  88835b86a44f19b5
 *
 * Three tier names, ONE population, ONE digest. `DEFAULT_KNOWN_TIERS` registered
 * every known test into every tier, so the 17 `*-real-e2e.test.ts` files sat in
 * ordinary PR/full membership AND in the separate `test:real-toolchain` gate —
 * loaded twice per campaign, once env-gated to skip and once for real.
 *
 * # What this file proves
 *
 * Not "the digests differ" — that is a symptom and one `sort` away from being
 * accidentally satisfied. It proves the PARTITION: every discovered file belongs
 * to exactly one of {ordinary-deterministic, nightly-exhaustive, capability},
 * each tier's selected+excluded reconstructs the universe exactly, and no
 * capability member can reach the merge-blocking tier.
 *
 * # Why the union is stated against the LIVE universe
 *
 * A frozen copy of the pre-change file list would go stale the first time any
 * agent adds a test, and would then be "passing" about a corpus that no longer
 * exists. The invariant that actually forbids coverage loss is `nightly ==
 * universe` (set equality, both directions) plus `pr ⊆ full ⊆ nightly`: under
 * those, a file can never be excluded from every tier, whatever the corpus does.
 * The exact pre-change counts are pinned separately, as counts, below.
 */

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const TIERS: readonly VerificationTier[] = ["prepush", "pr", "full", "nightly"]

const overrides = loadPolicyOverrides(join(ROOT, "tools/dev/test-policy-overrides.json")).overrides
const inventory = discoverInventory(ROOT)
const UNIVERSE: readonly string[] = inventory.suites.full.files
const POLICIES: readonly TestPolicy[] = resolveTestPopulation(UNIVERSE, overrides)

const idsFor = (tier: VerificationTier): readonly string[] =>
  selectTestPoliciesForTier(POLICIES, tier).map(({ id }) => id)

const byClass = (klass: TestPolicy["class"]): readonly string[] =>
  POLICIES.filter((policy) => policy.class === klass).map(({ id }) => id)

/** The repo's own lane convention, read rather than invented — `package.json`'s
 *  `test:real-toolchain` selects on exactly this suffix. */
const isLaneFile = (id: string): boolean => id.endsWith("-real-e2e.test.ts")

/**
 * The PRE-CHANGE population, replayed from the OLD rule over the LIVE corpus.
 *
 * `DEFAULT_KNOWN_TIERS` used to be all four tiers for every known test, with
 * `.nightly.` files isolated. Reconstructing it here — rather than freezing a
 * 3,946-entry list — is what makes "no file the old contract ran is now unrun"
 * checkable on a corpus that other agents are still adding to.
 */
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
const preChangeOrdinary: readonly string[] = UNIVERSE.filter(
  (id) => KNOWN_PREFIXES.some((prefix) => id.startsWith(prefix)) && !/\.nightly(?:\.|-)/u.test(id),
)

describe("capability manifest is internally closed", () => {
  test("the manifest validates, and every lane-gated member carries the lane contract", () => {
    expect(validateCapabilityManifest()).toEqual([])
    // ANTI-VACUITY: an emptied manifest would make every membership assertion
    // below trivially true.
    expect(CAPABILITY_GROUPS.length).toBeGreaterThanOrEqual(10)

    // The licence to remove a file from ordinary membership is the repo's OWN
    // lane contract, proven FROM SOURCE rather than asserted: the
    // `-real-e2e.test.ts` suffix that `package.json`'s `test:real-toolchain`
    // selects on, and the `QUANTA_REAL_TOOLCHAIN_E2E` gate that
    // `gate-manifest.ts` sets. A manifest that lane-gated an ungated file would
    // delete it from PR while it still ran in the ordinary suite.
    const violations: string[] = []
    for (const member of laneGatedMemberIds()) {
      if (!member.endsWith("-real-e2e.test.ts")) {
        violations.push(`${member}: lane-gated but not a *-real-e2e.test.ts file`)
        continue
      }
      const source = readFileSync(join(ROOT, member), "utf8")
      if (!source.includes("QUANTA_REAL_TOOLCHAIN_E2E") && !source.includes("capability-lane")) {
        violations.push(`${member}: lane-gated but its source never consults the lane gate`)
      }
    }
    expect(violations).toEqual([])
  })

  test("every group rolls up into an EXISTING required producer, never a new schema", () => {
    // `tools/dev/capability-result.ts` already emits `quanta.capability-result.v1`
    // and `verification-required-producers.ts` already validates a floor against
    // it, for three coarse producers. These groups refine those; they must not
    // introduce a fourth vocabulary the aggregator cannot read.
    const known = new Set(requiredProducerIds())
    expect(known.size).toBeGreaterThanOrEqual(5)
    const withFloor = new Set(capabilityProducers().map((producer) => producer.id))
    expect(withFloor.size).toBeGreaterThanOrEqual(3)

    const unknown = CAPABILITY_GROUPS.filter((group) => !known.has(group.producer)).map(
      (group) => `${group.id}->${group.producer}`,
    )
    expect(unknown).toEqual([])

    // A group whose members were REMOVED from the ordinary tiers, or that lives
    // out of band, has nowhere else to be counted — so its producer must be one
    // that actually carries a floor. `full-suite` carries none, which is exactly
    // why only `declared-pending-gate` groups may name it.
    const unprovable = CAPABILITY_GROUPS.filter(
      (group) =>
        group.membershipAuthority !== "declared-pending-gate" && !withFloor.has(group.producer),
    ).map((group) => `${group.id}->${group.producer}`)
    expect(unprovable).toEqual([])

    // The floors this manifest declares are strictly tighter than the coarse
    // 1-file/1-case floor they refine, or the refinement buys nothing.
    const coarse = capabilityProducers().find((producer) => producer.id === "toolchain")
    expect(coarse?.capability).toBeDefined()
    const toolchainGroups = capabilityProducerFloors().filter(
      (floor) => floor.producer === "toolchain",
    )
    expect(toolchainGroups.length).toBeGreaterThanOrEqual(8)
    const totalFiles = toolchainGroups.reduce((sum, row) => sum + row.minimumExecutedFiles, 0)
    expect(totalFiles).toBeGreaterThan(coarse?.capability?.minimumExecutedFiles ?? 0)
  })

  test("every declared capability group has a non-zero executed floor", () => {
    // A group with zero executed files is RED, not PASS — case 4. Stated
    // against the EXISTING `quanta.capability-result.v1` validator rather than a
    // second one, so the floors this manifest declares are the floors CI checks.
    const floors = capabilityProducerFloors()
    expect(floors.length).toBe(CAPABILITY_GROUPS.length)
    for (const floor of floors) {
      expect(floor.minimumExecutedFiles, `${floor.id} floor`).toBeGreaterThanOrEqual(1)
      expect(floor.minimumExecutedCases, `${floor.id} floor`).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("a capability job that executed nothing is RED", () => {
  const producer = REQUIRED_PRODUCERS["pr-required"].find((row) => row.id === "toolchain")

  test("the toolchain producer carries a capability floor at all", () => {
    expect(producer).toBeDefined()
    expect(producer?.capability).toBeDefined()
  })

  test("zero executed files/cases fails; a real execution passes", () => {
    if (producer === undefined) throw new Error("toolchain producer missing")
    const zero = {
      schema: "quanta.capability-result.v1",
      producer: "toolchain",
      executedFiles: [],
      executedCases: 0,
      skippedUnsupported: 61,
      blockedMissing: 0,
      failedSetup: 0,
    }
    const verdict = validateCapabilityResult(producer, zero)
    expect(verdict.ok).toBe(false)

    // PAIRED CONTROL: the same artifact with one real execution passes, so the
    // red above is about EXECUTION and not about the artifact's shape.
    const one = { ...zero, executedFiles: ["tests/unit/x-real-e2e.test.ts"], executedCases: 1 }
    expect(validateCapabilityResult(producer, one).ok).toBe(true)

    // And the two outcomes that are failures wearing a skip's clothes.
    expect(validateCapabilityResult(producer, { ...one, blockedMissing: 1 }).ok).toBe(false)
    expect(validateCapabilityResult(producer, { ...one, failedSetup: 1 }).ok).toBe(false)
    // ABSENT is not a pass either.
    expect(validateCapabilityResult(producer, undefined).ok).toBe(false)
  })
})

describe("group fingerprint moves when the declaration moves", () => {
  test("removing a tool from a group's declared needs changes its fingerprint", () => {
    const group = CAPABILITY_GROUPS.find((row) => row.id === "lsp-rust")
    if (group === undefined) throw new Error("lsp-rust group missing")
    const before = capabilityGroupFingerprint(group)

    const withoutRustAnalyzer: CapabilityGroup = {
      ...group,
      needs: group.needs.filter((need) => need.id !== "rust-analyzer"),
    }
    expect(capabilityGroupFingerprint(withoutRustAnalyzer)).not.toBe(before)

    // Every other declared axis moves it too — a job that stopped provisioning a
    // tool, dropped a member, or lowered its floor must not reuse a receipt.
    expect(capabilityGroupFingerprint({ ...group, members: group.members.slice(1) })).not.toBe(
      before,
    )
    expect(capabilityGroupFingerprint({ ...group, minExecutedCases: 1 })).not.toBe(before)
    expect(capabilityGroupFingerprint({ ...group, lane: "nightly-heavy" })).not.toBe(before)
    // PAIRED CONTROL: reordering members is not a change of contract.
    expect(capabilityGroupFingerprint({ ...group, members: [...group.members].reverse() })).toBe(
      before,
    )
  })
})

describe("tier membership is a real partition of the discovered universe", () => {
  test("the four tiers no longer share one population", () => {
    const digests = TIERS.map((tier) =>
      new Bun.CryptoHasher("sha256").update(idsFor(tier).join("\0")).digest("hex"),
    )
    // The ORIGINAL defect stated exactly — all four resolving to one population.
    // Not "four distinct digests": while the affected/changed half of prepush's
    // contract is unwired, prepush tracks PR deliberately, and demanding four
    // would pin a state the contract does not claim.
    expect(new Set(digests).size, "the tiers must not all share one population").toBeGreaterThan(1)
    const [prepush, pr, full, nightly] = digests as [string, string, string, string]
    expect({
      prVsFull: pr === full,
      fullVsNightly: full === nightly,
      prepushVsPr: prepush === pr,
      tracksPr: prepushTracksPrPopulation(),
    }).toEqual({
      prVsFull: false,
      fullVsNightly: false,
      prepushVsPr: prepushTracksPrPopulation(),
      tracksPr: prepushTracksPrPopulation(),
    })
  })

  test("classes partition the universe: exactly one class per file, no leftovers", () => {
    const ordinary = byClass("ordinary-deterministic")
    const exhaustive = byClass("nightly-exhaustive")
    const capability = byClass("capability")
    const unenrolled = byClass("unenrolled")
    expect(ordinary.length + exhaustive.length + capability.length + unenrolled.length).toBe(
      UNIVERSE.length,
    )
    expect(new Set([...ordinary, ...exhaustive, ...capability, ...unenrolled]).size).toBe(
      UNIVERSE.length,
    )
    // DERIVED, not snapshotted. The two physically-separated populations are
    // defined by their own authorities — the `.nightly.` filename convention
    // already in the corpus, and the exact member lists in the capability
    // manifest — so these compare the classifier against those authorities
    // rather than against a number that goes stale the next time a test lands.
    expect([...exhaustive].sort()).toEqual(
      UNIVERSE.filter((id) => /\.nightly(?:\.|-)/u.test(id)).sort(),
    )
    expect([...capability].sort()).toEqual(
      laneGatedMemberIds()
        .filter((id) => UNIVERSE.includes(id))
        .sort(),
    )
    // ANTI-VACUUM: both authorities must actually name something, or the two
    // set comparisons above are `[] === []`.
    expect(exhaustive.length).toBeGreaterThanOrEqual(6)
    expect(capability.length).toBeGreaterThanOrEqual(16)
    // Everything under tests/ tools/ src/ is enrolled by the known-prefix rule,
    // so an unenrolled file in the FULL suite would be a discovery surprise.
    expect(unenrolled).toEqual([])
  })

  test("PR membership excludes every capability-lane file", () => {
    const pr = new Set(idsFor("pr"))
    const members = laneGatedMemberIds()
    // The population is the manifest's, and the manifest is proven COMPLETE
    // against the corpus by the `*-real-e2e` guard below — so this is a closed
    // universe, not a count someone typed.
    expect([...members].sort()).toEqual(UNIVERSE.filter(isLaneFile).sort())
    // ANTI-VACUUM: an emptied manifest would make the filter below vacuous.
    expect(members.length).toBeGreaterThanOrEqual(16)
    const leaked = members.filter((id) => pr.has(id))
    expect(
      leaked,
      "a merge-blocking tier must not depend on an external/local-only capability",
    ).toEqual([])
    // prepush is the canary, and a canary may not need a toolchain either.
    const prepush = new Set(idsFor("prepush"))
    expect(members.filter((id) => prepush.has(id))).toEqual([])
  })

  test("full excludes nightly-exhaustive and the nightly-heavy capability groups", () => {
    const full = new Set(idsFor("full"))
    for (const id of byClass("nightly-exhaustive")) {
      expect(full.has(id), `${id} is nightly-exhaustive and must not be in full`).toBe(false)
    }
    // The heavy arms by exact path: a real upstream clone+build, five networked
    // uv builds, a live model inference, and the native debuggers ubuntu-latest
    // does not ship.
    for (const id of [
      "tests/unit/project-env-astropy-real-e2e.test.ts",
      "tests/unit/project-env-sandbox-real-e2e.test.ts",
      "tests/unit/llm/local-preset-live-real-e2e.test.ts",
      "tests/unit/tool/debug/debugpy-real-e2e.test.ts",
    ]) {
      expect(capabilityMembershipFor(id)?.lane).toBe("nightly-heavy")
      expect(full.has(id), `${id} is nightly-heavy and must not be in full`).toBe(false)
    }
  })

  test("nightly includes every capability group and every exhaustive file", () => {
    const nightly = new Set(idsFor("nightly"))
    for (const id of laneGatedMemberIds()) {
      expect(nightly.has(id), `${id} must be fanned out by nightly`).toBe(true)
    }
    for (const id of byClass("nightly-exhaustive")) expect(nightly.has(id)).toBe(true)
  })

  test("no file is lost: nightly == universe, and pr subset of full subset of nightly", () => {
    // THE COVERAGE-PRESERVATION INVARIANT. Splitting tiers can only delete
    // coverage by dropping a file from every tier; set equality here makes that
    // impossible to do quietly.
    const nightly = idsFor("nightly")
    expect(new Set(nightly).size).toBe(nightly.length)
    expect([...nightly].sort((a, b) => a.localeCompare(b))).toEqual([...UNIVERSE])

    const pr = new Set(idsFor("pr"))
    const full = new Set(idsFor("full"))
    const nightlySet = new Set(nightly)
    expect([...pr].filter((id) => !full.has(id))).toEqual([])
    expect([...full].filter((id) => !nightlySet.has(id))).toEqual([])
    // …and the containments are STRICT, or the split did nothing.
    expect(full.size).toBeGreaterThan(pr.size)
    expect(nightlySet.size).toBeGreaterThan(full.size)
  })

  test("canary ∪ nightly == universe; canary ∩ nightly-only == 0; canary ∩ capability == 0", () => {
    const canary = canaryPolicyIds(POLICIES)
    // The canary is DECLARED, not derived: its membership is exactly the
    // `alwaysRun` rows of test-policy-overrides.json. Compared against that
    // file rather than against a count.
    const declaredCanary = overrides
      .filter((row) => row.alwaysRun === true)
      .map((row) => row.id)
      .sort((left, right) => left.localeCompare(right))
    expect([...canary]).toEqual(declaredCanary)
    // ANTI-VACUUM: an emptied overrides file would make every set operation
    // below `[] ∪ X` and `[] ∩ X`, i.e. trivially satisfied.
    expect(canary.length).toBeGreaterThanOrEqual(5)
    // The canary must be RUNNABLE by prepush. It is not yet the WHOLE of prepush:
    // the affected/changed half of that contract is unwired, so prepush tracks
    // PR. When the selection lands the two converge and the subset becomes an
    // equality by itself.
    const prepushIds = new Set(idsFor("prepush"))
    expect(canary.filter((id) => !prepushIds.has(id))).toEqual([])
    if (!prepushTracksPrPopulation()) {
      expect(canary).toEqual([...prepushIds].sort((a, b) => a.localeCompare(b)))
    }

    // UNION — no file is lost. `nightly` is the superset tier, so the union of
    // the smallest tier with it must reconstruct the whole discovered corpus.
    const union = new Set([...canary, ...idsFor("nightly")])
    expect([...union].sort((a, b) => a.localeCompare(b))).toEqual([...UNIVERSE])

    // …and against the PRE-CHANGE population specifically, replayed from the
    // old rule: every file the every-test-in-every-tier contract used to run is
    // still run by nightly. This is the property the split could silently
    // violate, and it is stated over a computed set, not a frozen list.
    const nightly = new Set(idsFor("nightly"))
    expect(preChangeOrdinary.length).toBeGreaterThan(3_600)
    expect(preChangeOrdinary.filter((id) => !nightly.has(id))).toEqual([])

    // INTERSECTION — the canary is deterministic and unconditional, so it may
    // share nothing with the two populations that are neither: the
    // nightly-EXCLUSIVE files, and the capability members.
    const pr = new Set(idsFor("pr"))
    const nightlyOnly = new Set([...nightly].filter((id) => !pr.has(id)))
    expect(nightlyOnly.size).toBeGreaterThanOrEqual(16)
    expect(canary.filter((id) => nightlyOnly.has(id))).toEqual([])
    const capability = new Set(laneGatedMemberIds())
    expect(canary.filter((id) => capability.has(id))).toEqual([])
    // Every canary is also merge-blocking: a canary a PR does not run cannot
    // block one.
    expect(canary.filter((id) => !pr.has(id))).toEqual([])
  })

  test("selected + excluded == universe, with a reason per excluded file, for every tier", () => {
    for (const tier of TIERS) {
      const membership = selectTierMembership(POLICIES, tier)
      // Throws on a short sum, a double count, a lost file, or a blank reason.
      assertTierAccounting(membership, UNIVERSE)
      expect(membership.selected.length + membership.excluded.length).toBe(UNIVERSE.length)
      for (const row of membership.excluded) {
        expect(row.reason.length, `${tier}: ${row.path} has no reason`).toBeGreaterThan(10)
      }
    }
    // The accounting must be able to FAIL: drop one file from the selection and
    // the sum no longer reconstructs the universe.
    const membership = selectTierMembership(POLICIES, "pr")
    expect(() =>
      assertTierAccounting({ ...membership, selected: membership.selected.slice(1) }, UNIVERSE),
    ).toThrow(/accounting is short/u)
    // …and a blank reason is refused rather than counted.
    expect(() =>
      assertTierAccounting(
        {
          ...membership,
          excluded: membership.excluded.map((row, index) =>
            index === 0 ? { ...row, reason: "  " } : row,
          ),
        },
        UNIVERSE,
      ),
    ).toThrow(/no reason/u)
  })
})

describe("injection: an ordinary command must not pick up a nightly-only file", () => {
  test("injecting a nightly-only file excludes it from prepush, pr and full", () => {
    const injectedNightly = "tests/integration/injected-tvh03.nightly.test.ts"
    const injectedCapability = "tests/unit/injected-tvh03-real-e2e.test.ts"
    const universe = [...UNIVERSE, injectedNightly].sort((a, b) => a.localeCompare(b))
    const policies = resolveTestPopulation(universe, overrides)

    for (const tier of ["prepush", "pr", "full"] as const) {
      const membership = selectTierMembership(policies, tier)
      assertTierAccounting(membership, universe)
      expect(membership.selected).not.toContain(injectedNightly)
      const excluded = membership.excluded.find((row) => row.path === injectedNightly)
      expect(excluded?.reason).toContain("nightly-exhaustive")
    }
    expect(selectTierMembership(policies, "nightly").selected).toContain(injectedNightly)

    // PAIRED CONTROL, the other direction: a NEW `*-real-e2e.test.ts` file that
    // the capability manifest does not declare is NOT auto-promoted out of PR.
    // Pattern-wide promotion is forbidden — the suffix forces the manifest to be
    // complete (see the guard below), it never silently moves a file by itself.
    const withCapability = resolveTestPopulation(
      [...UNIVERSE, injectedCapability].sort((a, b) => a.localeCompare(b)),
      overrides,
    )
    expect(selectTestPoliciesForTier(withCapability, "pr").map(({ id }) => id)).toContain(
      injectedCapability,
    )
  })

  test("a real-e2e file the manifest does not declare is RED, not silently promoted", () => {
    // The completeness half of the convention: every lane file in the corpus
    // must be a declared member of exactly one group. This is what stops the
    // paired control above from being a coverage hole.
    const laneFiles = UNIVERSE.filter((id) => id.endsWith("-real-e2e.test.ts"))
    // ANTI-VACUUM floor, not a pinned count: the set equality below is the
    // claim, and this only stops it from being `[] === []`.
    expect(laneFiles.length).toBeGreaterThanOrEqual(16)
    expect([...laneFiles].sort()).toEqual([...laneGatedMemberIds()].sort())
    const undeclared = laneFiles.filter((id) => capabilityMembershipFor(id) === undefined)
    expect(
      undeclared,
      "a *-real-e2e file with no capability group runs in PR while its lane also selects it",
    ).toEqual([])
  })

  test("an override cannot put a capability member back into the PR tier", () => {
    const member = laneGatedMemberIds()[0]
    if (member === undefined) throw new Error("no capability members")
    expect(() =>
      resolveTestPopulation(
        [member],
        [
          {
            id: member,
            owner: "injection",
            reason: "sneak a capability file back into the merge gate",
            expiresAt: "2099-01-01",
            tiers: ["pr", "full", "nightly"],
          },
        ],
      ),
    ).toThrow(/back into the merge-blocking PR tier/u)
  })
})

describe("the capability lane contains no self-pass", () => {
  /**
   * STRUCTURAL GUARD with an anti-vacuum floor.
   *
   * The measured defect: `local-preset-live-real-e2e.test.ts` printed
   * "documented no-server outcome, not a pass" and then executed
   * `expect(true).toBe(true)`. Bun reported `1 pass`; the junit carried a
   * passing case; `capability-result.v1` counted it as EXECUTED. Nothing
   * downstream could tell it from a host that ran a 150s inference.
   */
  const SELF_PASS = [
    /expect\(\s*true\s*\)\s*\.\s*toBe\(\s*true\s*\)/u,
    /expect\(\s*false\s*\)\s*\.\s*toBe\(\s*false\s*\)/u,
    /expect\(\s*1\s*\)\s*\.\s*toBe\(\s*1\s*\)/u,
  ]

  const laneSources = (): ReadonlyMap<string, string> => {
    const sources = new Map<string, string>()
    for (const id of laneGatedMemberIds()) {
      sources.set(
        id,
        readFileSync(join(ROOT, id), "utf8")
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/\/\/[^\n]*/gu, ""),
      )
    }
    return sources
  }

  const selfPassing = (sources: ReadonlyMap<string, string>): readonly string[] =>
    [...sources]
      .filter(([, source]) => SELF_PASS.some((pattern) => pattern.test(source)))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b))

  test("no lane file asserts a constant against itself", () => {
    const sources = laneSources()
    // ANTI-VACUUM FLOOR: the scan must have read a real corpus. A guard over an
    // empty map reports "no self-passes" forever.
    expect(sources.size).toBe(laneGatedMemberIds().length)
    expect(sources.size).toBeGreaterThanOrEqual(16)
    expect([...sources.values()].every((source) => source.length > 200)).toBe(true)

    expect(selfPassing(sources)).toEqual([])
  })

  test("RED ON INJECTION: a self-pass in any lane file is detected", () => {
    const sources = new Map(laneSources())
    const victim = laneGatedMemberIds()[0]
    if (victim === undefined) throw new Error("no capability members")
    sources.set(
      victim,
      `${sources.get(victim) ?? ""}\ntest("fake", () => { expect(true).toBe(true) })\n`,
    )
    // Same predicate, same corpus, one injected line — the guard must name the
    // exact file. A structural guard that cannot be shown going red is a comment.
    expect(selfPassing(sources)).toEqual([victim])
  })
})
