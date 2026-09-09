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
  /(?:^|\/)(?:package\.json|bun\.lock|bun\.lockb|bunfig\.toml|tsconfig.*\.json)$/

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

export const fallbackReasonForPath = (path: string): FullFallbackReason | undefined =>
  FULL_FALLBACK.test(path) ? "package-or-lock" : undefined

export const deriveVerificationSelection = (input: {
  readonly tier: VerificationTier
  readonly mode: SelectionMode
  readonly baseSha: string
  readonly headSha: string
  readonly population: readonly string[]
  readonly changedPaths: readonly string[]
  readonly selectedIds?: readonly string[]
  readonly gitOk?: boolean
}): SelectionPlan => {
  if (input.gitOk === false || input.baseSha === "") {
    return {
      schema: "quanta.verification-selection.v1",
      tier: input.tier,
      baseSha: input.baseSha,
      headSha: input.headSha,
      snapshotDigest: "",
      policyDigest: "",
      populationDigest: "",
      selected: [],
      notSelected: input.population.map((id) => ({ id, reason: "full-required" })),
      fallback: {
        scope: "full",
        reasons: [input.gitOk === false ? "git-failure" : "missing-base"],
      },
    }
  }
  const fallbackReasons = [
    ...new Set(
      input.changedPaths
        .map(fallbackReasonForPath)
        .filter((reason): reason is FullFallbackReason => reason !== undefined),
    ),
  ]
  if (fallbackReasons.length > 0) {
    return {
      schema: "quanta.verification-selection.v1",
      tier: input.tier,
      baseSha: input.baseSha,
      headSha: input.headSha,
      snapshotDigest: "",
      policyDigest: "",
      populationDigest: "",
      selected: input.population.map((id) => ({ id, reasons: ["fallback-full"] })),
      notSelected: [],
      fallback: { scope: "full", reasons: fallbackReasons },
    }
  }
  const selectedSet = new Set(
    input.selectedIds ?? input.changedPaths.filter((path) => path.endsWith(".test.ts")),
  )
  const selected = input.population
    .filter((id) => selectedSet.has(id))
    .map((id) => ({ id, reasons: ["changed-or-reachable"] }))
  const notSelected = input.population
    .filter((id) => !selectedSet.has(id))
    .map((id) => ({ id, reason: "not-affected" }))
  return {
    schema: "quanta.verification-selection.v1",
    tier: input.tier,
    baseSha: input.baseSha,
    headSha: input.headSha,
    snapshotDigest: "",
    policyDigest: "",
    populationDigest: "",
    selected,
    notSelected,
    fallback: { scope: "none", reasons: [] },
  }
}
