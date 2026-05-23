/**
 * Pin the bench failure classifier contract. The classifier is the *only*
 * place that turns a raw `InstanceResult` + its trajectory into the structured
 * tag bench-report.json and the operator console show — a silent drift in any
 * detector would invalidate every recorded baseline. Each test below pins one
 * detector against a synthetic JSONL fixture (no real LLM, no real harness).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, classify, } from "@/../src/apps/bench/corpus/failure-classifier";
/** Build an InstanceResult + matching .patch/.jsonl pair on disk. The
 *  classifier discovers the trajectory from `patchPath` (`.patch` → `.jsonl`),
 *  so the helper returns a `cleanup()` to remove the tmp dir after each test. */
const setup = (result, events) => {
    const dir = mkdtempSync(join(tmpdir(), "bench-classifier-"));
    const patchPath = join(dir, `${result.id}.0.patch`);
    const trajectoryPath = join(dir, `${result.id}.0.jsonl`);
    writeFileSync(patchPath, result.patch);
    writeFileSync(trajectoryPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    return {
        result: { ...result, patchPath },
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
};
const sessionEnd = (reason, turns) => ({
    kind: "session_end",
    data: { reason, turns },
});
const toolCall = (name, input = {}) => ({
    kind: "tool_call",
    data: { name, input },
});
const toolResult = (result) => ({
    kind: "tool_result",
    data: { result },
});
describe("classify — termination axis", () => {
    test("passed result → termination:passed, signals:[]", () => {
        const r = { id: "x", passed: true, patch: "", turns: 5 };
        expect(classify(r)).toEqual({ termination: "passed", signals: [] });
    });
    test("InstanceResult.error set → harness_error (no trajectory read needed)", () => {
        const r = {
            id: "x",
            passed: false,
            patch: "",
            turns: 0,
            error: "setup failed (code 1): /bin/sh: bad command",
        };
        expect(classify(r).termination).toBe("harness_error");
    });
    test("session_end aborted + turns=0 → hung_stream", () => {
        const { result, cleanup } = setup({ id: "hung", passed: false, patch: "", turns: 0 }, [
            sessionEnd("aborted", 0),
        ]);
        try {
            expect(classify(result).termination).toBe("hung_stream");
        }
        finally {
            cleanup();
        }
    });
    test("session_end max_turns → max_turns_exhausted", () => {
        const { result, cleanup } = setup({ id: "mt", passed: false, patch: "diff --git a/x b/x\n", turns: 25 }, [toolCall("edit"), toolResult("ok"), sessionEnd("max_turns", 25)]);
        try {
            expect(classify(result).termination).toBe("max_turns_exhausted");
        }
        finally {
            cleanup();
        }
    });
    test("session_end completed + !passed → completed_unresolved", () => {
        const { result, cleanup } = setup({ id: "cu", passed: false, patch: "diff --git a/x b/x\n", turns: 4 }, [toolCall("edit"), toolResult("ok"), sessionEnd("completed", 4)]);
        try {
            expect(classify(result).termination).toBe("completed_unresolved");
        }
        finally {
            cleanup();
        }
    });
    test("missing trajectory (no observe) → unknown", () => {
        const r = { id: "x", passed: false, patch: "", turns: 0 };
        expect(classify(r).termination).toBe("unknown");
    });
});
describe("classify — patch-only signals", () => {
    test("empty_patch fires when patch is whitespace", () => {
        const r = { id: "x", passed: false, patch: "   \n\n", turns: 3 };
        expect(classify(r).signals).toContain("empty_patch");
    });
    test("dirty_cache_leak fires when every diff path is build/cache-shaped", () => {
        const patch = [
            "diff --git a/outputs/smoke/repo/worktree b/outputs/smoke/repo/worktree",
            "new file mode 160000",
            "--- /dev/null",
            "+++ b/outputs/smoke/repo/worktree",
            "@@ -0,0 +1 @@",
            "+Subproject commit b9cf764be62e77b4777b3a75ec256f6209a57671",
        ].join("\n");
        const r = { id: "x", passed: false, patch, turns: 0 };
        const c = classify(r);
        expect(c.signals).toContain("dirty_cache_leak");
        expect(c.signals).not.toContain("empty_patch");
    });
    test("dirty_cache_leak does NOT fire when one diff path is source-shaped", () => {
        const patch = [
            "diff --git a/outputs/x b/outputs/x",
            "+something",
            "diff --git a/src/real.py b/src/real.py",
            "+pass",
        ].join("\n");
        const r = { id: "x", passed: false, patch, turns: 1 };
        expect(classify(r).signals).not.toContain("dirty_cache_leak");
    });
    test("multi_file_drift fires at ≥3 distinct edited files", () => {
        const patch = [
            "diff --git a/a.py b/a.py",
            "+x",
            "diff --git a/b.py b/b.py",
            "+y",
            "diff --git a/c.py b/c.py",
            "+z",
        ].join("\n");
        const r = { id: "x", passed: false, patch, turns: 5 };
        expect(classify(r).signals).toContain("multi_file_drift");
    });
    test("multi_file_drift does NOT fire at 2 files", () => {
        const patch = "diff --git a/a.py b/a.py\n+x\ndiff --git a/b.py b/b.py\n+y\n";
        const r = { id: "x", passed: false, patch, turns: 5 };
        expect(classify(r).signals).not.toContain("multi_file_drift");
    });
});
describe("classify — trajectory signals", () => {
    test("verify_loop_stuck fires on ≥5 trailing bash/test_runner calls with no edit between", () => {
        const events = [
            toolCall("edit", { path: "x" }),
            toolResult("ok"),
            toolCall("bash", { command: "pytest" }),
            toolResult("err"),
            toolCall("test_runner"),
            toolResult("err"),
            toolCall("bash", { command: "pip install flask" }),
            toolResult("err"),
            toolCall("bash", { command: "python3 -m pip install flask" }),
            toolResult("err"),
            toolCall("bash", { command: "pip install -e ." }),
            toolResult("err"),
            sessionEnd("completed", 6),
        ];
        const { result, cleanup } = setup({ id: "p", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 6 }, events);
        try {
            expect(classify(result).signals).toContain("verify_loop_stuck");
        }
        finally {
            cleanup();
        }
    });
    test("verify_loop_stuck does NOT fire when an edit interleaves the trailing bash", () => {
        const events = [
            toolCall("bash"),
            toolResult("err"),
            toolCall("bash"),
            toolResult("err"),
            toolCall("bash"),
            toolResult("err"),
            toolCall("bash"),
            toolResult("err"),
            toolCall("edit"),
            toolResult("ok"),
            toolCall("bash"),
            toolResult("err"),
            sessionEnd("completed", 6),
        ];
        const { result, cleanup } = setup({ id: "p", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 6 }, events);
        try {
            expect(classify(result).signals).not.toContain("verify_loop_stuck");
        }
        finally {
            cleanup();
        }
    });
    test("search_thrashing fires on ≥5 consecutive empty glob/grep before any read", () => {
        const events = [
            ...Array.from({ length: 5 }, () => [toolCall("glob"), toolResult("")]).flat(),
            toolCall("localize"),
            toolResult("src/found.py"),
            toolCall("read"),
            toolResult("...file content..."),
            sessionEnd("max_turns", 25),
        ];
        const { result, cleanup } = setup({ id: "s", passed: false, patch: "diff --git a/x b/x\n", turns: 25 }, events);
        try {
            expect(classify(result).signals).toContain("search_thrashing");
        }
        finally {
            cleanup();
        }
    });
    test("search_thrashing does NOT fire when each search yields a non-empty result", () => {
        const events = [
            toolCall("glob"),
            toolResult("src/a.py"),
            toolCall("glob"),
            toolResult("src/b.py"),
            toolCall("read"),
            toolResult("..."),
            sessionEnd("completed", 3),
        ];
        const { result, cleanup } = setup({ id: "s", passed: false, patch: "diff --git a/x b/x\n", turns: 3 }, events);
        try {
            expect(classify(result).signals).not.toContain("search_thrashing");
        }
        finally {
            cleanup();
        }
    });
    test("search_thrashing stops counting once a read/edit fires (no false positives mid-run)", () => {
        const events = [
            toolCall("glob"),
            toolResult(""),
            toolCall("glob"),
            toolResult(""),
            toolCall("read"),
            toolResult("..."),
            // 5+ empty globs AFTER read should NOT trigger — the lead-in scope ended.
            ...Array.from({ length: 6 }, () => [toolCall("glob"), toolResult("")]).flat(),
            sessionEnd("completed", 10),
        ];
        const { result, cleanup } = setup({ id: "s", passed: false, patch: "diff --git a/x b/x\n", turns: 10 }, events);
        try {
            expect(classify(result).signals).not.toContain("search_thrashing");
        }
        finally {
            cleanup();
        }
    });
});
describe("aggregate", () => {
    test("counts each termination once and each signal once-per-occurrence", () => {
        const classifications = [
            { termination: "hung_stream", signals: ["dirty_cache_leak"] },
            { termination: "completed_unresolved", signals: ["verify_loop_stuck"] },
            { termination: "max_turns_exhausted", signals: ["search_thrashing"] },
            { termination: "completed_unresolved", signals: ["verify_loop_stuck", "empty_patch"] },
        ];
        const bd = aggregate(classifications);
        expect(bd.byTermination).toEqual({
            hung_stream: 1,
            completed_unresolved: 2,
            max_turns_exhausted: 1,
        });
        expect(bd.bySignal).toEqual({
            dirty_cache_leak: 1,
            verify_loop_stuck: 2,
            search_thrashing: 1,
            empty_patch: 1,
        });
    });
    test("empty input yields empty objects (no zero-init noise)", () => {
        const bd = aggregate([]);
        expect(bd.byTermination).toEqual({});
        expect(bd.bySignal).toEqual({});
    });
});
