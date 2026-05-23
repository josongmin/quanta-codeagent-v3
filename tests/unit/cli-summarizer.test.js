import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RetryingLLM } from "@/agent";
import { buildSummarizerLlm, compactionDep } from "../../src/apps/cli/internal";
/**
 * CLI dedicated-compaction-summarizer knob (ADR-0011) contract test.
 *
 * ADR-0024 (export-gap L2-C → L3 closure): the CLI helpers
 * `buildSummarizerLlm` and `compactionDep` now live in
 * `src/apps/cli/internal.ts` and are imported as the real implementation
 * here. The earlier local re-implementation has been removed — this test now
 * verifies the actual production code, so a regression in the env-parsing /
 * retry-wrap / decision logic is caught directly (not via a parallel copy).
 *
 * Documented `buildSummarizerLlm(mainProvider, signal)` contract
 * (src/apps/cli/internal.ts):
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
const ENV_KEYS = [
    "QUANTA_COMPACT_MODEL",
    "QUANTA_COMPACT_PROVIDER",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_BASE_URL",
];
const saved = {};
beforeEach(() => {
    for (const k of ENV_KEYS)
        saved[k] = process.env[k];
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined)
            delete process.env[k];
        else
            process.env[k] = saved[k];
    }
});
describe("buildSummarizerLlm env contract", () => {
    const signal = new AbortController().signal;
    test("QUANTA_COMPACT_MODEL unset ⇒ undefined (⇒ config.llm, byte-identical)", () => {
        delete process.env.QUANTA_COMPACT_MODEL;
        expect(buildSummarizerLlm("anthropic", signal)).toBeUndefined();
    });
    test("blank / whitespace-only QUANTA_COMPACT_MODEL ⇒ undefined", () => {
        process.env.QUANTA_COMPACT_MODEL = "   ";
        expect(buildSummarizerLlm("openai", signal)).toBeUndefined();
        process.env.QUANTA_COMPACT_MODEL = "";
        expect(buildSummarizerLlm("openai", signal)).toBeUndefined();
    });
    test("set ⇒ RetryingLLM-wrapped adapter for the MAIN provider, trimmed model", () => {
        process.env.QUANTA_COMPACT_MODEL = "  claude-haiku-cheap  ";
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        delete process.env.QUANTA_COMPACT_PROVIDER;
        const llm = buildSummarizerLlm("anthropic", signal);
        expect(llm).toBeInstanceOf(RetryingLLM);
        // RetryingLLM forwards inner.model; adapter.model is the trimmed env value.
        expect(llm?.model).toBe("claude-haiku-cheap");
    });
    test("QUANTA_COMPACT_PROVIDER overrides the main provider (openai summarizer)", () => {
        process.env.QUANTA_COMPACT_MODEL = "gpt-4o-mini";
        process.env.QUANTA_COMPACT_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "test-openai-key";
        // Main provider is anthropic, but the summarizer must be the openai stack.
        const llm = buildSummarizerLlm("anthropic", signal);
        expect(llm).toBeInstanceOf(RetryingLLM);
        expect(llm?.model).toBe("gpt-4o-mini");
    });
    test("provider defaults to the MAIN provider when QUANTA_COMPACT_PROVIDER unset", () => {
        process.env.QUANTA_COMPACT_MODEL = "gpt-4o-mini";
        delete process.env.QUANTA_COMPACT_PROVIDER;
        process.env.OPENAI_API_KEY = "test-openai-key";
        const llm = buildSummarizerLlm("openai", signal);
        expect(llm).toBeInstanceOf(RetryingLLM);
        expect(llm?.model).toBe("gpt-4o-mini");
    });
});
describe("compactionDep decision contract", () => {
    const fakeLlm = { async *stream() { } };
    // A minimal PersistentStorePort stand-in — compactionDep only checks
    // truthiness, so an empty object is sufficient for the decision logic.
    const fakeStore = {};
    test("no store AND no summarizer ⇒ undefined (compaction key omitted)", () => {
        expect(compactionDep({ store: undefined, summarizerLlm: undefined })).toBeUndefined();
    });
    test("store present, no summarizer ⇒ {} (byte-identical to pre-knob default)", () => {
        expect(compactionDep({ store: fakeStore, summarizerLlm: undefined })).toEqual({});
    });
    test("summarizer present (no store) ⇒ { summarizerLlm } — knob works without a store", () => {
        const dep = compactionDep({ store: undefined, summarizerLlm: fakeLlm });
        expect(dep).toEqual({ summarizerLlm: fakeLlm });
    });
    test("store AND summarizer ⇒ { summarizerLlm } (summarizer wins/carries through)", () => {
        const dep = compactionDep({ store: fakeStore, summarizerLlm: fakeLlm });
        expect(dep).toEqual({ summarizerLlm: fakeLlm });
    });
});
