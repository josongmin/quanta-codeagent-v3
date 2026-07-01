/**
 * ★ CONTRACT — ADR-0164 secret-detection slice. Hexagonal port + 2 adapters
 *   (pattern + entropy) + composite. Pattern findings have `confidence:
 *   "high"`, entropy `"medium"`. Composite dedups: pattern wins on the same
 *   (file, line, column). Structural shapes (SHA / UUID) are skipped by the
 *   entropy adapter. Mask helper redacts mid-secret. allowlist drops matches.
 *   `scanFile` is binary-decode-tolerant, but a READ failure (missing file /
 *   EACCES / EISDIR) is a typed `SecretScanReadError` — a security scanner
 *   must never report an unreadable file as "clean" (jun-10 finding #12).
 *
 * HELLGATE — adversarial proofs that signature precision is preserved while
 * entropy catches novel formats without drowning callers in SHA/UUID noise.
 */
import { describe, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compositeSecretScanner,
  DEFAULT_ENTROPY_THRESHOLD_BITS_PER_CHAR,
  DEFAULT_MAX_FINDINGS,
  entropyScanner,
  mask,
  patternScanner,
  SecretScanReadError,
  type SecretScanner,
  secretlintScanner,
  shannonEntropyBits,
} from "@/security/secret-detection"

const HIGH_ENTROPY_40 = "k7AjP9xN2qLm8Bv4XzCw6FrYtUiOpHsLeR3aDfGh"
const ANOTHER_HIGH_ENTROPY = "q9zXbR7tYwP3mN5jK1vF4hLcDgAuOiEsMpHaQrBz"

describe("0. common port", () => {
  test("0.1 — every adapter satisfies the same awaitable SecretScanner contract", async () => {
    const factories: Array<() => SecretScanner> = [
      patternScanner,
      entropyScanner,
      compositeSecretScanner,
      secretlintScanner,
    ]
    for (const createScanner of factories) {
      const findings = await createScanner().scanText("plain text only")
      expect(Array.isArray(findings)).toBe(true)
    }
  })
})

describe("A. pattern scanner — signature precision", () => {
  test("A1 — AWS access key id detected as aws-access-key, high confidence", async () => {
    const s = patternScanner()
    const findings = await s.scanText("aws_key = AKIAIOSFODNN7EXAMPLE blah")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("aws-access-key")
    expect(findings[0]?.confidence).toBe("high")
    expect(findings[0]?.preview).toBe("AKIA***MPLE")
  })

  test("A2 — OpenAI sk- key (48 chars) detected", async () => {
    const key = `sk-${"A".repeat(48)}`
    const findings = await patternScanner().scanText(`KEY=${key}`)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("openai-api-key")
  })

  test("A3 — Anthropic sk-ant- key detected as anthropic-api-key (not openai)", async () => {
    const key = `sk-ant-${"X".repeat(93)}`
    const findings = await patternScanner().scanText(`KEY=${key}`)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("anthropic-api-key")
  })

  test("A4 — GitHub PAT (ghp_) detected", async () => {
    const key = `ghp_${"a".repeat(36)}`
    const findings = await patternScanner().scanText(`GH=${key}`)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("github-token")
  })

  test("A5 — Google API key (AIza...) detected", async () => {
    const key = `AIza${"B".repeat(35)}`
    const findings = await patternScanner().scanText(`GCP=${key}`)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("google-api-key")
  })

  test("A6 — GCP service-account JSON snippet detected", async () => {
    const json = `{"type":"service_account","project_id":"x","private_key_id":"abc"}`
    const findings = await patternScanner().scanText(json)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("gcp-service-account")
  })

  test("A7 — Slack bot token (xoxb-) detected", async () => {
    const findings = await patternScanner().scanText("token: xoxb-1234567890-abcdefghij")
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("slack-token")
  })

  test("A8 — Stripe sk_live_ key detected", async () => {
    const key = `sk_live_${"a".repeat(24)}`
    const findings = await patternScanner().scanText(`STRIPE=${key}`)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("stripe-key")
  })

  test("A9 — RSA private-key block detected", async () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB...content...\n-----END RSA PRIVATE KEY-----"
    const findings = await patternScanner().scanText(block)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("private-key-block")
  })

  test("A10 — plain English word 'password' NOT detected (no FP on words)", async () => {
    const findings = await patternScanner().scanText(
      "the password is secret and the key is unknown",
    )
    expect(findings).toEqual([])
  })

  test("A11 — empty / no-match text returns empty array", async () => {
    expect(await patternScanner().scanText("")).toEqual([])
    expect(await patternScanner().scanText("hello world, normal text only")).toEqual([])
  })

  test("A12 — multiple secrets in one blob → multiple findings", async () => {
    const text = [
      "aws=AKIAIOSFODNN7EXAMPLE",
      `gh=ghp_${"a".repeat(36)}`,
      `goog=AIza${"B".repeat(35)}`,
    ].join("\n")
    const findings = await patternScanner().scanText(text)
    expect(findings.length).toBe(3)
    const kinds = findings.map((f) => f.kind).sort()
    expect(kinds).toEqual(["aws-access-key", "github-token", "google-api-key"])
  })
})

