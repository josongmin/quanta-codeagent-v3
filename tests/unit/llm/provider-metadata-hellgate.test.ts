import { describe, expect, test } from "bun:test"
import {
  isTruthyEnv,
  PROVIDER_CREDENTIALS,
  providerCredentialSource,
  providerCredentials,
} from "@/llm/provider-metadata"
import { resolveProviderWithRouter } from "@/llm/provider-router"
import { LLM_PROVIDERS } from "@/llm/provider-types"

/**
 * T07 hellgate — the canonical provider-metadata authority (SSOT ratchet).
 *
 * Proves audit L6 M1 (chatgpt-oauth credential mis-routing) and M11 (duplicated
 * truthy-env grammar) are owned by ONE module. T13 deletes the duplicate bodies
 * and re-points to this authority; these ratchets fail if the authority drifts.
 */
describe("T07 provider-metadata authority hellgate", () => {
  test("SSOT ratchet: every LlmProvider has a credential entry (exhaustive)", () => {
    for (const p of LLM_PROVIDERS) {
      const creds = providerCredentials(p)
      expect(creds).toBeDefined()
      expect(typeof creds.kind).toBe("string")
      expect(typeof creds.source).toBe("string")
    }
    expect(Object.keys(PROVIDER_CREDENTIALS).sort()).toEqual([...LLM_PROVIDERS].sort())
  })

  test("M1: chatgpt-oauth is oauth/file — NOT api-key/env", () => {
    expect(providerCredentials("chatgpt-oauth")).toEqual({ kind: "oauth", source: "file" })
    expect(providerCredentialSource("chatgpt-oauth")).toBe("file")
  })

  test("M1: explicit chatgpt-oauth through the router resolves oauth/file", () => {
    const res = resolveProviderWithRouter({ explicit: "chatgpt-oauth", env: {} })
    expect(res.provider).toBe("chatgpt-oauth")
    // Pre-fix this returned {kind:"api-key", source:"env"} via the default arm.
    expect(res.credentials).toEqual({ kind: "oauth", source: "file" })
  })

  test("cloud transports keep their native IAM credential surface", () => {
    expect(providerCredentials("bedrock")).toEqual({ kind: "aws-iam", source: "env" })
    expect(providerCredentials("vertex")).toEqual({ kind: "gcp-sa", source: "env" })
    expect(providerCredentials("foundry")).toEqual({ kind: "azure-msi", source: "env" })
  })

  test("M11: truthy-env grammar accepts 1/true/yes (trimmed, case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", " yes ", "Yes"]) {
      expect(isTruthyEnv(v)).toBe(true)
    }
    for (const v of [undefined, "", "0", "false", "2", "no", "on"]) {
      expect(isTruthyEnv(v)).toBe(false)
    }
  })

  test("M11: router CLAUDE_CODE_USE_* honours the authority's 'yes' grammar", () => {
    const res = resolveProviderWithRouter({
      env: { CLAUDE_CODE_USE_BEDROCK: "yes" },
    })
    expect(res.provider).toBe("bedrock")
    expect(res.reason).toBe("claude-code-use-env")
  })
})
