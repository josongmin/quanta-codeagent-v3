import { describe, expect, test } from "bun:test";
import { prepareImages, } from "../../src/apps/bench/harness";
const CFG = {
    cacheLevel: "env",
    clean: false,
    maxWorkers: 4,
    namespace: "none",
    forceRebuild: false,
};
const capturingSpawn = (cap, code = 0) => {
    return async (argv) => {
        // The first spawn is the `import swebench` probe; record only the
        // prepare_images invocation (the one with the module name).
        if (argv.includes("swebench.harness.prepare_images"))
            cap.argv = argv;
        return { code, stdout: "Building env image…\nDone.", stderr: "" };
    };
};
const probeOkSpawn = (cap, code = 0) => {
    return async (argv) => {
        if (argv.includes("-c") && argv.includes("import swebench")) {
            return { code: 0, stdout: "", stderr: "" }; // probe passes
        }
        if (argv.includes("swebench.harness.prepare_images"))
            cap.argv = argv;
        return { code, stdout: "ok", stderr: "" };
    };
};
const noEnvDocker = async () => ({ code: 0, stdout: "", stderr: "" });
describe("prepareImages", () => {
    test("ok:true on exit 0", async () => {
        const cap = { argv: [] };
        const r = await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            python: "python",
            spawn: capturingSpawn(cap, 0),
            dockerSpawn: noEnvDocker,
        });
        expect(r.ok).toBe(true);
    });
    test("ok:false on non-zero exit", async () => {
        const cap = { argv: [] };
        const r = await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            python: "python",
            spawn: capturingSpawn(cap, 1),
            dockerSpawn: noEnvDocker,
        });
        expect(r.ok).toBe(false);
    });
    test("argv has dataset + namespace + workers (prepare-safe subset)", async () => {
        const cap = { argv: [] };
        await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            python: "python",
            spawn: capturingSpawn(cap),
            dockerSpawn: noEnvDocker,
        });
        expect(cap.argv).toContain("swebench.harness.prepare_images");
        expect(cap.argv).toContain("--dataset_name");
        expect(cap.argv).toContain("ds");
        expect(cap.argv).toContain("--namespace");
        expect(cap.argv).toContain("none");
        expect(cap.argv).toContain("--max_workers");
        expect(cap.argv).toContain("4");
        // env/instance image tags MUST be "latest" to match run_evaluation's
        // defaults — otherwise the warm cache is a silent tag mismatch.
        expect(cap.argv).toContain("--env_image_tag");
        expect(cap.argv).toContain("--tag");
        const ti = cap.argv.indexOf("--env_image_tag");
        expect(cap.argv[ti + 1]).toBe("latest");
    });
    test("argv does NOT contain run_evaluation-only flags (prepare_images rejects them)", async () => {
        const cap = { argv: [] };
        await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: { ...CFG, clean: true }, // even when clean=true
            python: "python",
            spawn: capturingSpawn(cap),
            dockerSpawn: noEnvDocker,
        });
        // prepare_images --help: no --predictions_path / --run_id / --cache_level / --clean
        expect(cap.argv).not.toContain("--predictions_path");
        expect(cap.argv).not.toContain("--run_id");
        expect(cap.argv).not.toContain("--cache_level");
        expect(cap.argv).not.toContain("--clean");
    });
    test("forceRebuild config ⇒ argv contains --force_rebuild True", async () => {
        const cap = { argv: [] };
        await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: { ...CFG, forceRebuild: true },
            python: "python",
            spawn: capturingSpawn(cap),
            dockerSpawn: noEnvDocker,
        });
        expect(cap.argv).toContain("--force_rebuild");
        expect(cap.argv).toContain("True");
    });
    test("instanceIds ⇒ argv contains --instance_ids a b", async () => {
        const cap = { argv: [] };
        await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            instanceIds: ["a", "b"],
            config: CFG,
            python: "python",
            spawn: capturingSpawn(cap),
            dockerSpawn: noEnvDocker,
        });
        const i = cap.argv.indexOf("--instance_ids");
        expect(i).toBeGreaterThan(-1);
        expect(cap.argv[i + 1]).toBe("a");
        expect(cap.argv[i + 2]).toBe("b");
    });
    test("no python interpreter ⇒ ok:false, descriptive log, never throws", async () => {
        const failProbe = async () => ({ code: 1, stdout: "", stderr: "no swebench" });
        const r = await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            // no explicit python → resolvePython runs the failing probe
            spawn: failProbe,
            dockerSpawn: noEnvDocker,
        });
        expect(r.ok).toBe(false);
        expect(r.log).toContain("no python interpreter");
    });
    test("preexistingEnvImages reflects injected docker list", async () => {
        const cap = { argv: [] };
        const twoEnv = async () => ({
            code: 0,
            stdout: [
                JSON.stringify({ Repository: "sweb.env.x86_64.a", Tag: "latest", ID: "1" }),
                JSON.stringify({ Repository: "sweb.env.x86_64.b", Tag: "latest", ID: "2" }),
                JSON.stringify({ Repository: "sweb.base.x86_64", Tag: "latest", ID: "3" }),
            ].join("\n"),
            stderr: "",
        });
        const r = await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            python: "python",
            spawn: capturingSpawn(cap),
            dockerSpawn: twoEnv,
        });
        expect(r.preexistingEnvImages).toBe(2); // base not counted
    });
    test.skipIf(process.arch !== "arm64")("arm64 host without injected spawn ⇒ skipped with guidance (no doomed local build)", async () => {
        // No `spawn` injected → real path. On arm64 the guard short-circuits
        // BEFORE spawning python (prepare_images would build x86 + crash conda
        // under emulation). dockerSpawn injected so listSwebenchImages is hermetic.
        const r = await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            dockerSpawn: noEnvDocker,
        });
        expect(r.ok).toBe(false);
        expect(r.log).toContain("skipped on arm64");
        expect(r.log).toContain("QUANTA_SWEBENCH_PREPARE_FORCE");
    });
    test("log contains cmd + exit + tail", async () => {
        const cap = { argv: [] };
        const r = await prepareImages({
            predictionsPath: "/tmp/p.jsonl",
            runId: "rid",
            datasetName: "ds",
            config: CFG,
            python: "python",
            spawn: probeOkSpawn(cap, 0),
            dockerSpawn: noEnvDocker,
        });
        expect(r.log).toContain("cmd:");
        expect(r.log).toContain("exit: 0");
        expect(r.log).toContain("stdout(tail):");
    });
});