describe("B. mask helper", () => {
  test("B13 — long secret → first4 + *** + last4", () => {
    expect(mask("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA***MPLE")
  })

  test("B14 — short secret (< 8 chars) → all stars", () => {
    expect(mask("short")).toBe("*****")
    expect(mask("1234567")).toBe("*******")
  })

  test("B15 — empty → empty", () => {
    expect(mask("")).toBe("")
  })
})

describe("C. entropy scanner", () => {
  test("C16 — high-entropy base64-shaped token (40 chars) → generic-high-entropy / medium", async () => {
    const findings = await entropyScanner().scanText(`key=${HIGH_ENTROPY_40} end`)
    expect(findings.length).toBe(1)
    expect(findings[0]?.kind).toBe("generic-high-entropy")
    expect(findings[0]?.confidence).toBe("medium")
    expect(findings[0]?.entropyBits).toBeGreaterThan(DEFAULT_ENTROPY_THRESHOLD_BITS_PER_CHAR)
  })

  test("C17 — hex SHA256 (64 hex chars) is SKIPPED (structural pattern)", async () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    const findings = await entropyScanner().scanText(`hash: ${sha}`)
    expect(findings).toEqual([])
  })

  test("C18 — canonical UUID is SKIPPED", async () => {
    const findings = await entropyScanner().scanText("id=550e8400-e29b-41d4-a716-446655440000")
    expect(findings).toEqual([])
  })

  test("C19 — below threshold (English-y text) → no finding", async () => {
    // Note: minSecretLength=20 already filters short words; we need a 20+ char
    // low-entropy string. Repeated chars give very low entropy.
    const findings = await entropyScanner().scanText(`val=${"abcabcabcabcabcabcabc"} end`)
    expect(findings.find((f) => f.kind === "generic-high-entropy")).toBeUndefined()
  })

  test("C20 — token below minSecretLength → no finding", async () => {
    const findings = await entropyScanner().scanText("short=k7Aj")
    expect(findings).toEqual([])
  })

  test("C21 — entropyThreshold override respected (raise it so 40-char b64 is dropped)", async () => {
    const findings = await entropyScanner({ entropyThreshold: 10 }).scanText(`k=${HIGH_ENTROPY_40}`)
    expect(findings).toEqual([])
  })

  test("C22 — minSecretLength override respected (lower → catches shorter tokens)", async () => {
    // 12-char high-entropy token. Default minSecretLength=20 → ignored.
    // Lowered to 10 → caught (entropy ≈ 3.58 b/c clears a lowered threshold).
    const tok = "k7AjP9xN2qLm"
    const text = `key=${tok} end`
    const def = await entropyScanner().scanText(text)
    expect(def).toEqual([])
    const lowered = await entropyScanner({
      minSecretLength: 10,
      entropyThreshold: 3.0,
    }).scanText(text)
    expect(lowered.length).toBe(1)
    expect(lowered[0]?.kind).toBe("generic-high-entropy")
  })
})

