import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import {
  isKnownTestPath,
  loadPolicyOverrides,
  policyDigest,
  resolveTestPolicy,
  resolveTestPopulation,
} from "../../../tools/dev/test-policy"
import { discoverInventory } from "../../../tools/dev/test-shard-discovery"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const OVERRIDES = join(ROOT, "tools/dev/test-policy-overrides.json")

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

  test("discovered full population and policy-resolved ids are the same set", () => {
    const inventory = discoverInventory(ROOT)
    const policies = resolveTestPopulation(inventory.suites.full.files)
    expect(policies.map((row) => row.id)).toEqual([...inventory.suites.full.files])
    expect(policies.length).toBeGreaterThan(3600)
    const digestA = policyDigest(policies)
    const digestB = policyDigest(resolveTestPopulation(inventory.suites.full.files))
    expect(digestA).toBe(digestB)
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
