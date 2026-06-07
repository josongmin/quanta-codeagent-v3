import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security"

/**
 * Golden positive cases per `RedactionKind` (ADR-0078, Layer 2). Each case
 * is one minimal token shape that MUST be redacted on the tool_result path.
 * Tests assert: at least one hit fired, kind matches, placeholder is in
 * the output, the original secret is NOT in the output.
 */

describe("Layer-2 format patterns — positive matches", () => {
  test("aws_access_key_id (AKIA prefix)", () => {
    const input = "found key AKIAIOSFODNN7EXAMPLE in env"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(false)
    expect(r.hits.some((h) => h.kind === "aws_access_key_id")).toBe(true)
    expect(r.text).toContain("[REDACTED:aws_access_key_id]")
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })

  test("aws_access_key_id (ASIA / temporary credentials prefix)", () => {
    const r = redactSecrets("ASIAY34FZKBOKMUTVV7A here", { origin: "tool_result" })
    expect(r.unchanged).toBe(false)
    expect(r.hits[0]?.kind).toBe("aws_access_key_id")
  })

  test("aws_secret_access_key_assignment", () => {
    const input = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nother line"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.unchanged).toBe(false)
    expect(r.hits.some((h) => h.kind === "aws_secret_access_key_assignment")).toBe(true)
    expect(r.text).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
  })

  test("github_pat_classic (ghp_)", () => {
    const tok = `ghp_${"a".repeat(36)}`
    const r = redactSecrets(`token=${tok}`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "github_pat_classic")).toBe(true)
    expect(r.text).not.toContain(tok)
  })

  test("github_pat_classic (ghs_/ghr_/gho_)", () => {
    for (const prefix of ["ghs_", "ghr_", "gho_"]) {
      const tok = `${prefix}${"b".repeat(40)}`
      const r = redactSecrets(`x=${tok}`, { origin: "tool_result" })
      expect(r.hits.some((h) => h.kind === "github_pat_classic")).toBe(true)
    }
  })

  test("github_pat_fine_grained", () => {
    const tok = `github_pat_${"c".repeat(82)}`
    const r = redactSecrets(`X-Auth: ${tok}`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "github_pat_fine_grained")).toBe(true)
    expect(r.text).not.toContain(tok)
  })

  test("google_api_key (AIza prefix)", () => {
    const tok = "AIzaSyAabc-ABCDEFGHIJKLMNOPQRSTUVWXYZ12"
    const r = redactSecrets(`key=${tok}`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "google_api_key")).toBe(true)
  })

  test("gcp_service_account_key (JSON with type+private_key)", () => {
    const json = `{ "type": "service_account", "project_id": "p", "private_key": "----- abc -----", "client_email": "a@b.iam" }`
    const r = redactSecrets(json, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "gcp_service_account_key")).toBe(true)
    expect(r.text).not.toContain("----- abc -----")
  })

  test("openai_api_key (sk- ≥32)", () => {
    const tok = `sk-${"X".repeat(40)}`
    const r = redactSecrets(`OPENAI=${tok}`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "openai_api_key")).toBe(true)
  })

  test("anthropic_api_key (sk-ant-)", () => {
    const tok = `sk-ant-${"Y".repeat(40)}`
    const r = redactSecrets(`A=${tok}`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "anthropic_api_key")).toBe(true)
    // Must NOT misclassify as openai_api_key.
    expect(r.hits.every((h) => h.kind !== "openai_api_key")).toBe(true)
  })

  test("stripe_secret_key (sk_live_/sk_test_)", () => {
    for (const prefix of ["sk_live_", "sk_test_"]) {
      const tok = `${prefix}${"Z".repeat(30)}`
      const r = redactSecrets(`S=${tok}`, { origin: "tool_result" })
      expect(r.hits.some((h) => h.kind === "stripe_secret_key")).toBe(true)
    }
  })

  test("bearer_token_header", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaa.bbbbbbbbbbb"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "bearer_token_header")).toBe(true)
  })

  test("pem_private_key_block", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`
    const r = redactSecrets(`begin\n${pem}\nend`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "pem_private_key_block")).toBe(true)
    expect(r.text).not.toContain("MIIEpAIBAAKCAQEA")
  })

  test("openssh_private_key_block", () => {
    const block = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAA...\n-----END OPENSSH PRIVATE KEY-----`
    const r = redactSecrets(block, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "openssh_private_key_block")).toBe(true)
  })

  test("url_with_userinfo", () => {
    const input = "fetch https://alice:hunter2@example.com/repo.git now"
    const r = redactSecrets(input, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "url_with_userinfo")).toBe(true)
    expect(r.text).not.toContain("alice:hunter2")
  })

  test("generic_api_key_assignment", () => {
    const r = redactSecrets(`API_KEY = "abcdef0123456789abcdef0123"`, {
      origin: "tool_result",
    })
    expect(r.hits.some((h) => h.kind === "generic_api_key_assignment")).toBe(true)
  })

  test("generic_api_key_assignment — JSON object form (quoted key)", () => {
    // `"api_key":"<secret>"` — the key's closing quote must not break the
    // assignment anchor (regression guard for the optional `["']?` after key).
    const r = redactSecrets(`{"api_key":"abcdef0123456789abcdef0123"}`, {
      origin: "tool_result",
    })
    expect(r.hits.some((h) => h.kind === "generic_api_key_assignment")).toBe(true)
    expect(r.text).not.toContain("abcdef0123456789abcdef0123")
  })

  test("slack_token (xoxb / xoxp)", () => {
    for (const tok of [
      "xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx",
      "xoxp-1234567890-1234567890123-abcdefghijklmnopqrstuvwx",
    ]) {
      const r = redactSecrets(`SLACK=${tok}`, { origin: "tool_result" })
      expect(r.hits.some((h) => h.kind === "slack_token")).toBe(true)
      expect(r.text).not.toContain(tok)
    }
  })

  test("jwt (three base64url segments)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ4u3J5kK2pXr8mYzT1sBvN0aQ"
    const r = redactSecrets(`token: ${jwt}`, { origin: "tool_result" })
    expect(r.hits.some((h) => h.kind === "jwt")).toBe(true)
    expect(r.text).not.toContain(jwt)
  })

  test("source_class_secret short-circuits — entire output replaced", () => {
    const r = redactSecrets("AKIAIOSFODNN7EXAMPLE and other secrets", {
      origin: "tool_result",
      sourceClass: "secret",
      sourceLabel: "/Users/x/.aws/credentials",
    })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]?.kind).toBe("source_class_secret")
    expect(r.text).toContain("[REDACTED:source_class_secret]")
    expect(r.text).toContain("origin: /Users/x/.aws/credentials")
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })
})

