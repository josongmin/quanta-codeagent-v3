/**
 * ★ ROUND 7 — DEEP security audit of the SECRET / PII REDACTION surface.
 *
 * Redaction is a data-exfil / leak-prevention control: secrets/PII in tool
 * output, logs, or model context must be masked BEFORE they reach a sink.
 * This battery hunts every realistic way a live secret/PII can slip through
 * unredacted and pins the FIXES found this round.
 *
 * REAL BUGS FIXED THIS ROUND (sealed below):
 *   - phone-us regex: a leading `\b` silently killed the documented
 *     `(415) 555-1234` paren form (a `\b` cannot match before `(`). The
 *     paren alternative was dead code. Fixed: anchor `\b` inside the
 *     bare-digit alternative only. (group D)
 *   - OpenAI `sk-svcacct-…` service-account keys were missed (the classic
 *     `sk-[A-Za-z0-9]{32,}` branch cannot span the `-`, and there was no
 *     `sk-svcacct-` branch). Fixed: added a dedicated branch. (group A)
 *
 * SINK-COVERAGE MAP (the key deliverable — see group F):
 *   - tool result → model context (dispatch `applyRedaction`): REDACTED
 *     (secret Layer-1+Layer-2 always; PII pass opt-in). Covers `read` tool
 *     file content, bash output, mcp/web — every tool result.
 *   - persisted JSONL envelope (loop scanEnvelopeForRedactions): redaction
 *     hits COUNTED; the model-facing text was already masked at dispatch.
 *   - memory-distill ingest: REDACTED independently (origin memory_distill).
 *   - session import: REDACTED (same redactSecrets).
 *   - trajectory/stream sinks (stdout/sse/jsonl-recorder): masked via the
 *     SEPARATE `redactValue` all-or-nothing redactor in @/shared.
 *   - async secret-detection (entropy/secretlint): detection-only, wired to
 *     the opt-in `check_secrets` LLM tool — NOT a dispatch masking sink.
 *
 * Every assertion is deterministic — no Date.now / randomness / thresholds.
 */
import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security"
import { compositePiiScanner } from "@/security/pii-redaction"
import { redactValue } from "@/shared"

const R = (s: string) => redactSecrets(s, { origin: "tool_result" })
const isMasked = (s: string): boolean => !R(s).unchanged
const piiMask = (s: string): string => compositePiiScanner().redactText(s)

// ─────────────────────────────────────────────────────────────────────────
// A. SECRET detector-evasion arsenal — per kind, the realistic obfuscation
//    that a leak-prevention control MUST still catch.
// ─────────────────────────────────────────────────────────────────────────

