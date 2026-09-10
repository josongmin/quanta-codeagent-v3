import { readFileSync } from "node:fs"
import { classifyTestResource } from "./test-shard-plan"
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

const DEFAULT_KNOWN_TIERS: readonly VerificationTier[] = ["prepush", "pr", "full", "nightly"]
const DEFAULT_UNKNOWN_TIERS: readonly VerificationTier[] = ["full"]
const NIGHTLY_ONLY_TIERS: readonly VerificationTier[] = ["nightly"]

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

const pathResources = (id: string): readonly string[] => {
  if (id.startsWith("tests/contract/")) return ["exclusive", "docker"]
  if (id.startsWith("tests/e2e-pty/")) return ["exclusive", "pty"]
  if (id.includes("apps/web-frontend/")) return ["exclusive"]
  const classified = classifyTestResource(id, "")
  return classified === "pure" ? [] : [classified]
}

const defaultPolicy = (id: string): TestPolicy => {
  const known = isKnownTestPath(id)
  const nightlyOnly = known && /\.nightly(?:\.|-)/u.test(id)
  return {
    id,
    runner: pathRunner(id),
    tiers: nightlyOnly ? NIGHTLY_ONLY_TIERS : known ? DEFAULT_KNOWN_TIERS : DEFAULT_UNKNOWN_TIERS,
    cost: "medium",
    resources: known ? pathResources(id) : ["exclusive"],
    requiredCapabilities: [],
    inputScope: "whole-tree",
    owner: known ? "default-rule" : "unowned",
    alwaysRun: false,
    reviewNeeded: !known,
  }
}

export const loadPolicyOverrides = (path: string): TestPolicyFile => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TestPolicyFile
  if (parsed.schema !== "quanta.test-policy-overrides.v1") {
    throw new Error(`unknown policy override schema: ${String(parsed.schema)}`)
  }
  if (!Array.isArray(parsed.overrides)) throw new Error("overrides must be an array")
  const seen = new Set<string>()
  for (const row of parsed.overrides) {
    if (row.id === "" || row.owner === "" || row.reason === "") {
      throw new Error("override requires id, owner, and reason")
    }
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
