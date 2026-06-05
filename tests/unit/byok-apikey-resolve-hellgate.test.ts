/**
 * ★ CONTRACT — H7-BYOK: `apiKeyHelper` mint for the LEGACY vendor key path
 * (`resolveVendorApiKey`, RFC docs/plans/jun-6-byok-apikey-helper.md).
 *
 * The composition-root pre-resolution step that feeds the H7 `mintApiKey()` into
 * the SYNCHRONOUS `createLLM` for the two legacy vendor providers, via
 * `opts.apiKey`. Adversarial / edge contract:
 *
 *   - knob-on (source present) + helper ⇒ the MINTED key is set as `opts.apiKey`
 *     (it later wins over env inside `createLLM`).
 *   - explicit `opts.apiKey` wins over the mint — the mint shell is NEVER run
 *     (0 shell calls).
 *   - knob-off (`source === undefined`) ⇒ the SAME `opts` reference is returned,
 *     no `apiKey` added, mint never called (byte-identical default-OFF).
 *   - helper unset on the source ⇒ `mintApiKey()` returns undefined ⇒ `opts`
 *     unchanged.
 *   - ONLY `anthropic`/`openai` are mintable — `chatgpt-oauth`/`bedrock`/`vertex`
 *     are returned unchanged with ZERO shell calls.
 *   - empty mint (helper exits 0, empty stdout) ⇒ the H7 guard THROWS
 *     `helper-failed`; the env key is NOT clobbered with `""`.
 *   - untrusted ⇒ `mintApiKey()` throws `untrusted`; no key injected (fail-closed).
 *   - NO-LEAK: the minted secret never appears in any thrown error message.
 */
import { describe, expect, test } from "bun:test"
import {
  CredentialHelperError,
  createCredentialSource,
  type Provider,
  resolveVendorApiKey,
  type ShellExecFn,
  type ShellExecResult,
} from "@/llm"

const ok = (stdout: string): ShellExecResult => ({ stdout, stderr: "", exitCode: 0 })

const makeShell = (
  result: (cmd: string) => ShellExecResult = () => ok("sk-minted-default"),
): { exec: ShellExecFn; calls: string[] } => {
  const calls: string[] = []
  const exec: ShellExecFn = async (command) => {
    calls.push(command)
    return result(command)
  }
  return { exec, calls }
}

const trustedSource = (
  shell: ShellExecFn,
  overrides: Partial<{ apiKeyHelper: string; isTrusted: () => boolean }> = {},
) =>
  createCredentialSource({
    apiKeyHelper: "mint-cmd",
    apiKeyHelperTtlMs: 60_000,
    shellExec: shell,
    isTrusted: () => true,
    now: () => 0,
    ...overrides,
  })