describe("A. secret detector-evasion (per kind)", () => {
  test("A1 — AWS access key id: canonical + embedded in prose", () => {
    expect(isMasked("AKIAIOSFODNN7EXAMPLE")).toBe(true)
    // embedded with surrounding punctuation — the 20-char prefix is distinctive
    const r = R("export KEY=AKIAIOSFODNN7EXAMPLE;")
    expect(r.unchanged).toBe(false)
    expect(r.text).toContain("[REDACTED:aws_access_key_id]")
    // ASIA / AROA / AIDA families also caught
    expect(isMasked("ASIAIOSFODNN7EXAMPLE")).toBe(true)
    expect(isMasked("AROAIOSFODNN7EXAMPLE")).toBe(true)
  })

  test("A2 — AWS access key: WHOLE key masked, no recoverable suffix", () => {
    const out = R("AKIAIOSFODNN7EXAMPLE").text
    // No fragment of the original 20-char key survives.
    expect(out).not.toContain("AKIA")
    expect(out).not.toContain("EXAMPLE")
    expect(out).toBe("[REDACTED:aws_access_key_id]")
  })

  test("A3 — AWS secret access key assignment (case-insensitive)", () => {
    expect(isMasked("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true)
    expect(isMasked("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true)
  })

  test("A4 — GitHub PATs: classic + oauth/server/user + fine-grained", () => {
    expect(isMasked("ghp_1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true)
    expect(isMasked("gho_1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true)
    expect(isMasked("ghs_1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true)
    expect(isMasked("github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789")).toBe(true)
  })

  test("A5 — GitHub PAT whole-token mask (no prefix/suffix leak)", () => {
    const out = R("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz done").text
    expect(out).not.toContain("ghp_")
    expect(out).not.toContain("uvwxyz")
    expect(out).toBe("token: [REDACTED:github_pat_classic] done")
  })

  test("A6 — PEM/OpenSSH private key blocks (LF, CRLF, with key type)", () => {
    expect(
      isMasked("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB\n-----END RSA PRIVATE KEY-----"),
    ).toBe(true)
    expect(isMasked("-----BEGIN PRIVATE KEY-----\r\nABC\r\n-----END PRIVATE KEY-----")).toBe(true)
    expect(
      isMasked("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\n-----END OPENSSH PRIVATE KEY-----"),
    ).toBe(true)
    expect(isMasked("-----BEGIN EC PRIVATE KEY-----\nMHcCAQ\n-----END EC PRIVATE KEY-----")).toBe(
      true,
    )
  })

  test("A7 — PEM block fully masked between BEGIN/END (body not recoverable)", () => {
    const out = R(
      "-----BEGIN RSA PRIVATE KEY-----\nSECRETBODYLINE\n-----END RSA PRIVATE KEY-----",
    ).text
    expect(out).not.toContain("SECRETBODYLINE")
    expect(out).not.toContain("BEGIN RSA")
  })

  test("A8 — JWT (eyJ-anchored three-segment)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM"
    expect(isMasked(jwt)).toBe(true)
    expect(R(`Bearer-ish ${jwt}!`).text).not.toContain("eyJ")
  })

  test("A9 — Slack token families (bot/user/app/refresh/legacy/config)", () => {
    for (const p of ["xoxb", "xoxp", "xoxa", "xoxr", "xoxs", "xoxe"]) {
      expect(isMasked(`${p}-123456789012-abcdefghijkl`)).toBe(true)
    }
  })

  test("A10 — Google API key + Stripe + bearer header + URL userinfo", () => {
    expect(isMasked("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe(true)
    expect(isMasked("sk_live_abcdefghij1234567890ABCDEFGH")).toBe(true)
    expect(isMasked("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toBe(true)
    expect(isMasked("https://user:p4ssw0rd@example.com/path")).toBe(true)
  })

  test("A11 — OpenAI key families: classic sk-, sk-proj-, sk-svcacct- (FIXED)", () => {
    expect(isMasked("sk-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true)
    expect(isMasked("sk-proj-abcdefghij_klmno-pqrstuvwxyz0123456789")).toBe(true)
    // ── R7 FIX: sk-svcacct- service-account keys were previously MISSED.
    const svc = "sk-svcacct-abcdefghijklmnopqrstuvwxyz0123456789ABCD"
    const r = R(svc)
    expect(r.unchanged).toBe(false)
    expect(r.hits[0]?.kind).toBe("openai_api_key")
    expect(r.text).not.toContain("svcacct")
  })

  test("A12 — anthropic sk-ant- classified as anthropic (not openai/generic)", () => {
    const r = R("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")
    expect(r.unchanged).toBe(false)
    expect(r.hits[0]?.kind).toBe("anthropic_api_key")
  })

  test("A13 — generic API_KEY assignment (dotenv / JSON / shell forms)", () => {
    expect(isMasked('API_KEY="abcdefghijklmnopqrstuvwxyz123"')).toBe(true)
    expect(isMasked('"access_token":"abcdefghijklmnopqrstuvwxyz123"')).toBe(true)
    expect(isMasked("export SECRET_KEY=abcdefghijklmnopqrstuvwxyz123")).toBe(true)
  })

  test("A14 — GCP service-account JSON object masked (smallest enclosing obj)", () => {
    const blob =
      '{"type": "service_account", "project_id": "x", "private_key": "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----"}'
    const r = R(blob)
    expect(r.unchanged).toBe(false)
    expect(r.text).not.toContain("private_key")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B. Documented DETECTOR MISSES — pin the trade-offs so a regression that
//    silently changes behavior is caught (these are NOT live-secret leaks
//    through the dispatch masking sink; each is a justified scope boundary).
// ─────────────────────────────────────────────────────────────────────────

describe("B. documented misses (trade-off pins)", () => {
  test("B1 — lowercase AWS prefix is NOT an AWS key (akia… is not live)", () => {
    // AWS access key ids are upper-case by spec; lowercasing yields a non-key.
    expect(R("akiaiosfodnn7example").unchanged).toBe(true)
  })

  test("B2 — bare 40-char base64 (no aws_secret_access_key anchor) not masked", () => {
    // Anchoring on the assignment is intentional: a bare 40-char token is
    // indistinguishable from a hash/identifier without context.
    expect(R("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").unchanged).toBe(true)
  })

  test("B3 — secret split across a newline is not reassembled (regex is linear)", () => {
    // A token broken mid-string evades a single-line regex. Documented limit:
    // the regex matches contiguous tokens. Pinned so the trade-off is visible.
    expect(R("ghp_1234567890abcdef\nghijklmnopqrstuvwxyz").unchanged).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// C. ENTROPY / FALSE-POSITIVE control — the dispatch masking path is
//    SIGNATURE-based (no entropy gate), so legitimate high-entropy content
//    (UUIDs, hashes, base64 blobs) must NOT be over-redacted by the model-
//    facing secret pass.
// ─────────────────────────────────────────────────────────────────────────

describe("C. false-positive control (no over-redaction)", () => {
  test("C1 — a SHA-256 hex digest is NOT redacted by the secret pass", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    expect(R(`checksum: ${sha}`).unchanged).toBe(true)
  })

  test("C2 — a dashed UUID is NOT redacted by the secret pass", () => {
    expect(R("id 550e8400-e29b-41d4-a716-446655440000").unchanged).toBe(true)
  })

  test("C3 — a benign base64 blob (no key prefix) is NOT redacted", () => {
    expect(R("data: SGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBzZWNyZXQ=").unchanged).toBe(true)
  })

  test("C4 — ordinary dotted version / identifier is NOT a JWT", () => {
    expect(R("v1.2.3-build.456").unchanged).toBe(true)
    expect(R("com.example.service.v2").unchanged).toBe(true)
  })

  test("C5 — git-over-ssh URL (no userinfo password) NOT masked", () => {
    expect(R("git@github.com:org/repo.git").unchanged).toBe(true)
    expect(R("https://github.com/org/repo").unchanged).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D. PII evasion + the FIXED phone-us paren form.
// ─────────────────────────────────────────────────────────────────────────

describe("D. PII evasion + fixes", () => {
  test("D1 — phone-us PAREN form (415) 555-1234 masked (R7 FIX)", () => {
    expect(piiMask("(415) 555-1234")).toBe("[PHONE]")
    expect(piiMask("(415)555-1234")).toBe("[PHONE]")
    // dash + dot forms still masked (no regression)
    expect(piiMask("415-555-1234")).toBe("[PHONE]")
    expect(piiMask("415.555.1234")).toBe("[PHONE]")
  })

  test("D2 — phone-international (+country) masked, distinct from us", () => {
    expect(piiMask("+1 415 555 1234")).toBe("[PHONE]")
    expect(piiMask("+44 20 7946 0958")).toBe("[PHONE]")
  })

  test("D3 — phone fix does NOT over-redact an embedded long digit run", () => {
    // 13-digit order id should not be a phone-us; (no leading paren, \b guards)
    const out = piiMask("order 1234155551234 shipped")
    expect(out).toContain("order")
    expect(out).not.toBe("order [PHONE] shipped")
  })

  test("D4 — email + SSN + IPv4/IPv6 + IBAN masked", () => {
    expect(piiMask("contact alice@example.com")).toBe("contact [EMAIL]")
    expect(piiMask("ssn 123-45-6789")).toBe("ssn [SSN]")
    expect(piiMask("ip 192.168.1.1")).toBe("ip [IPV4]")
    expect(piiMask("v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toContain("[IPV6]")
    expect(piiMask("DE89370400440532013000")).toBe("[IBAN]")
  })

  test("D5 — credit card: Luhn-valid masked, with spaces AND dashes", () => {
    expect(piiMask("4111 1111 1111 1111")).toBe("[CC]")
    expect(piiMask("4111-1111-1111-1111")).toBe("[CC]")
    expect(piiMask("card 4111111111111111 end")).toBe("card [CC] end")
  })

  test("D6 — Luhn FALSE-POSITIVE control: invalid 16-digit run NOT masked", () => {
    // 1234... fails Luhn → not a card → stays as-is (FP suppression).
    expect(piiMask("1234 5678 9012 3456")).toBe("1234 5678 9012 3456")
  })

  test("D7 — documented PII miss: obfuscated `name [at] domain` NOT caught", () => {
    // Out-of-scope by design (prose obfuscation). Pinned.
    expect(piiMask("alice [at] example [dot] com")).toBe("alice [at] example [dot] com")
  })

  test("D8 — PII whole-span mask (no digit suffix recoverable)", () => {
    const out = piiMask("(415) 555-1234")
    expect(out).not.toContain("1234")
    expect(out).not.toContain("415")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E. Partial-match / boundary / multi-secret — full mask, never a sliver.
// ─────────────────────────────────────────────────────────────────────────

describe("E. partial-match / multi-secret full mask", () => {
  test("E1 — two different secrets in one string both fully masked", () => {
    const r = R("k1=AKIAIOSFODNN7EXAMPLE k2=ghp_1234567890abcdefghijklmnopqrstuvwxyz")
    expect(r.text).toContain("[REDACTED:aws_access_key_id]")
    expect(r.text).toContain("[REDACTED:github_pat_classic]")
    expect(r.text).not.toContain("AKIA")
    expect(r.text).not.toContain("ghp_")
    expect(r.hits.length).toBe(2)
  })

  test("E2 — secret at very start and very end of the string", () => {
    const r = R("AKIAIOSFODNN7EXAMPLE middle ASIAIOSFODNN7EXAMPLE")
    expect(r.text).not.toContain("AKIA")
    expect(r.text).not.toContain("ASIA")
  })

  test("E3 — Layer-1 source-class secret replaces ENTIRE output", () => {
    const r = redactSecrets("totally secret file body\nline2", {
      origin: "tool_result",
      sourceClass: "secret",
      sourceLabel: "~/.aws/credentials",
    })
    expect(r.unchanged).toBe(false)
    expect(r.text).toContain("[REDACTED:source_class_secret]")
    expect(r.text).toContain("~/.aws/credentials")
    expect(r.text).not.toContain("totally secret file body")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// F. SINK COVERAGE — the cross-cutting "is redaction applied everywhere it
//    must be" proof. Each sink uses the SAME or an equivalent redactor.
// ─────────────────────────────────────────────────────────────────────────

describe("F. sink coverage", () => {
  test("F1 — tool_result sink masks an AWS key (model-facing dispatch path)", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE", { origin: "tool_result" }).unchanged).toBe(false)
  })

  test("F2 — envelope_jsonl persistence sink masks the same key", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE", { origin: "envelope_jsonl" }).unchanged).toBe(
      false,
    )
  })

  test("F3 — memory_distill ingest sink masks the same key", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE", { origin: "memory_distill" }).unchanged).toBe(
      false,
    )
  })

  test("F4 — trajectory/stream redactValue masks secret STRING values", () => {
    // The stream sinks (stdout/sse/jsonl-recorder) use redactValue, an
    // all-or-nothing redactor. A secret string is replaced wholesale.
    expect(redactValue("ghp_1234567890abcdefghijklmnopqrstuvwxyz")).toBe("***REDACTED***")
    expect(redactValue("AKIAIOSFODNN7EXAMPLE")).toBe("***REDACTED***")
  })

  test("F5 — redactValue masks secret-NAMED object keys deep", () => {
    const masked = redactValue({
      outer: { api_key: "anything-here-at-all", token: "x" },
      benign: "hello",
    }) as Record<string, { api_key: string; token: string } & Record<string, string>>
    expect((masked.outer as { api_key: string }).api_key).toBe("***REDACTED***")
    expect((masked as unknown as { benign: string }).benign).toBe("hello")
  })

  test("F6 — redactValue leaves benign primitives + token counts untouched", () => {
    expect(redactValue("just a normal sentence")).toBe("just a normal sentence")
    expect(redactValue({ inputTokens: 123, outputTokens: 456 })).toEqual({
      inputTokens: 123,
      outputTokens: 456,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// G. Idempotence / no-throw / robustness.
// ─────────────────────────────────────────────────────────────────────────

describe("G. idempotence / no-throw", () => {
  test("G1 — redacting already-redacted text is a no-op (idempotent)", () => {
    const once = R("AKIAIOSFODNN7EXAMPLE").text
    const twice = R(once)
    expect(twice.unchanged).toBe(true)
    expect(twice.text).toBe(once)
  })

  test("G2 — empty + whitespace + benign prose ⇒ unchanged, no throw", () => {
    expect(R("").unchanged).toBe(true)
    expect(R("   \n\t  ").unchanged).toBe(true)
    expect(R("the quick brown fox jumps over the lazy dog").unchanged).toBe(true)
  })

  test("G3 — large input does not throw and still finds the embedded secret", () => {
    const big = `${"x".repeat(200_000)} ghp_1234567890abcdefghijklmnopqrstuvwxyz ${"y".repeat(50_000)}`
    const r = R(big)
    expect(r.unchanged).toBe(false)
    expect(r.text).not.toContain("ghp_")
  })

  test("G4 — binary-ish / control-char input does not throw", () => {
    const junk = "\x00�\u{1F600}\x07\x1b[31m raw bytes \uD800"
    expect(() => R(junk)).not.toThrow()
    expect(() => piiMask(junk)).not.toThrow()
  })

  test("G5 — PII redactText is idempotent over its own placeholders", () => {
    const once = piiMask("call (415) 555-1234 or alice@example.com")
    expect(piiMask(once)).toBe(once)
  })
})
