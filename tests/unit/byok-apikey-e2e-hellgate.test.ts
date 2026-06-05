/**
 * ★ CONTRACT (e2e) — H7-BYOK: minted key flows resolveVendorApiKey → createLLM →
 * adapter. RFC docs/plans/jun-6-byok-apikey-helper.md §6.2.
 *
 *   - The minted key arrives as `opts.apiKey` and `createLLM` builds the legacy
 *     vendor adapter with it (the env key is NOT consulted, even when present).
 *   - A second resolve within the H7 TTL window re-uses the CACHED mint — the
 *     fake shell runs exactly ONCE (the H7 cache, exercised end-to-end).
 *   - knob-off (no source) ⇒ `createLLM` resolves from env, byte-identically.
 *   - empty env + no source ⇒ `MissingApiKeyError` (unchanged legacy contract).
 */
import { describe, expect, test } from "bun:test"
import {
  AnthropicAdapter,
  createCredentialSource,
  createLLM,
  MissingApiKeyError,
  resolveVendorApiKey,
  type ShellExecFn,
  type ShellExecResult,
} from "@/llm"

const ok = (stdout: string): ShellExecResult => ({ stdout, stderr: "", exitCode: 0 })

/** The Anthropic SDK client stores `apiKey` as a public field; reach it through
 *  the adapter to prove the minted key reached `new Anthropic({ apiKey })`. */
const adapterApiKey = (adapter: unknown): string | undefined => {
  const client = (adapter as { client?: { apiKey?: string } }).client
  return client?.apiKey
}

describe("H7-BYOK e2e — mint → resolveVendorApiKey → createLLM → AnthropicAdapter", () => {
  test("minted key is what the adapter is built with (env present but ignored)", async () => {
    const calls: string[] = []
    const shell: ShellExecFn = async (cmd) => {
      calls.push(cmd)
      return ok("sk-minted-123")
    }
    const source = createCredentialSource({
      apiKeyHelper: "mint",
      apiKeyHelperTtlMs: 60_000,
      shellExec: shell,
      isTrusted: () => true,
      now: () => 0,
    })
    const env = { ANTHROPIC_API_KEY: "sk-env-should-be-overridden" }
    const opts = await resolveVendorApiKey("anthropic", { model: "claude-sonnet-4-6" }, source)
    const llm = createLLM("anthropic", opts, env)
    expect(llm).toBeInstanceOf(AnthropicAdapter)
    expect(adapterApiKey(llm)).toBe("sk-minted-123")
    expect(calls).toEqual(["mint"]) // exactly one mint
  })

  test("second resolve within TTL re-uses the cached mint (shell ran ONCE)", async () => {
    const calls: string[] = []
    let n = 0
    const shell: ShellExecFn = async (cmd) => {
      calls.push(cmd)
      return ok(`sk-minted-${++n}`)
    }
    const source = createCredentialSource({
      apiKeyHelper: "mint",
      apiKeyHelperTtlMs: 60_000,
      shellExec: shell,
      isTrusted: () => true,
      now: () => 0, // clock frozen ⇒ always within TTL
    })
    const env = {}
    const a = await resolveVendorApiKey("anthropic", {}, source)
    const b = await resolveVendorApiKey("anthropic", {}, source)
    expect(a.apiKey).toBe("sk-minted-1")
    expect(b.apiKey).toBe("sk-minted-1") // cached — not sk-minted-2
    expect(calls.length).toBe(1)
    // Both build a working adapter from the same minted key.
    expect(adapterApiKey(createLLM("anthropic", a, env))).toBe("sk-minted-1")
    expect(adapterApiKey(createLLM("anthropic", b, env))).toBe("sk-minted-1")
  })

  test("knob-off (no source) ⇒ createLLM resolves from env (byte-identical)", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-env-key" }
    const opts = await resolveVendorApiKey("anthropic", { model: "claude-sonnet-4-6" }, undefined)
    const llm = createLLM("anthropic", opts, env)
    expect(adapterApiKey(llm)).toBe("sk-env-key")
  })

  test("knob-off + empty env ⇒ MissingApiKeyError (unchanged legacy contract)", async () => {
    const opts = await resolveVendorApiKey("anthropic", { model: "m" }, undefined)
    expect(() => createLLM("anthropic", opts, {})).toThrow(MissingApiKeyError)
  })
})