describe("D. composite — pattern wins over entropy", () => {
  test("D23 — AWS key alone → only aws-access-key (entropy dedup'd)", async () => {
    const text = "AKIAIOSFODNN7EXAMPLE"
    const findings = await compositeSecretScanner().scanText(text)
    // Pattern hits at (line=1, col=1); entropy would also hit the same token
    // at the same cell. Dedup keeps the pattern finding.
    const aws = findings.filter((f) => f.kind === "aws-access-key")
    expect(aws.length).toBe(1)
    expect(aws[0]?.confidence).toBe("high")
    // No "generic-high-entropy" entry shadowing the same (line, col).
    const sameCell = findings.filter((f) => f.line === aws[0]?.line && f.column === aws[0]?.column)
    expect(sameCell.length).toBe(1)
  })

  test("D24 — both adapters match same token → pattern wins (high confidence)", async () => {
    // GitHub PAT shape is also high-entropy. Composite must keep "high".
    const key = `ghp_${"a".repeat(36)}`
    const findings = await compositeSecretScanner().scanText(key)
    const same = findings.filter((f) => f.line === 1 && f.column === 1)
    expect(same.length).toBe(1)
    expect(same[0]?.kind).toBe("github-token")
    expect(same[0]?.confidence).toBe("high")
  })

  test("D25 — pattern on L1, entropy on L5 → BOTH findings preserved", async () => {
    const text = [
      "AKIAIOSFODNN7EXAMPLE",
      "noise line 2",
      "noise line 3",
      "noise line 4",
      `freshToken=${ANOTHER_HIGH_ENTROPY}`,
    ].join("\n")
    const findings = await compositeSecretScanner().scanText(text)
    const kinds = new Set(findings.map((f) => f.kind))
    expect(kinds.has("aws-access-key")).toBe(true)
    expect(kinds.has("generic-high-entropy")).toBe(true)
  })

  test("D26 — allowlist drops match (entropy + pattern paths)", async () => {
    const key = `ghp_${"a".repeat(36)}`
    const findings = await compositeSecretScanner({ allowlist: [key] }).scanText(`KEY=${key}`)
    expect(findings.filter((f) => f.kind === "github-token")).toEqual([])
    expect(findings.filter((f) => f.kind === "generic-high-entropy")).toEqual([])
  })
})

