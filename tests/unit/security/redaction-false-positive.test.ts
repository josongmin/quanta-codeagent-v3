import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security"

/**
 * False-positive guard rails (ADR-0078). Normal text that LOOKS adjacent
 * to a secret format but is not a secret MUST pass through unchanged.
 *
 * These are the cases that ALWAYS bite in practice:
 *   - identifier names containing `aws` / `key` / `secret`;
 *   - regex pattern literals (e.g. a developer logging `/AKIA[0-9A-Z]{16}/`);
 *   - short example values in dotenv (e.g. `API_KEY=foo`);
 *   - `Authorization: Basic ...` (NOT `Bearer`).
 */

describe("False-positive guards — must NOT redact normal text", () => {
  test("variable name containing 'aws' is unchanged", () => {
    const input =
      "const aws_cool_test = 42\nlet awesome = key\nfunction api_key_helper() {}"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
    expect(r.text).toBe(input)
  })

  test("short dotenv example (no ≥20 char secret) is unchanged", () => {
    const input = `API_KEY=foo\nSECRET_KEY=bar\nACCESS_TOKEN=baz`
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
  })

  test("regex pattern literal AKIA[0-9A-Z]{16} is unchanged (no actual match)", () => {
    // The literal is a regex, not a 20-char AKIA token.
    const input = "matcher: /AKIA[0-9A-Z]{16}/"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
  })

  test("Authorization: Basic is NOT a Bearer hit", () => {
    const input = "Authorization: Basic dXNlcjpwYXNz"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.hits.every((h) => h.kind !== "bearer_token_header")).toBe(true)
  })

  test("normal git URL git@github.com is not url_with_userinfo", () => {
    // `git@github.com:owner/repo.git` has no scheme `://` and no password.
    const input = "git@github.com:owner/repo.git"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.hits.every((h) => h.kind !== "url_with_userinfo")).toBe(true)
  })

  test("URL without password (https://user@host) is not redacted", () => {
    // url_with_userinfo requires a `:` between user and password.
    const input = "https://github.com/owner/repo.git"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
  })

  test("English prose mentioning 'AWS access key id' is unchanged", () => {
    const input = "Your AWS access key id is typically 20 characters long."
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
  })

  test("AKIA prefix with WRONG length (≠16 base32) is unchanged", () => {
    // AKIA + 15 chars (one short).
    const input = "AKIA0123456789ABCDE"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
  })

  test("typescript identifier with sk_ prefix but no live/test suffix", () => {
    // The stripe matcher requires `sk_live_` / `sk_test_` prefix.
    const input = "let sk_abc = 'stripe-like-id-but-not-a-secret-prefix'"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.hits.every((h) => h.kind !== "stripe_secret_key")).toBe(true)
  })

  test("regex source code with sk-[A-Za-z0-9]{32} is unchanged", () => {
    const input = "const RE = /sk-[A-Za-z0-9]{32,}/g"
    const r = redactSecrets(input, { origin: "tool_result" })
    // The class-bracket form is not a real key string of 32+ alnum.
    expect(r.unchanged).toBe(true)
  })

  test("sentence containing 'private_key' but no JSON object", () => {
    const input = "Document the private_key field for the service account."
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.hits.every((h) => h.kind !== "gcp_service_account_key")).toBe(true)
  })
})