describe("H7-BYOK resolveVendorApiKey — mint feeds opts.apiKey (anthropic/openai)", () => {
  test("knob-on + helper ⇒ minted key set as opts.apiKey (overrides env later)", async () => {
    const shell = makeShell(() => ok("sk-minted-123\n"))
    const source = trustedSource(shell.exec)
    const out = await resolveVendorApiKey("anthropic", { model: "claude-sonnet-4-6" }, source)
    expect(out.apiKey).toBe("sk-minted-123")
    // The original opts had no apiKey; the helper minted exactly one.
    expect(shell.calls).toEqual(["mint-cmd"])
  })

  test("openai is mintable too", async () => {
    const shell = makeShell(() => ok("sk-openai-minted"))
    const out = await resolveVendorApiKey("openai", {}, trustedSource(shell.exec))
    expect(out.apiKey).toBe("sk-openai-minted")
    expect(shell.calls.length).toBe(1)
  })

  test("explicit opts.apiKey WINS over the mint — shell never runs", async () => {
    const shell = makeShell(() => ok("sk-minted-should-not-appear"))
    const out = await resolveVendorApiKey(
      "anthropic",
      { apiKey: "sk-explicit-caller" },
      trustedSource(shell.exec),
    )
    expect(out.apiKey).toBe("sk-explicit-caller")
    // The caller hard-pinned a key — the mint is not even consulted.
    expect(shell.calls).toEqual([])
  })

  test("knob-off (source undefined) ⇒ SAME opts reference, no apiKey added", async () => {
    const opts = { model: "claude-sonnet-4-6" }
    const out = await resolveVendorApiKey("anthropic", opts, undefined)
    expect(out).toBe(opts) // ===-identical — byte-identical default-OFF path
    expect("apiKey" in out).toBe(false)
  })

  test("source present but apiKeyHelper unset ⇒ mint returns undefined ⇒ opts unchanged", async () => {
    const shell = makeShell()
    const source = createCredentialSource({
      // no apiKeyHelper configured — only a refresh command
      awsAuthRefresh: "aws sso login",
      shellExec: shell.exec,
      isTrusted: () => true,
      now: () => 0,
    })
    const opts = { model: "claude-sonnet-4-6" }
    const out = await resolveVendorApiKey("anthropic", opts, source)
    expect(out).toBe(opts)
    expect("apiKey" in out).toBe(false)
    expect(shell.calls).toEqual([]) // mint helper unset ⇒ no shell
  })

  test("non-mintable providers skipped (0 shell calls, opts unchanged)", async () => {
    const nonMintable: Provider[] = ["chatgpt-oauth"]
    for (const provider of nonMintable) {
      const shell = makeShell(() => ok("sk-should-not-mint"))
      const opts = { model: "m" }
      const out = await resolveVendorApiKey(provider, opts, trustedSource(shell.exec))
      expect(out).toBe(opts)
      expect(shell.calls).toEqual([])
    }
  })

  test("cloud-transport ids would also be skipped (cast — they use refreshCloudCreds)", async () => {
    // bedrock/vertex are NOT in the legacy Provider union; the guard is a Set
    // membership over Provider, so any non-anthropic/openai value is skipped.
    const shell = makeShell(() => ok("sk-should-not-mint"))
    const opts = { model: "m" }
    const out = await resolveVendorApiKey(
      "bedrock" as unknown as Provider,
      opts,
      trustedSource(shell.exec),
    )
    expect(out).toBe(opts)
    expect(shell.calls).toEqual([])
  })

  test("empty mint (exit 0, empty stdout) ⇒ throws helper-failed; env NOT clobbered", async () => {
    const shell = makeShell(() => ok("   \n")) // whitespace-only ⇒ empty after trim
    const source = trustedSource(shell.exec)
    let thrown: unknown
    try {
      await resolveVendorApiKey("anthropic", { model: "m" }, source)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CredentialHelperError)
    expect((thrown as CredentialHelperError).code).toBe("helper-failed")
    // The mint threw BEFORE producing a key, so a downstream env key is never
    // shadowed with "" — the caller surfaces the typed error instead.
  })

  test("untrusted ⇒ throws untrusted; no key injected (fail-closed)", async () => {
    const shell = makeShell(() => ok("sk-minted"))
    const source = trustedSource(shell.exec, { isTrusted: () => false })
    let thrown: unknown
    try {
      await resolveVendorApiKey("anthropic", { model: "m" }, source)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CredentialHelperError)
    expect((thrown as CredentialHelperError).code).toBe("untrusted")
    expect(shell.calls).toEqual([]) // shell never invoked when untrusted
  })

  test("NO-LEAK: the minted secret never appears in a thrown error message", async () => {
    // A non-zero exit ⇒ helper-failed; the secret-bearing stdout must be dropped.
    const SECRET = "sk-super-secret-leak-canary-9999"
    const shell: ShellExecFn = async () => ({ stdout: SECRET, stderr: SECRET, exitCode: 7 })
    const source = trustedSource(shell)
    let thrown: unknown
    try {
      await resolveVendorApiKey("anthropic", { model: "m" }, source)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CredentialHelperError)
    const msg = String((thrown as Error).message) + JSON.stringify(thrown)
    expect(msg).not.toContain(SECRET)
  })
})