describe("E. scanFile — disk + binary tolerance", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-detection-test-"))

  test("E27 — real file with AWS key → finding includes `file` field", async () => {
    const p = join(dir, "with-secret.env")
    writeFileSync(p, "AWS_KEY=AKIAIOSFODNN7EXAMPLE\n")
    const findings = await compositeSecretScanner().scanFile(p)
    const aws = findings.find((f) => f.kind === "aws-access-key")
    expect(aws).toBeDefined()
    expect(aws?.file).toBe(p)
  })

  test("E28 — file with no secrets → empty array", async () => {
    const p = join(dir, "clean.txt")
    writeFileSync(p, "hello world, just normal text here\n")
    const findings = await compositeSecretScanner().scanFile(p)
    expect(findings).toEqual([])
  })

  test("E29 — file that does NOT exist → typed SecretScanReadError naming the path (NEVER silent-clean)", async () => {
    // Red-on-injection (jun-10 finding #12): an unreadable file used to scan
    // as `[]` — byte-identical to a clean file. The fix propagates a typed
    // failure so callers (check_secrets) can surface ok:false.
    const p = join(dir, "missing-file-does-not-exist")
    let thrown: unknown
    try {
      await compositeSecretScanner().scanFile(p)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SecretScanReadError)
    const err = thrown as SecretScanReadError
    expect(err.path).toBe(p)
    expect(err.message).toContain(p)
    // The underlying fs error is preserved as `cause` (boundary classifies once).
    expect((err.cause as NodeJS.ErrnoException).code).toBe("ENOENT")
  })

  test("E29b — entropy adapter MIRROR: missing file → same typed SecretScanReadError", async () => {
    const p = join(dir, "missing-for-entropy-mirror")
    let thrown: unknown
    try {
      await entropyScanner().scanFile(p)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SecretScanReadError)
    expect((thrown as SecretScanReadError).path).toBe(p)
    expect((thrown as SecretScanReadError).message).toContain(p)
  })

  test("E29b2 — 4-WAY scanFile read-error invariant: EVERY adapter throws (never fail-open)", async () => {
    // Drift guard (jul-2 SE re-audit): pattern/secretlint `scanFile` had silently
    // regressed to `return []` on read failure while composite/entropy threw —
    // the individual adapters were untested, so the drift slipped through. This
    // asserts all four propagate a typed failure, so no single adapter can go
    // back to scanning an unreadable file as "clean" (jun-10 finding #12).
    const p = join(dir, "missing-for-4way-invariant")
    const adapters = {
      pattern: patternScanner(),
      secretlint: secretlintScanner(),
      entropy: entropyScanner(),
      composite: compositeSecretScanner(),
    }
    for (const [name, scanner] of Object.entries(adapters)) {
      let thrown: unknown
      try {
        await scanner.scanFile(p)
      } catch (e) {
        thrown = e
      }
      expect(
        thrown,
        `${name} adapter must throw SecretScanReadError on an unreadable file, not fail-open`,
      ).toBeInstanceOf(SecretScanReadError)
      expect((thrown as SecretScanReadError).path).toBe(p)
    }
  })

  test("E29c — path that is a DIRECTORY (EISDIR read failure) → typed error, not silent-clean", async () => {
    let thrown: unknown
    try {
      await compositeSecretScanner().scanFile(dir)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SecretScanReadError)
    expect((thrown as SecretScanReadError).path).toBe(dir)
  })

  test("E29d — paired control: entropy adapter still FINDS a secret in a readable file", async () => {
    // Proves the read-error propagation did not break the mirror's happy
    // path: readable file with a high-entropy token → finding, no throw.
    const p = join(dir, "entropy-readable.env")
    writeFileSync(p, `TOKEN=${HIGH_ENTROPY_40}\n`)
    const findings = await entropyScanner().scanFile(p)
    expect(findings.some((f) => f.kind === "generic-high-entropy")).toBe(true)
    expect(findings[0]?.file).toBe(p)
  })

  test("E30 — binary-ish file → no decode throw; returns gracefully", async () => {
    const p = join(dir, "binary.bin")
    // Write bytes that include invalid UTF-8 sequences. fs.readFile with
    // "utf8" produces replacement chars rather than throwing — finding count
    // is unstable on arbitrary bytes, so we only assert "no throw".
    writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x80, 0x81, 0x82]))
    const findings = await compositeSecretScanner().scanFile(p)
    expect(Array.isArray(findings)).toBe(true)
  })

  // Cleanup once.
  test("E-cleanup", () => {
    const cleanupSpy = mock((d: string) => rmSync(d, { recursive: true, force: true }))
    cleanupSpy(dir)
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    expect(existsSync(dir)).toBe(false)
  })
})

describe("F. maxFindings cap + Shannon helper sanity", () => {
  test("F31 — 200 GitHub tokens + maxFindings=10 → exactly 10 returned (truncated)", async () => {
    const tok = (i: number) => `ghp_${"a".repeat(35)}${i % 10}`
    const text = Array.from({ length: 200 }, (_, i) => `KEY${i}=${tok(i)}`).join("\n")
    const findings = await patternScanner({ maxFindings: 10 }).scanText(text)
    expect(findings.length).toBe(10)
    expect(findings.every((f) => f.kind === "github-token")).toBe(true)
  })

  test("F32 — default cap honored when not overridden", async () => {
    const tok = (i: number) => `ghp_${"a".repeat(35)}${i % 10}`
    const text = Array.from(
      { length: DEFAULT_MAX_FINDINGS + 50 },
      (_, i) => `K${i}=${tok(i)}`,
    ).join("\n")
    const findings = await patternScanner().scanText(text)
    expect(findings.length).toBe(DEFAULT_MAX_FINDINGS)
  })

  test("F33 — shannonEntropyBits sanity: empty=0, repeated=0, uniform≈log2(n)", () => {
    expect(shannonEntropyBits("")).toBe(0)
    expect(shannonEntropyBits("aaaaaaaa")).toBe(0)
    // 4 distinct chars equally distributed → 2 bits/char.
    expect(shannonEntropyBits("abcdabcd")).toBeCloseTo(2, 5)
  })
})
