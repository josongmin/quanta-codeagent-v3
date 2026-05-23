/**
 * RFC may-22-unified-agent-runtime / Phase 4+ — batch mode-preset runner
 * contract.
 *
 * Pins the contract:
 *   1. `runMode` rejects a non-"batch" req.mode.
 *   2. Missing `req.batch.corpus` throws.
 *   3. With `seams.loadCorpus` + `seams.runInstance`, runMode iterates EACH
 *      instance through the stub driver and aggregates verdicts.
 *   4. Exit code: 0 iff all instances passed (no failures, no degraded).
 *   5. Optional id-substring filter selects a subset BEFORE limit slice.
 *   6. Test is hermetic — no real bench driver, no real LLM, no fs writes.
 */
import { describe, expect, test } from "bun:test";
import { runMode } from "@/../src/apps/agent/mode-presets/batch";
import { defaultTools, ToolRegistry } from "@/tool";
const fakeLlm = { model: "test", stream: async function* () { } };
const recordingStream = { emit: () => undefined };
const inst = (id) => ({
    id,
    repoPath: `/tmp/${id}`,
    problemStatement: `fix ${id}`,
    testCmd: "true",
});
const okResult = (id) => ({ id, passed: true, patch: "", turns: 1 });
const failResult = (id) => ({ id, passed: false, patch: "", turns: 1 });
const baseReq = (over = {}) => ({
    mode: "batch",
    base: {
        llm: fakeLlm,
        registry: new ToolRegistry(defaultTools),
        stream: recordingStream,
        permission: { mode: "acceptEdits" },
        messages: [],
        system: "",
        cwd: "/tmp",
        maxTurns: 5,
        signal: new AbortController().signal,
    },
    batch: { corpus: "/synthetic/corpus" },
    ...over,
});
describe("batch.runMode — guard", () => {
    test("rejects a wrong req.mode", async () => {
        const req = { ...baseReq(), mode: "headless" };
        await expect(runMode(req)).rejects.toThrow(/req.mode must be "batch"/);
    });
    test("rejects a missing corpus", async () => {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately stripping a required field for the negative test.
        const req = { ...baseReq(), batch: undefined };
        await expect(runMode(req)).rejects.toThrow(/req.batch.corpus is required/);
    });
});
describe("batch.runMode — iteration + aggregation", () => {
    test("iterates every instance through stub runInstance", async () => {
        const calls = [];
        const seams = {
            loadCorpus: async () => [inst("a"), inst("b"), inst("c")],
            runInstance: async (i) => {
                const ii = i;
                calls.push(ii.id);
                return okResult(ii.id);
            },
        };
        const out = await runMode(baseReq({ seams }));
        expect(calls).toEqual(["a", "b", "c"]);
        expect(out.exitCode).toBe(0);
    });
    test("exit code = 1 when ANY instance fails", async () => {
        const seams = {
            loadCorpus: async () => [inst("a"), inst("b")],
            runInstance: async (i) => {
                const ii = i;
                return (ii.id === "b" ? failResult(ii.id) : okResult(ii.id));
            },
        };
        const out = await runMode(baseReq({ seams }));
        expect(out.exitCode).toBe(1);
    });
    test("exit code = 1 when an instance has verdict=degraded", async () => {
        const seams = {
            loadCorpus: async () => [inst("a")],
            runInstance: async () => {
                const r = {
                    id: "a",
                    passed: true,
                    patch: "",
                    turns: 1,
                    verdict: "degraded",
                };
                return r;
            },
        };
        const out = await runMode(baseReq({ seams }));
        expect(out.exitCode).toBe(1);
    });
    test("empty corpus returns exitCode 0 (no-op)", async () => {
        const seams = {
            loadCorpus: async () => [],
            runInstance: async () => okResult("x"),
        };
        const out = await runMode(baseReq({ seams }));
        expect(out.exitCode).toBe(0);
    });
});
describe("batch.runMode — id-substring filter + limit", () => {
    test("filters by req.batch.instance substring", async () => {
        const calls = [];
        const seams = {
            loadCorpus: async () => [inst("django-1"), inst("flask-2"), inst("django-3")],
            runInstance: async (i) => {
                calls.push(i.id);
                return okResult(i.id);
            },
        };
        await runMode(baseReq({ seams, batch: { corpus: "/c", instance: "django" } }));
        expect(calls).toEqual(["django-1", "django-3"]);
    });
    test("limit slice caps the iteration", async () => {
        const calls = [];
        const seams = {
            loadCorpus: async () => [inst("a"), inst("b"), inst("c"), inst("d")],
            runInstance: async (i) => {
                calls.push(i.id);
                return okResult(i.id);
            },
        };
        await runMode(baseReq({ seams, batch: { corpus: "/c", limit: 2 } }));
        expect(calls).toEqual(["a", "b"]);
    });
});
