/**
 * jun-6 exfil-rail (B) — secret-aware egress PURE-CORE + gate hellgate.
 *
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.4 / §6 (B) / §7 (B).
 *
 * Proves the pure decision core (the e2e socket proof lives in
 * tests/integration/secret-egress-proxy-e2e.test.ts):
 *  - a DECLARED secret (zero-FP exact match) in body/header → hit.
 *  - a pattern secret (AWS key) in a body → hit via the composite scanner.
 *  - NO false positive: a legit body, or a high-entropy token added to the
 *    scanner `allowlist`, → no hit.
 *  - `redactDeclared` masks every occurrence of a declared value, leaves the
 *    rest intact; the deny-reason names KINDS only (never the secret bytes).
 *  - strict mode gate (`deny`/`redact` only).
 */

import { describe, expect, test } from "bun:test"
import {
  EGRESS_REDACTION_MASK,
  egressDenyReason,
  redactDeclared,
  type SecretEgressConfig,
  scanEgressText,
  secretEgressMode,
} from "@/runtime/network-proxy"
import { compositeSecretScanner } from "@/security/secret-detection"

// A syntactically valid AWS access key id (AKIA + 16 base32) — a high-confidence
// pattern hit. NOT a real key.
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
const DECLARED = "s3cr3t-deploy-token-do-not-leak"

const cfg = (over: Partial<SecretEgressConfig> = {}): SecretEgressConfig => ({
  scanner: compositeSecretScanner(),
  mode: "deny",
  maxBodyBytes: 1_000_000,
  ...over,
})

describe("scanEgressText — declared exact-match (zero-FP path)", () => {
  test("a declared secret in the body → hit with the exact span index", async () => {
    const v = await scanEgressText(
      `payload before ${DECLARED} after`,
      cfg({ declared: [DECLARED] }),
    )
    expect(v.hit).toBe(true)
    expect(v.declared.length).toBe(1)
    expect(v.declared[0]?.value).toBe(DECLARED)
    expect(v.declared[0]?.index).toBe("payload before ".length)
  })

  test("a declared secret in a header value (scanned as text) → hit", async () => {
    const headerText = `authorization: Bearer ${DECLARED}`
    const v = await scanEgressText(headerText, cfg({ declared: [DECLARED] }))
    expect(v.hit).toBe(true)
    expect(v.declared.length).toBe(1)
  })
})

describe("scanEgressText — composite scanner (pattern) path", () => {
  test("an AWS access key in the body → hit via the pattern scanner", async () => {
    const v = await scanEgressText(`grant=${AWS_KEY}`, cfg())
    expect(v.hit).toBe(true)
    expect(v.findings.some((f) => f.kind === "aws-access-key")).toBe(true)
  })
})

describe("scanEgressText — NO false positive (the load-bearing FP discipline)", () => {
  test("a legit prose body → no hit", async () => {
    const v = await scanEgressText("the quick brown fox jumps over the lazy dog", cfg())
    expect(v.hit).toBe(false)
  })

  test("a high-entropy token added to the scanner allowlist → no hit", async () => {
    // A long high-entropy token that the entropy adapter would otherwise flag.
    const token = "Zk9QwErTyUiOpAsDfGhJkLzXcVbNmQ1234567890aB"
    // The scanner allowlist drops the exact whitespace-delimited token (the FP
    // lever for a legit high-entropy value the operator vouched for).
    const allowlisted = compositeSecretScanner({ allowlist: [token] })
    const flagged = compositeSecretScanner()
    // Sanity: WITHOUT the allowlist the entropy adapter flags it (proves the
    // allowlist is what suppresses the FP, not a too-weak fixture).
    expect((await scanEgressText(`field ${token}`, cfg({ scanner: flagged }))).hit).toBe(true)
    const v = await scanEgressText(`field ${token}`, cfg({ scanner: allowlisted }))
    expect(v.hit).toBe(false)
  })
})

describe("redactDeclared — masks every occurrence, leaves the rest", () => {
  test("replaces all occurrences of a declared value with the mask", () => {
    const text = `${DECLARED} middle ${DECLARED}`
    const out = redactDeclared(text, [
      { value: DECLARED, index: 0 },
      { value: DECLARED, index: `${DECLARED} middle `.length },
    ])
    expect(out).toBe(`${EGRESS_REDACTION_MASK} middle ${EGRESS_REDACTION_MASK}`)
    expect(out.includes(DECLARED)).toBe(false)
  })

  test("no declared hits → text unchanged", () => {
    expect(redactDeclared("clean", [])).toBe("clean")
  })
})

describe("egressDenyReason — names kinds only, never the secret bytes", () => {
  test("the reason carries finding kinds + declared count but no secret value", async () => {
    const v = await scanEgressText(`a=${AWS_KEY} b=${DECLARED}`, cfg({ declared: [DECLARED] }))
    const reason = egressDenyReason(v)
    expect(reason).toContain("outbound secret detected")
    expect(reason).toContain("aws-access-key")
    expect(reason).toContain("declared-secret")
    expect(reason.includes(AWS_KEY)).toBe(false)
    expect(reason.includes(DECLARED)).toBe(false)
  })
})

describe("secretEgressMode — strict mode gate", () => {
  test("resolves the two exact mode tokens", () => {
    expect(secretEgressMode({ QUANTA_SECRET_EGRESS: "deny" })).toBe("deny")
    expect(secretEgressMode({ QUANTA_SECRET_EGRESS: "redact" })).toBe("redact")
  })

  test("OFF (undefined) for unset / off-vocabulary / arbitrary", () => {
    for (const v of [undefined, "", "1", "true", "DENY", "Redact", "block"]) {
      expect(secretEgressMode({ QUANTA_SECRET_EGRESS: v })).toBeUndefined()
    }
    expect(secretEgressMode({})).toBeUndefined()
  })
})
