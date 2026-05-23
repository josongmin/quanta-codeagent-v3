/**
 * Real-corpus loader + official Python-harness seam + --dry-run plan.
 *
 * Fully hermetic: no network, no real Python, no Docker, no LLM. The Python
 * harness is exercised through its injectable `spawn`/`probe` boundary; the
 * real-corpus sub-assertion self-skips when the corpus env is unset/absent so
 * the suite stays green anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus, writeSyntheticRealCorpus } from "../../src/apps/bench/corpus/loader";
import { buildDryRunPlan, formatDryRunPlan } from "../../src/apps/bench/dry-run";
import { evaluateWithPythonSwebench, isPythonSwebenchAvailable, SWEBENCH_VERIFIED_DATASET, } from "../../src/apps/bench/python-swebench";
const mkInstance = (over = {}, opts = {}) => {
    const base = {
        id: "demo__demo-1",
        repoPath: "/tmp/does-not-matter",
        problemStatement: "fix it",
        testCmd: "true",
        ...(opts.noSwebench
            ? {}
            : {
                swebench: { instanceId: "demo__demo-1", repo: "demo/demo", baseCommit: "0".repeat(40) },
            }),
    };
    return { ...base, ...over };
};
describe("bench-eval: real corpus loader", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "bench-eval-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    test("(a) loadCorpus parses a dir laid out in the REAL discovered format", async () => {
        const cacheDir = join(dir, "cache", "demo");
        await writeSyntheticRealCorpus(dir, cacheDir);
        const corpus = await loadCorpus(dir);
        expect(corpus).toHaveLength(1);
        const inst = corpus[0];
        expect(inst.id).toBe("py.repo.swebench_demo.001");
        expect(inst.repoPath).toBe(cacheDir);
        expect(inst.problemStatement).toContain("demo bug");
        expect(inst.testCmd).toBe("python -m pytest -q test_mod.py");
        expect(inst.swebench).toEqual({
            instanceId: "demo__demo-1",
            repo: "demo/demo",
            baseCommit: "0".repeat(40),
            environmentSetupCommit: "1".repeat(40),
        });
    });
    test("(a') a task whose repo_ref has no cached checkout is skipped", async () => {
        const cacheDir = join(dir, "cache", "demo");
        await writeSyntheticRealCorpus(dir, cacheDir);
        // Point the only task at an unknown repo by nuking the repo manifest dir.
        rmSync(join(dir, "external"), { recursive: true, force: true });
        expect(await loadCorpus(dir)).toEqual([]);
    });
    // W1-A audit fix: previous body had `expect(true).toBe(true); return` for
    // the missing-env path — passing without any assertion of intent. We now
    // use `test.skipIf` so the runner surface a real `skipped` count when the
    // optional env is unset, instead of pretending the test ran.
    const benchCorpusEnv = process.env.QUANTA_SWEBENCH_CORPUS_ROOT;
    const benchCorpusAvailable = Boolean(benchCorpusEnv && existsSync(benchCorpusEnv));
    test.skipIf(!benchCorpusAvailable)("(b) loadCorpus on the real $QUANTA_SWEBENCH_CORPUS_ROOT (if present)", async () => {
        const root = benchCorpusEnv;
        const corpus = await loadCorpus(root);
        expect(corpus.length).toBeGreaterThanOrEqual(1);
        const first = corpus[0];
        expect(first.id.length).toBeGreaterThan(0);
        expect(first.problemStatement.length).toBeGreaterThan(0);
        expect(first.testCmd.length).toBeGreaterThan(0);
        expect(existsSync(first.repoPath)).toBe(true);
    });
    test("missing/empty root still → [] (unchanged contract)", async () => {
        expect(await loadCorpus(join(dir, "nope"))).toEqual([]);
        expect(await loadCorpus("")).toEqual([]);
    });
});
describe("bench-eval: python swebench seam (hermetic)", () => {
    test("(c) availability false → evaluate returns resolved:false, no throw", async () => {
        const probe = async () => false;
        const r = await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { probe });
        expect(r.resolved).toBe(false);
        expect(r.log).toContain("unavailable");
    });
    test("(c') isPythonSwebenchAvailable false when no interpreter imports swebench", async () => {
        const spawn = async () => ({ code: 1, stdout: "", stderr: "ModuleNotFoundError" });
        expect(await isPythonSwebenchAvailable({ spawn })).toBe(false);
    });
    test("empty prediction → resolved:false (never invokes the harness)", async () => {
        let spawned = false;
        const spawn = async () => {
            spawned = true;
            return { code: 0, stdout: "", stderr: "" };
        };
        const r = await evaluateWithPythonSwebench(mkInstance(), "   ", { spawn });
        expect(r.resolved).toBe(false);
        expect(spawned).toBe(false);
    });
    test("non-swebench instance → resolved:false (no metadata)", async () => {
        const r = await evaluateWithPythonSwebench(mkInstance({}, { noSwebench: true }), "diff --git a b");
        expect(r.resolved).toBe(false);
        expect(r.log).toContain("no swebench metadata");
    });
    test("fake harness reports resolved → resolved:true, parsed from report json", async () => {
        const spawn = async (argv, cwd) => {
            if (argv.includes("import swebench"))
                return { code: 0, stdout: "", stderr: "" };
            // Emulate the harness writing its report json into cwd.
            await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: ["demo__demo-1"] }));
            return { code: 0, stdout: "graded", stderr: "" };
        };
        const r = await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { spawn });
        expect(r.resolved).toBe(true);
        expect(r.log).toContain("resolved_ids");
    });
    test("fake harness with empty report → resolved:false (caller falls back)", async () => {
        const spawn = async (argv, cwd) => {
            if (argv.includes("import swebench"))
                return { code: 0, stdout: "", stderr: "" };
            await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: [] }));
            return { code: 0, stdout: "", stderr: "" };
        };
        const r = await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { spawn });
        expect(r.resolved).toBe(false);
    });
    test("defaults --dataset_name to SWE-bench Verified when opts.datasetName unset", async () => {
        expect(SWEBENCH_VERIFIED_DATASET).toBe("princeton-nlp/SWE-bench_Verified");
        let harnessArgv = [];
        const spawn = async (argv, cwd) => {
            if (argv.includes("import swebench"))
                return { code: 0, stdout: "", stderr: "" };
            harnessArgv = argv;
            await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: [] }));
            return { code: 0, stdout: "", stderr: "" };
        };
        await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", { spawn });
        const i = harnessArgv.indexOf("--dataset_name");
        expect(i).toBeGreaterThan(-1);
        expect(harnessArgv[i + 1]).toBe("princeton-nlp/SWE-bench_Verified");
    });
    test("explicit opts.datasetName overrides the Verified default", async () => {
        let harnessArgv = [];
        const spawn = async (argv, cwd) => {
            if (argv.includes("import swebench"))
                return { code: 0, stdout: "", stderr: "" };
            harnessArgv = argv;
            await Bun.write(join(cwd, "quanta.run.json"), JSON.stringify({ resolved_ids: [] }));
            return { code: 0, stdout: "", stderr: "" };
        };
        await evaluateWithPythonSwebench(mkInstance(), "diff --git a b", {
            spawn,
            datasetName: "princeton-nlp/SWE-bench_Lite",
        });
        const i = harnessArgv.indexOf("--dataset_name");
        expect(harnessArgv[i + 1]).toBe("princeton-nlp/SWE-bench_Lite");
    });
    test("runner falls back to local testCmd when harness unavailable (no throw)", async () => {
        const repo = mkdtempSync(join(tmpdir(), "bench-eval-repo-"));
        try {
            await mkdir(repo, { recursive: true });
            const { runInstance } = await import("../../src/apps/bench/eval");
            const noopLLM = {
                async *stream() {
                    yield { type: "text_delta", delta: "noop" };
                    yield { type: "message_stop", stop_reason: "end_turn" };
                },
            };
            const result = await runInstance(mkInstance({ repoPath: repo, testCmd: "true" }), {
                llm: noopLLM,
                maxTurns: 2,
                timeoutMs: 20000,
                pythonSwebench: { opts: { probe: async () => false } },
            });
            // probe=false ⇒ evaluate returns resolved:false; verify() never throws.
            expect(result.passed).toBe(false);
            expect(typeof result.patch).toBe("string");
        }
        finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
describe("bench-eval: --dry-run plan", () => {
    const insts = [
        mkInstance({ id: "a" }),
        mkInstance({ id: "b" }),
        mkInstance({ id: "c" }),
    ];
    test("(d) buildDryRunPlan shape with a limit", () => {
        const plan = buildDryRunPlan("/corpus", insts, { n: 5, limit: 2, pythonHarness: true });
        expect(plan).toEqual({
            corpusRoot: "/corpus",
            total: 3,
            selected: 2,
            n: 5,
            limit: 2,
            pythonHarness: true,
            sample: ["a", "b"],
        });
    });
    test("(d') no limit selects all; unset root labelled; lines render", () => {
        const plan = buildDryRunPlan("", insts, { n: 1, limit: null, pythonHarness: false });
        expect(plan.corpusRoot).toBe("(unset)");
        expect(plan.selected).toBe(3);
        const lines = formatDryRunPlan(plan);
        expect(lines[0]).toContain("NO LLM will be called");
        expect(lines.join("\n")).toContain("verifier: local testCmd");
        expect(lines.join("\n")).toContain("sample ids: a, b, c");
    });
    test("empty corpus → selected 0, sample (none)", () => {
        const lines = formatDryRunPlan(buildDryRunPlan("/x", [], { n: 1, limit: null, pythonHarness: false }));
        expect(lines.join("\n")).toContain("0 loaded, 0 selected");
        expect(lines.join("\n")).toContain("sample ids: (none)");
    });
});
