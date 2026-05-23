/**
 * Eval decompose shape pin — locks down the post-refactor module surface so a
 * future cleanup pass cannot silently fold a sub-module back into a monolith
 * without showing intent.
 *
 * Asserts:
 *   1. each new eval/ module exports the helpers the driver leans on (single
 *      responsibility surface);
 *   2. `runInstance` (from `apps/bench/eval`) returns the SAME result-shape
 *      keys it did pre-decompose (run a synthetic instance against a mock LLM
 *      that does nothing — patch is "", passed:false, but the shape is fixed).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnvPrep } from "../../../src/apps/bench/eval/env-prep";
import { exec, execArgv, trimOut } from "../../../src/apps/bench/eval/exec";
import { runInstance } from "../../../src/apps/bench/eval/index";
import { buildWiring, NullStream, ObservationError } from "../../../src/apps/bench/eval/report";
import { cleanupSandbox, copyRepo, createSandbox } from "../../../src/apps/bench/eval/sandbox";
import { GIT_ARGV, gatherSandbox, gitStageAndDiffCached, sourceOnlyDiff, withGitSnapshot, } from "../../../src/apps/bench/eval/snapshot";
import { verify } from "../../../src/apps/bench/eval/verdict";
describe("eval/ sub-slice decompose — module surface", () => {
    test("eval/exec exports exec + execArgv + trimOut", () => {
        expect(typeof exec).toBe("function");
        expect(typeof execArgv).toBe("function");
        expect(typeof trimOut).toBe("function");
    });
    test("eval/sandbox exports createSandbox + copyRepo + cleanupSandbox", () => {
        expect(typeof createSandbox).toBe("function");
        expect(typeof copyRepo).toBe("function");
        expect(typeof cleanupSandbox).toBe("function");
    });
    test("eval/snapshot exports withGitSnapshot + gitStageAndDiffCached + sourceOnlyDiff + gatherSandbox + GIT_ARGV", () => {
        expect(typeof withGitSnapshot).toBe("function");
        expect(typeof gitStageAndDiffCached).toBe("function");
        expect(typeof sourceOnlyDiff).toBe("function");
        expect(typeof gatherSandbox).toBe("function");
        expect(Array.isArray(GIT_ARGV)).toBe(true);
        expect(GIT_ARGV[0]).toBe("git");
    });
    test("eval/env-prep exports runEnvPrep returning {ok:true} for empty setupCmd", async () => {
        expect(typeof runEnvPrep).toBe("function");
        const tmp = mkdtempSync(join(tmpdir(), "eval-shape-"));
        try {
            const r = await runEnvPrep({ id: "x", repoPath: tmp, problemStatement: "p", testCmd: "true" }, tmp, 5000);
            expect(r.ok).toBe(true);
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
    test("eval/verdict exports verify (function)", () => {
        expect(typeof verify).toBe("function");
    });
    test("eval/report exports NullStream + ObservationError + buildWiring", () => {
        expect(typeof NullStream).toBe("function"); // class
        expect(typeof ObservationError).toBe("function"); // class
        expect(typeof buildWiring).toBe("function");
        // NullStream.emit is a no-op (silent runs)
        const ns = new NullStream();
        expect(() => ns.emit({ type: "text_delta", delta: "x", seq: 0, ctx: {}, ts: 0 })).not.toThrow();
    });
    test("sourceOnlyDiff drops test-file hunks (regression pin moved to snapshot.ts)", () => {
        const diff = [
            "diff --git a/src/foo.py b/src/foo.py",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/tests/test_x.py b/tests/test_x.py",
            "@@ -1 +1 @@",
            "-x",
            "+y",
        ].join("\n");
        const out = sourceOnlyDiff(diff);
        expect(out).toContain("src/foo.py");
        expect(out).not.toContain("tests/test_x.py");
    });
});
/** Minimal LLM that yields zero turns — patches nothing, exits the loop. */
class NoopLLM {
    async *stream(_input) {
        yield { type: "text_delta", delta: "" };
        yield { type: "message_stop", stop_reason: "end_turn" };
    }
}
describe("runInstance public-shape invariant (apps/bench/eval barrel)", () => {
    test("runInstance returns InstanceResult-shaped object with id/passed/patch/turns", async () => {
        const dir = mkdtempSync(join(tmpdir(), "eval-shape-run-"));
        try {
            // Synthetic instance: trivially-failing testCmd, no swebench metadata,
            // empty repo. The agent does nothing → empty patch → passed:false.
            writeFileSync(join(dir, "marker"), "");
            const instance = {
                id: "shape-1",
                repoPath: dir,
                problemStatement: "Do nothing.",
                testCmd: "false",
            };
            const result = await runInstance(instance, {
                llm: new NoopLLM(),
                maxTurns: 1,
                timeoutMs: 20_000,
            });
            // Public-shape pins — these keys + types are the API contract.
            expect(typeof result.id).toBe("string");
            expect(result.id).toBe("shape-1");
            expect(typeof result.passed).toBe("boolean");
            expect(typeof result.patch).toBe("string");
            expect(typeof result.turns).toBe("number");
            // No-op agent + failing testCmd ⇒ passed:false. Patch may be empty or a
            // tiny diff depending on git state; the contract is type/keys, not value.
            expect(result.passed).toBe(false);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
