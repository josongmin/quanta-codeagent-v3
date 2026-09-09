import { policyDigest, resolveTestPopulation, type TestPolicyOverride } from "./test-policy"
import type { VerificationTier } from "./verification-result"

export type SelectionMode = "base-head" | "working" | "staged"

export type FullFallbackReason =
  | "package-or-lock"
  | "tsconfig-or-bunfig"
  | "missing-base"
  | "git-failure"
  | "unsupported-edge"
  | "unknown-change"

export interface SelectionPlan {
  readonly schema: "quanta.verification-selection.v1"
  readonly tier: VerificationTier
  readonly baseSha: string
  readonly headSha: string
  readonly snapshotDigest: string
  readonly policyDigest: string
  readonly populationDigest: string
  readonly selected: readonly { readonly id: string; readonly reasons: readonly string[] }[]
  readonly notSelected: readonly { readonly id: string; readonly reason: string }[]
  readonly fallback: { readonly scope: "none" | "full"; readonly reasons: readonly string[] }
}

const FULL_FALLBACK =
  /(?:^|\/)(?:package\.json|bun\.lock|bun\.lockb|bunfig\.toml|tsconfig.*\.json|tests\/preload.*)$|tools\/dev\/(?:run-test-shards|test-shard-plan|gate(?:-manifest)?|verify-scope)\.ts$/

const UNSUPPORTED_EDGE = /\.(?:wasm|so|dylib|node)$/

const digestOf = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

export const parseNameStatusZ = (
  payload: string,
): readonly { readonly status: string; readonly paths: readonly string[] }[] => {
  const records: { status: string; paths: string[] }[] = []
  const parts = payload.split("\0").filter((part) => part !== "")
  for (let index = 0; index < parts.length; ) {
    const status = parts[index] ?? ""
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[index + 1]
      const to = parts[index + 2]
      if (from === undefined || to === undefined) throw new Error("truncated rename/copy status")
      records.push({ status, paths: [from, to] })
      index += 3
      continue
    }
    const path = parts[index + 1]
    if (path === undefined) throw new Error("truncated name-status record")
    records.push({ status, paths: [path] })
    index += 2
  }
  return records
}

export const fallbackReasonForPath = (path: string): FullFallbackReason | undefined => {
  if (FULL_FALLBACK.test(path)) {
    return /(?:package\.json|bun\.lock)/.test(path) ? "package-or-lock" : "tsconfig-or-bunfig"
  }
  return undefined
}

export const changedPathsFromRecords = (
  records: readonly { readonly status: string; readonly paths: readonly string[] }[],
): readonly string[] => [...new Set(records.flatMap((record) => record.paths))]

export const deriveVerificationSelection = (input: {
  readonly tier: VerificationTier
  readonly mode: SelectionMode
  readonly baseSha: string
  readonly headSha: string
  readonly population: readonly string[]
  readonly changedPaths: readonly string[]
  readonly selectedIds?: readonly string[]
  readonly gitOk?: boolean
  readonly overrides?: readonly TestPolicyOverride[]
}): SelectionPlan => {
  const policies = resolveTestPopulation(input.population, input.overrides ?? [])
  const policyById = new Map(policies.map((row) => [row.id, row]))
  const digests = {
    snapshotDigest: digestOf([...input.changedPaths].sort()),
    policyDigest: policyDigest(policies),
    populationDigest: digestOf([...input.population].sort()),
  }
  if (input.gitOk === false || input.baseSha === "") {
    return {
      schema: "quanta.verification-selection.v1",
      tier: input.tier,
      baseSha: input.baseSha,
      headSha: input.headSha,
      ...digests,
      selected: [],
      notSelected: input.population.map((id) => ({ id, reason: "full-required" })),
      fallback: {
        scope: "full",
        reasons: [input.gitOk === false ? "git-failure" : "missing-base"],
      },
    }
  }
  const fallbackReasons = [
    ...new Set([
      ...input.changedPaths
        .map(fallbackReasonForPath)
        .filter((reason): reason is FullFallbackReason => reason !== undefined),
      ...(input.changedPaths.some((path) => UNSUPPORTED_EDGE.test(path))
        ? (["unsupported-edge"] as const)
        : []),
    ]),
  ]
  if (fallbackReasons.length > 0) {
    return {
      schema: "quanta.verification-selection.v1",
      tier: input.tier,
      baseSha: input.baseSha,
      headSha: input.headSha,
      ...digests,
      selected: input.population.map((id) => ({ id, reasons: ["fallback-full"] })),
      notSelected: [],
      fallback: { scope: "full", reasons: fallbackReasons },
    }
  }
  const alwaysRun = new Set(policies.filter((row) => row.alwaysRun).map((row) => row.id))
  const selectedSet = new Set([
    ...(input.selectedIds ?? input.changedPaths.filter((path) => path.endsWith(".test.ts"))),
    ...alwaysRun,
  ])
  const selected = input.population
    .filter((id) => selectedSet.has(id))
    .map((id) => {
      const reasons = ["changed-or-reachable"]
      if (alwaysRun.has(id)) reasons.push("always-run")
      if (policyById.get(id)?.runner === "vitest") reasons.push("vitest-runner")
      return { id, reasons }
    })
  const notSelected = input.population
    .filter((id) => !selectedSet.has(id))
    .map((id) => ({
      id,
      reason: policyById.get(id)?.runner === "vitest" ? "vitest-not-affected" : "not-affected",
    }))
  return {
    schema: "quanta.verification-selection.v1",
    tier: input.tier,
    baseSha: input.baseSha,
    headSha: input.headSha,
    ...digests,
    selected,
    notSelected,
    fallback: { scope: "none", reasons: [] },
  }
}
