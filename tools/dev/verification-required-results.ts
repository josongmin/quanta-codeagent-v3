import type { VerificationOutcome } from "./verification-result"

export type GithubCheckConclusion = "success" | "failure" | "cancelled" | "skipped" | "neutral"

const CONCLUSIONS = new Set<GithubCheckConclusion>([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
])

export const requiredCheckOutcome = (input: {
  readonly github: GithubCheckConclusion
  readonly policy: VerificationOutcome
}): "pass" | "fail" => {
  if (input.policy === "not-selected") {
    return input.github === "skipped" || input.github === "success" ? "pass" : "fail"
  }
  if (input.github === "skipped") return "fail"
  if (input.github === "cancelled") return "fail"
  if (input.github === "failure") return "fail"
  if (input.github === "neutral") return "fail"
  return input.policy === "passed" ? "pass" : "fail"
}

export const aggregateRequiredNeeds = (
  needs: Readonly<Record<string, { readonly result?: unknown }>>,
  policy: VerificationOutcome = "passed",
): "pass" | "fail" => {
  const rows = Object.values(needs)
  if (rows.length === 0) return "fail"
  for (const row of rows) {
    const result = row.result
    if (typeof result !== "string" || !CONCLUSIONS.has(result as GithubCheckConclusion)) {
      return "fail"
    }
    if (requiredCheckOutcome({ github: result as GithubCheckConclusion, policy }) === "fail") {
      return "fail"
    }
  }
  return "pass"
}

if (import.meta.main) {
  const raw = process.env.QUANTA_REQUIRED_NEEDS ?? ""
  if (raw === "") {
    process.stderr.write("verification-required-results: missing QUANTA_REQUIRED_NEEDS\n")
    process.exit(2)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write("verification-required-results: QUANTA_REQUIRED_NEEDS is not JSON\n")
    process.exit(2)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("verification-required-results: needs must be an object\n")
    process.exit(2)
  }
  process.exit(
    aggregateRequiredNeeds(parsed as Record<string, { readonly result?: unknown }>) === "pass"
      ? 0
      : 1,
  )
}
