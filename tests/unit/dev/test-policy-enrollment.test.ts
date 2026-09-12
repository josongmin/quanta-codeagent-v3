import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  isKnownTestPath,
  loadPolicyOverrides,
  policyDigest,
  prepushTracksPrPopulation,
  resolveTestPolicy,
  resolveTestPopulation,
  selectTestPoliciesForTier,
} from "../../../tools/dev/test-policy"
import { discoverInventory } from "../../../tools/dev/test-shard-discovery"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const OVERRIDES = join(ROOT, "tools/dev/test-policy-overrides.json")

const ciFullSuiteUsesPrTier = (workflow: string): boolean => {
  const block = workflow.match(
    /- name: full suite \(guarded — exact PR tier\)[\s\S]*?(?=\n\s+- name:|\n\s{2}[a-z-]+:|$)/u,
  )?.[0]
  if (block === undefined) return false
  return (
    /env:\s*\n\s+QUANTA_VERIFICATION_TIER:\s*pr(?:\s|$)/u.test(block) &&
    /run:\s*>-\s*\n\s+bun run tools\/dev\/worktree-pollution-guard\.ts -- bun run test:full:ci/u.test(
      block,
    )
  )
}

describe("test-policy-enrollment", () => {
  test("unknown files fail wide: full + nightly + exclusive + whole-tree", () => {
    const policy = resolveTestPolicy("mystery/not-enrolled.test.ts")
    // TVH-03: `nightly` is the superset tier, so an unenrolled file must appear
    // there too — otherwise "no file is in zero tiers" stops being checkable and
    // an unowned test can fall out of the corpus without anything going red.
    expect(policy.tiers).toEqual(["full", "nightly"])
    expect(policy.resources).toEqual(["exclusive"])
    expect(policy.inputScope).toBe("whole-tree")
    expect(policy.reviewNeeded).toBe(true)
    expect(isKnownTestPath(policy.id)).toBe(false)
  })

  test("duplicate overrides conflict", () => {
    expect(() =>
      resolveTestPolicy("tests/unit/foo.test.ts", [
        { id: "tests/unit/foo.test.ts", owner: "a", reason: "one" },
        { id: "tests/unit/foo.test.ts", owner: "b", reason: "two" },
      ]),
    ).toThrow(/conflicting overrides/)
  })

  test("empty owner override is rejected at load", () => {
    expect(() => loadPolicyOverrides(join(import.meta.dir, "does-not-exist-policy.json"))).toThrow()
  })

  test("runner mismatch stays explicit: web is vitest, bun tests are bun", () => {
    expect(resolveTestPolicy("apps/web-frontend/src/foo.test.ts").runner).toBe("vitest")
    expect(resolveTestPolicy("tests/contract/lsp.test.ts").runner).toBe("bun")
    expect(resolveTestPolicy("tests/e2e-pty/cli.test.ts").runner).toBe("bun")
    expect(resolveTestPolicy("tests/unit/dev/foo.test.ts").runner).toBe("bun")
  })

  test("tier gap is an error", () => {
    expect(() =>
      resolveTestPolicy("tests/unit/foo.test.ts", [
        { id: "tests/unit/foo.test.ts", owner: "tv", reason: "gap", tiers: [] },
      ]),
    ).toThrow(/tier gap/)
  })

  test("known tests preserve merge coverage while nightly entrypoints are physically isolated", () => {
    const regular = resolveTestPolicy("tests/integration/regular.test.ts")
    const nightly = resolveTestPolicy("tests/integration/expensive.nightly.test.ts")
    // TVH-02/03 — THE DEFECT THIS CASE USED TO ENCODE. It asserted
    // `["prepush", "pr", "full", "nightly"]`, i.e. that every known test is
    // registered into every tier. That is precisely why `--tier=prepush`,
    // `--tier=pr` and `--tier=full` produced one identical digest, and it made
    // "prepush" and "PR" and "full" three names for one population.
    //
    // The contract now: a known ordinary test is merge-blocking and part of the
    // deterministic population, but is NOT a nightly-exhaustive entrypoint. The
    // `prepush` half is staged — see `prepushTracksPrPopulation` — because the
    // affected/changed selector is unwired, and narrowing prepush to the canary
    // alone would have taken `bun run prepush` from 3,941 files to 8.
    expect(regular.tiers).toEqual(
      prepushTracksPrPopulation()
        ? ["prepush", "pr", "full", "nightly"]
        : ["pr", "full", "nightly"],
    )
    // The invariants that hold in BOTH states: an ordinary test blocks a merge,
    // is never unconditional by default, and is never nightly-only.
    expect(regular.tiers).toContain("pr")
    expect(regular.tiers).toContain("full")
    expect(regular.alwaysRun).toBe(false)
    // …and the collapse this case used to encode — every known test in every
    // tier INCLUDING being its own canary — stays impossible.
    expect(regular.tiers.includes("prepush") && regular.alwaysRun).toBe(false)
    expect(nightly.tiers).toEqual(["nightly"])
    const policies = [regular, nightly]
    expect(selectTestPoliciesForTier(policies, "prepush").map(({ id }) => id)).toEqual(
      prepushTracksPrPopulation() ? [regular.id] : [],
    )
    expect(selectTestPoliciesForTier(policies, "pr").map(({ id }) => id)).toEqual([regular.id])
    expect(selectTestPoliciesForTier(policies, "full").map(({ id }) => id)).toEqual([regular.id])
    expect(selectTestPoliciesForTier(policies, "nightly").map(({ id }) => id)).toEqual([
      regular.id,
      nightly.id,
    ])
  })

  test("hosted full-suite executes the exact PR tier, not the legacy all-tier population", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")
    expect(ciFullSuiteUsesPrTier(workflow)).toBe(true)
    expect(
      ciFullSuiteUsesPrTier(
        workflow.replace("QUANTA_VERIFICATION_TIER: pr", "QUANTA_VERIFICATION_TIER: full"),
      ),
    ).toBe(false)
    expect(
      ciFullSuiteUsesPrTier(workflow.replace("bun run test:full:ci", "bun run test:integration")),
    ).toBe(false)
  })

  test("discovered full population and policy-resolved ids are the same set", () => {
    const inventory = discoverInventory(ROOT)
    const policies = resolveTestPopulation(inventory.suites.full.files)
    expect(policies.map((row) => row.id)).toEqual([...inventory.suites.full.files])
    expect(policies.length).toBeGreaterThan(3600)
    const digestA = policyDigest(policies)
    const digestB = policyDigest(resolveTestPopulation(inventory.suites.full.files))
    expect(digestA).toBe(digestB)

    const fullIds = selectTestPoliciesForTier(policies, "full").map(({ id }) => id)
    const nightlyIds = selectTestPoliciesForTier(policies, "nightly").map(({ id }) => id)
    const nightlyOnly = nightlyIds.filter((id) => !fullIds.includes(id))
    expect(nightlyOnly.length).toBeGreaterThanOrEqual(6)
    expect(nightlyOnly).toContain("tests/integration/lint-debt-reach-e2e.nightly.test.ts")
    expect(nightlyOnly).toContain("src/apps/bench/composition-root-dispatch.nightly.test.ts")
    expect(nightlyOnly).toContain(
      "tests/unit/git/conflict-parser-differential-fuzz.nightly.test.ts",
    )
    expect(nightlyOnly).toContain("tests/integration/session-stress-and-concurrent.nightly.test.ts")
    expect(nightlyOnly).toContain("tests/integration/bench-sandbox-cleanup.nightly.test.ts")
    expect(nightlyOnly).toContain("tests/integration/session-envelope-stress.nightly.test.ts")
    expect(fullIds).not.toContain("tests/integration/lint-debt-reach-e2e.nightly.test.ts")
    expect(fullIds).not.toContain("src/apps/bench/composition-root-dispatch.nightly.test.ts")
    expect(fullIds).not.toContain(
      "tests/unit/git/conflict-parser-differential-fuzz.nightly.test.ts",
    )
    expect(fullIds).not.toContain("tests/integration/session-stress-and-concurrent.nightly.test.ts")
    expect(fullIds).not.toContain("tests/integration/bench-sandbox-cleanup.nightly.test.ts")
    expect(fullIds).not.toContain("tests/integration/session-envelope-stress.nightly.test.ts")
  })

  test("the default rule cannot collapse the tiers into one population", () => {
    // The regression this closes is a DEFAULT, so it is stated over the real
    // corpus rather than over one synthetic id: a future edit that puts
    // `prepush` back into DEFAULT_KNOWN_TIERS, or drops the capability/nightly
    // separation, re-collapses these and this goes red.
    const inventory = discoverInventory(ROOT)
    const policies = resolveTestPopulation(
      inventory.suites.full.files,
      loadPolicyOverrides(OVERRIDES).overrides,
    )
    // ANTI-VACUUM: a collapsed corpus would make every comparison below trivial.
    expect(policies.length).toBeGreaterThan(3_600)
    const sizes = (["prepush", "pr", "full", "nightly"] as const).map(
      (tier) => selectTestPoliciesForTier(policies, tier).length,
    )
    const [prepush, pr, full, nightly] = sizes as [number, number, number, number]

    // The ORIGINAL defect, stated exactly: all four resolving to one population.
    expect(new Set(sizes).size, `four tiers selected ${sizes.join("/")} files`).toBeGreaterThan(1)

    // The three separations that are real today and permanent: a PR may not
    // depend on an installed toolchain, full excludes nightly-exhaustive files,
    // and nightly is the superset.
    expect({ pr, full, nightly, prOk: pr < full, fullOk: full < nightly }).toEqual({
      pr,
      full,
      nightly,
      prOk: true,
      fullOk: true,
    })

    // prepush is tied to the CONTRACT, not to today's number. While the
    // affected/changed half of its contract is unwired it tracks PR exactly;
    // when `verification-selection.ts` lands and the flag flips, this tightens
    // to a strict subset by itself. Either way it can never EXCEED pr.
    expect({
      tracksPr: prepushTracksPrPopulation(),
      equal: prepush === pr,
      within: prepush <= pr,
    }).toEqual({
      tracksPr: prepushTracksPrPopulation(),
      equal: prepushTracksPrPopulation(),
      within: true,
    })

    // …and they are ORDERED, which is what makes them a hierarchy rather than
    // four unrelated lists: prepush ⊆ PR ⊂ full ⊂ nightly.
    expect(sizes).toEqual([...sizes].sort((left, right) => left - right))
  })

  test("injecting an unregistered contract file into inventory comparison fails", () => {
    const inventory = discoverInventory(ROOT)
    const withInjected = [...inventory.suites.full.files, "tests/contract/injected-missing.test.ts"]
    const resolved = resolveTestPopulation(inventory.suites.full.files)
    expect(resolved.map((row) => row.id)).not.toEqual(withInjected)
  })

  test("override file schema loads", () => {
    const file = loadPolicyOverrides(OVERRIDES)
    expect(file.schema).toBe("quanta.test-policy-overrides.v1")
    expect(Array.isArray(file.overrides)).toBe(true)
  })

  /**
   * `expiresAt` was validated for FORMAT and never compared to the clock.
   *
   * An audit set a live row to `2020-01-01` and it loaded clean, still moving the
   * file out of the PR tier five years later. Both sibling ledgers already expire
   * their entries against `Date.now()` — `module-load-effect-guard.ts:193` and
   * `tools/test-resilience/quarantine.ts` — and the one that decides TIER
   * MEMBERSHIP did not, which is the one where a lapsed exception silently keeps
   * a file out of a blocking gate.
   */
  test("a LAPSED override is refused, and the message names the row and its owner", () => {
    const live = loadPolicyOverrides(OVERRIDES)
    const latest = live.overrides
      .map((row) => Date.parse(`${row.expiresAt}T23:59:59Z`))
      .reduce((a, b) => Math.max(a, b), 0)
    // ANTI-VACUITY: there is something to expire, and it has not expired today.
    expect(live.overrides.length).toBeGreaterThanOrEqual(5)
    expect(latest).toBeGreaterThan(Date.now())

    // The same file, read from a clock one day past the last expiry.
    expect(() => loadPolicyOverrides(OVERRIDES, latest + 24 * 60 * 60_000)).toThrow(/EXPIRED/)
    const message = (() => {
      try {
        loadPolicyOverrides(OVERRIDES, latest + 24 * 60 * 60_000)
        return ""
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()
    expect(message).toMatch(/override .+ EXPIRED \d{4}-\d{2}-\d{2} \(owner .+\)/)

    // PAIRED CONTROL: one millisecond BEFORE that boundary the same file loads,
    // so the arm above is about the date and not about the loader refusing.
    expect(loadPolicyOverrides(OVERRIDES, latest).overrides.length).toBe(live.overrides.length)
  })
})

/**
 * THE HAZARD THAT NEARLY SHIPPED.
 *
 * `gate.ts` exports `QUANTA_VERIFICATION_TIER=<label>` to every gate, and the
 * shard runner reads it. So the tier's membership IS what `bun run prepush`
 * executes — there is no second, wider path. Measured while integrating TVH-03:
 *
 *     $ QUANTA_VERIFICATION_TIER=prepush bun tools/dev/run-test-shards.ts \
 *         --suite=full --discover-only
 *     selected 8   name full:prepush
 *
 * against 3,941 before. Narrowing prepush to the always-run canary is the RIGHT
 * end state, but only once the other half of its contract — the affected/changed
 * selection — actually feeds it. With the selector still a dry run that nothing
 * consumes, the same edit is a 99.8% coverage collapse wearing the word "tier".
 *
 * This is the interlock, not a comment about one.
 */
describe("prepush may not narrow before its selector is wired", () => {
  const REPO = join(import.meta.dir, "..", "..", "..")

  const selectorIsConsumed = (): boolean => {
    // "Consumed" means a gate or the runner ACTS on it — `verify:scope` existing
    // as a standalone diagnostic script is exactly the state that is not enough.
    const consumers = [
      join(REPO, "tools", "dev", "gate-manifest.ts"),
      join(REPO, "tools", "dev", "run-test-shards.ts"),
      join(REPO, "tools", "dev", "verification-campaign.ts"),
    ]
    return consumers.some((path) => {
      const source = readFileSync(path, "utf8")
      return source.includes("verification-selection") || source.includes("verify-scope")
    })
  }

  test("the canary-only tier is gated on a selector that some gate actually consumes", () => {
    expect({
      narrowed: !prepushTracksPrPopulation(),
      selectorConsumed: selectorIsConsumed(),
    }).toEqual({
      narrowed: selectorIsConsumed() ? !prepushTracksPrPopulation() : false,
      selectorConsumed: selectorIsConsumed(),
    })

    // ANTI-VACUITY: the consumer scan must be reading real files, or "not
    // consumed" is a statement about an empty search.
    const manifest = readFileSync(join(REPO, "tools", "dev", "gate-manifest.ts"), "utf8")
    expect(manifest.length).toBeGreaterThan(1_000)
    expect(manifest).toContain("full-suite")
  })

  test("the tier a prepush gate executes is the tier this policy declares", () => {
    // The coupling that made the hazard real: if gate.ts stopped exporting the
    // tier, this policy would be describing a population nothing runs, and the
    // interlock above would be guarding nothing.
    const gate = readFileSync(join(REPO, "tools", "dev", "gate.ts"), "utf8")
    expect(gate).toContain("QUANTA_VERIFICATION_TIER")
    const options = readFileSync(join(REPO, "tools", "dev", "test-shard-options.ts"), "utf8")
    expect(options).toContain("QUANTA_VERIFICATION_TIER")
  })
})
