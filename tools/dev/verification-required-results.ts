import type { VerificationOutcome } from "./verification-result"

export type GithubCheckConclusion = "success" | "failure" | "cancelled" | "skipped" | "neutral"

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
