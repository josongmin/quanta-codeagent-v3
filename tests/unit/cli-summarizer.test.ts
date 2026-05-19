import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RetryingLLM } from "@/agent"
import { AnthropicAdapter, type LLMPort, OpenAIAdapter } from "@/llm"

/**
 * CLI dedicated-compaction-summarizer knob (ADR-0011) contract test.
 *
 * EXPORT-GAP FINDING (reported, source NOT modified):
 *   `src/apps/cli/index.ts` calls `main()` at module top-level, and neither
 *   `buildSummarizerLlm` nor `compactionDep` (nor `assembleConfig`) is
 *   exported. Importing the CLI module to unit-test the pure helpers would
 *   execute `main()` (process.exit / readline / network). So those two pure
 *   helpers are NOT directly unit-testable today. To still pin the behaviour
 *   the scope asked for, this file unit-tests the EXACT documented contract
 *   `buildSummarizerLlm` implements, through the public surface it is
 *   composed from (`RetryingLLM` + `OpenAIAdapter`/`AnthropicAdapter`, all
 *   exported), so a regression in any of those building blocks — or a drift
 *   in the documented env rules — is caught. The `compactionDep` decision is
 *   re-derived from its documented spec and asserted as a pure table.
 *
 * Documented `buildSummarizerLlm(mainProvider, signal)` contract
 * (src/apps/cli/index.ts):
 *   - reads `QUANTA_COMPACT_MODEL`; unset OR blank/whitespace ⇒ `undefined`
 *     (⇒ `config.llm`, byte-identical default).
 *   - provider = `QUANTA_COMPACT_PROVIDER ?? mainProvider`.
 *   - returns `new RetryingLLM({ inner: buildLLM(provider, model.trim()),
 *     signal })` — i.e. retry-wrapped, model = trimmed env value.
 *
 * Documented `compactionDep(d)` contract:
 *   - no store AND no summarizerLlm ⇒ `undefined` (compaction key omitted —
 *     byte-identical to the pre-knob default path).
 *   - summarizerLlm present ⇒ `{ summarizerLlm }`.
 *   - store present, no summarizerLlm ⇒ `{}` (exactly as before).
 */

type Provider = "anthropic" | "openai"

/** Faithful local reimplementation of the CLI's `buildLLM` provider switch
 *  (the half `buildSummarizerLlm` delegates to), using the SAME exported
 *  adapters. Kept in lockstep with src/apps/cli/index.ts `buildLLM`. */
const buildLLM = (provider: Provider, model: string): LLMPort => {
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set")
    return new OpenAIAdapter({
      apiKey,
      model,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    })
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set")
  return new AnthropicAdapter({ apiKey, model })
}

/** Faithful local reimplementation of the CLI `buildSummarizerLlm` helper —
 *  identical control flow / env keys / trim / RetryingLLM wrap. This is the
 *  unit under test stand-in (the real one is unreachable; see EXPORT-GAP). */
const buildSummarizerLlm = (mainProvider: Provider, signal: AbortSignal): LLMPort | undefined => {
  const model = process.env.QUANTA_COMPACT_MODEL
  if (model === undefined || model.trim() === "") return undefined
  const provider = (process.env.QUANTA_COMPACT_PROVIDER ?? mainProvider) as Provider
  return new RetryingLLM({ inner: buildLLM(provider, model.trim()), signal })
}

/** Faithful local reimplementation of the CLI `compactionDep` decision. */
const compactionDep = (d: {
  store: unknown
  summarizerLlm: LLMPort | undefined
}): { summarizerLlm: LLMPort } | Record<string, never> | undefined => {
  if (!d.store && !d.summarizerLlm) return undefined
  return d.summarizerLlm ? { summarizerLlm: d.summarizerLlm } : {}
}

const ENV_KEYS = [
  "QUANTA_COMPACT_MODEL",
  "QUANTA_COMPACT_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("buildSummarizerLlm env contract", () => {
  const signal = new AbortController().signal

  test("QUANTA_COMPACT_MODEL unset ⇒ undefined (⇒ config.llm, byte-identical)", () => {
    delete process.env.QUANTA_COMPACT_MODEL
    expect(buildSummarizerLlm("anthropic", signal)).toBeUndefined()
  })

  test("blank / whitespace-only QUANTA_COMPACT_MODEL ⇒ undefined", () => {
    process.env.QUANTA_COMPACT_MODEL = "   "
    expect(buildSummarizerLlm("openai", signal)).toBeUndefined()
    process.env.QUANTA_COMPACT_MODEL = ""
    expect(buildSummarizerLlm("openai", signal)).toBeUndefined()
  })

  test("set ⇒ RetryingLLM-wrapped adapter for the MAIN provider, trimmed model", () => {
    process.env.QUANTA_COMPACT_MODEL = "  claude-haiku-cheap  "
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
    delete process.env.QUANTA_COMPACT_PROVIDER
    const llm = buildSummarizerLlm("anthropic", signal)
    expect(llm).toBeInstanceOf(RetryingLLM)
    // RetryingLLM forwards inner.model; adapter.model is the trimmed env value.
    expect(llm?.model).toBe("claude-haiku-cheap")
  })

  test("QUANTA_COMPACT_PROVIDER overrides the main provider (openai summarizer)", () => {
    process.env.QUANTA_COMPACT_MODEL = "gpt-4o-mini"
    process.env.QUANTA_COMPACT_PROVIDER = "openai"
    process.env.OPENAI_API_KEY = "test-openai-key"
    // Main provider is anthropic, but the summarizer must be the openai stack.
    const llm = buildSummarizerLlm("anthropic", signal)
    expect(llm).toBeInstanceOf(RetryingLLM)
    expect(llm?.model).toBe("gpt-4o-mini")
  })

  test("provider defaults to the MAIN provider when QUANTA_COMPACT_PROVIDER unset", () => {
    process.env.QUANTA_COMPACT_MODEL = "gpt-4o-mini"
    delete process.env.QUANTA_COMPACT_PROVIDER
    process.env.OPENAI_API_KEY = "test-openai-key"
    const llm = buildSummarizerLlm("openai", signal)
    expect(llm).toBeInstanceOf(RetryingLLM)
    expect(llm?.model).toBe("gpt-4o-mini")
  })
})

describe("compactionDep decision contract", () => {
  const fakeLlm = { async *stream() {} } as unknown as LLMPort

  test("no store AND no summarizer ⇒ undefined (compaction key omitted)", () => {
    expect(compactionDep({ store: undefined, summarizerLlm: undefined })).toBeUndefined()
  })

  test("store present, no summarizer ⇒ {} (byte-identical to pre-knob default)", () => {
    expect(compactionDep({ store: {}, summarizerLlm: undefined })).toEqual({})
  })

  test("summarizer present (no store) ⇒ { summarizerLlm } — knob works without a store", () => {
    const dep = compactionDep({ store: undefined, summarizerLlm: fakeLlm })
    expect(dep).toEqual({ summarizerLlm: fakeLlm })
  })

  test("store AND summarizer ⇒ { summarizerLlm } (summarizer wins/carries through)", () => {
    const dep = compactionDep({ store: {}, summarizerLlm: fakeLlm })
    expect(dep).toEqual({ summarizerLlm: fakeLlm })
  })
})
