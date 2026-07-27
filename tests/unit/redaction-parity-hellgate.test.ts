/**
 * SECURITY DRY HELLGATE (jul-27 architectural audit): the codebase has TWO
 * independent last-line secret scrubbers guarding DIFFERENT content sinks —
 *   · `redactValue` / `SECRET_VALUE_RES`  (@/shared/trajectory) → JSONL recorder,
 *     stream Plane-B (boolean isSecret → REDACTED).
 *   · `redactSecrets`                       (@/security/redaction) → memory-distill,
 *     peer/advisor (named-kind masking).
 * They are FORKED (independent regex sets) and had already DIVERGED (trajectory
 * missed Stripe `sk_live_`; each carried patterns the other lacked). A secret
 * matched by only ONE set leaks on the OTHER plane. They cannot be merged into one
 * module (@/shared is a leaf and may not import @/security), so this test is the
 * anti-drift device: a shared corpus of high-value secret shapes that BOTH
 * scrubbers MUST redact. A future divergence on any corpus item fails CI.
 *
 * RED-first: revert the Stripe pattern just added to `SECRET_VALUE_RES` ⇒ the
 * Stripe row's `redactValue` assertion goes RED (proving the corpus has teeth).
 */
import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security"
import { redactValue } from "@/shared"

// Realistic-SHAPE but fabricated secrets (not live). Each MUST be scrubbed by BOTH
// scrubbers; label documents the provider so a failure names the leaking family.
const CORPUS: ReadonlyArray<readonly [label: string, secret: string]> = [
  ["stripe-live", "sk_live_51H8xQ2eZvKYlo2C0abcdefghij"],
  ["stripe-restricted", "rk_live_51H8xQ2eZvKYlo2C0klmnopqrst"],
  ["openai-proj", "sk-proj-abcdEFGH1234ijklMNOP5678qrst"],
  ["anthropic", "sk-ant-api03-abcdEFGH1234ijklMNOP5678qrstUVWX"],
  ["github-classic", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["github-finegrained", "github_pat_11ABCDEFG0abcdefghijKLMNOP"],
  ["slack-bot", "xoxb-1234567890-ABCDEFGHIJKLMNOP"],
  ["gitlab-pat", "glpat-abcdEFGH1234ijklMNOP"],
  // 35 chars after `AIza` (security's kind is exactly `{35}\b`; trajectory is ≥20).
  ["google-api", "AIzaSyAbcdEFGH1234ijklMNOP5678qrstUVWXY"],
  ["aws-akid", "AKIAIOSFODNN7EXAMPLE"],
  // FULL `Authorization: Bearer …` — security intentionally narrows to the header
  // form (avoids false-positives on the word "Bearer"); trajectory catches it too.
  ["bearer-header", "Authorization: Bearer abcdEFGH1234ijklMNOP5678qrst"],
]

const scrubbedByTrajectory = (s: string): boolean => redactValue(s) !== s
const scrubbedBySecurity = (s: string): boolean =>
  redactSecrets(s, { origin: "tool_result" }).text !== s

describe("redaction parity — BOTH scrubbers redact every high-value secret shape", () => {
  for (const [label, secret] of CORPUS) {
    test(`${label}: redactValue (trajectory) scrubs it`, () => {
      expect(scrubbedByTrajectory(secret)).toBe(true)
    })
    test(`${label}: redactSecrets (security) scrubs it`, () => {
      expect(scrubbedBySecurity(secret)).toBe(true)
    })
  }

  // anti-vacuity: a NON-secret must pass through BOTH untouched (proves the
  // assertions above measure real scrubbing, not a redact-everything stub).
  test("a benign string is NOT scrubbed by either (no over-redaction)", () => {
    const benign = "the quick brown fox ran 42 tests successfully"
    expect(scrubbedByTrajectory(benign)).toBe(false)
    expect(scrubbedBySecurity(benign)).toBe(false)
  })
})
