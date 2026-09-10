import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  isKnownTestPath,
  loadPolicyOverrides,
  policyDigest,
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
  test("unknown files fail wide: full + exclusive + whole-tree", () => {
    const policy = resolveTestPolicy("mystery/not-enrolled.test.ts")
    expect(policy.tiers).toEqual(["full"])
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
    expect(regular.tiers).toEqual(["prepush", "pr", "full", "nightly"])
    expect(nightly.tiers).toEqual(["nightly"])
    const policies = [regular, nightly]
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
    expect(nightlyOnly.length).toBeGreaterThanOrEqual(3)
    expect(nightlyOnly).toContain("tests/integration/lint-debt-reach-e2e.nightly.test.ts")
    expect(nightlyOnly).toContain("src/apps/bench/composition-root-dispatch.nightly.test.ts")
    expect(nightlyOnly).toContain(
      "tests/unit/git/conflict-parser-differential-fuzz.nightly.test.ts",
    )
    expect(nightlyOnly).toContain("tests/integration/session-stress-and-concurrent.nightly.test.ts")
    expect(fullIds).not.toContain("tests/integration/lint-debt-reach-e2e.nightly.test.ts")
    expect(fullIds).not.toContain("src/apps/bench/composition-root-dispatch.nightly.test.ts")
    expect(fullIds).not.toContain(
      "tests/unit/git/conflict-parser-differential-fuzz.nightly.test.ts",
    )
    expect(fullIds).not.toContain("tests/integration/session-stress-and-concurrent.nightly.test.ts")
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
})