describe("Determinism and ordering invariants", () => {
  test("same input + opts ⇒ same output and same hit count", () => {
    const input =
      "key1=AKIAIOSFODNN7EXAMPLE key2=AKIAIOSFODNN7EXAMPLE pem=" +
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
    const r1 = redactSecrets(input, { origin: "tool_result" })
    const r2 = redactSecrets(input, { origin: "tool_result" })
    expect(r1.text).toBe(r2.text)
    expect(r1.hits.length).toBe(r2.hits.length)
  })

  test("empty input ⇒ unchanged with no hits", () => {
    const r = redactSecrets("", { origin: "tool_result" })
    expect(r.unchanged).toBe(true)
    expect(r.hits).toHaveLength(0)
  })

  test("anthropic key inside PEM block — only PEM hit fires (no double-redaction)", () => {
    const pemWithKey = `-----BEGIN RSA PRIVATE KEY-----\nsk-ant-${"x".repeat(30)}\n-----END RSA PRIVATE KEY-----`
    const r = redactSecrets(pemWithKey, { origin: "tool_result" })
    // PEM redaction consumes the whole block so the embedded anthropic
    // pattern never sees the original text.
    expect(r.hits.some((h) => h.kind === "pem_private_key_block")).toBe(true)
    expect(r.hits.filter((h) => h.kind === "anthropic_api_key")).toHaveLength(0)
  })

  test("whitelist override — a matching token is NOT redacted", () => {
    const tok = `ghp_${"a".repeat(36)}`
    const r = redactSecrets(`token=${tok}`, {
      origin: "tool_result",
      whitelist: [/ghp_a{36}/],
    })
    expect(r.unchanged).toBe(true)
    expect(r.hits).toHaveLength(0)
    expect(r.text).toContain(tok)
  })
})
