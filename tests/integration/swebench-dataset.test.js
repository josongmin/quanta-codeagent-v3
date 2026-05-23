import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, parseSwebenchJsonl, prepareTaskRepo, toInstance, writePredictions, } from "../../src/apps/bench/corpus/dataset";
import { runInstance } from "../../src/apps/bench/eval";
import { buildReport, writeReport } from "../../src/apps/bench/report";
/** Mirror of bench.test.ts's FixingLLM: one edit turn via the real edit tool,
 *  then a final text turn. Extracts the sandbox from the runner's prompt. */
class FixingLLM {
    file;
    oldStr;
    newStr;
    calls = 0;
    constructor(file, oldStr, newStr) {
        this.file = file;
        this.oldStr = oldStr;
        this.newStr = newStr;
    }
    async *stream(input) {
        this.calls += 1;
        const text = input.messages
            .flatMap((m) => m.content)
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ");
        const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? "";
        if (this.calls === 1) {
            yield { type: "tool_use_start", id: "e1", name: "edit" };
            yield {
                type: "tool_use_end",
                id: "e1",
                input: { path: join(sandbox, this.file), old_string: this.oldStr, new_string: this.newStr },
            };
            yield { type: "message_stop", stop_reason: "tool_use" };
            return;
        }
        yield { type: "text_delta", delta: "done" };
        yield { type: "message_stop", stop_reason: "end_turn" };
    }
}
const DEPS = { maxTurns: 5, timeoutMs: 30000 };
describe("swebench-dataset", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "swebench-test-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    test("parseSwebenchJsonl: official snake_case rows → SwebenchTask[]", () => {
        const text = [
            JSON.stringify({
                instance_id: "django__django-1",
                repo: "django/django",
                base_commit: "abc123",
                problem_statement: "Fix the bug.",
                environment_setup_commit: "env456",
                patch: "diff --git ...",
                FAIL_TO_PASS: ["test_x"],
            }),
            JSON.stringify({
                instance_id: "psf__requests-2",
                repo: "psf/requests",
                base_commit: "def789",
                problem_statement: "Another bug.",
            }),
        ].join("\n");
        const tasks = parseSwebenchJsonl(text);
        expect(tasks).toHaveLength(2);
        expect(tasks[0]).toMatchObject({
            instanceId: "django__django-1",
            repo: "django/django",
            baseCommit: "abc123",
            problemStatement: "Fix the bug.",
            environmentSetupCommit: "env456",
        });
        expect(tasks[0]?.raw.FAIL_TO_PASS).toEqual(["test_x"]);
        expect(tasks[1]?.environmentSetupCommit).toBeUndefined();
    });
    test("parseSwebenchJsonl: blank/malformed/missing-field lines skipped, never throws", () => {
        const text = [
            "",
            "   ",
            "{ not json",
            JSON.stringify({ repo: "a/b", base_commit: "c", problem_statement: "p" }), // no instance_id
            JSON.stringify({ instance_id: "x", base_commit: "c", problem_statement: "p" }), // no repo
            "null",
            "42",
            JSON.stringify({
                instance_id: "ok-1",
                repo: "o/k",
                base_commit: "sha",
                problem_statement: "real",
            }),
        ].join("\n");
        const tasks = parseSwebenchJsonl(text);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.instanceId).toBe("ok-1");
    });
    test("writePredictions: exact official JSONL shape on disk", async () => {
        const file = join(dir, "predictions.jsonl");
        const rows = [
            { instance_id: "a-1", model_name_or_path: "gpt-4o", model_patch: "diff a" },
            { instance_id: "b-2", model_name_or_path: "gpt-4o", model_patch: "diff b" },
        ];
        await writePredictions(file, rows);
        const raw = readFileSync(file, "utf8");
        expect(raw.endsWith("\n")).toBe(true);
        const lines = raw.trimEnd().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toEqual(rows[0]);
        expect(JSON.parse(lines[1])).toEqual(rows[1]);
    });
    test("writeReport: exact JSON shape on disk", async () => {
        const file = join(dir, "report.json");
        const report = buildReport({ provider: "openai", model: "gpt-4o", n: 2, timestamp: "2026-05-19T00:00:00.000Z" }, [
            { id: "a-1", passed: true, patch: "xx", turns: 3 },
            { id: "b-2", passed: false, patch: "", turns: 1, error: "boom" },
        ]);
        await writeReport(file, report);
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        expect(parsed.timestamp).toBe("2026-05-19T00:00:00.000Z");
        expect(parsed.totals).toEqual({ total: 2, resolved: 1, resolvedPct: 50 });
        expect(parsed.perInstance[0]).toEqual({ id: "a-1", passed: true, turns: 3, patchBytes: 2 });
        expect(parsed.perInstance[1].error).toBe("boom");
    });
    test("end-to-end offline: local clone → prepare → run → prediction", async () => {
        // Build a local git repo with a planted bug; no network. The dir is named
        // `mathlib.git` so prepareTaskRepo's `<base>/<repo>.git` URL resolves to
        // this on-disk path and `git clone` runs fully offline.
        const origin = join(dir, "origin", "mathlib.git");
        await mkdir(origin, { recursive: true });
        await writeFile(join(origin, "math.js"), "function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n");
        const gitcfg = "-c user.email=t@t -c user.name=t -c commit.gpgsign=false";
        const init = await defaultExec(`git init -q . && git ${gitcfg} add -A && git ${gitcfg} commit -q -m bug`, origin, 30000);
        expect(init.code).toBe(0);
        const rev = await defaultExec("git rev-parse HEAD", origin, 30000);
        const baseCommit = rev.stdout.trim();
        const task = parseSwebenchJsonl(JSON.stringify({
            instance_id: "local__mathlib-1",
            repo: "origin/mathlib",
            base_commit: baseCommit,
            problem_statement: "The add(a, b) function in math.js returns a - b but must return a + b. Fix it.",
        }))[0];
        expect(task).toBeDefined();
        if (!task)
            return;
        // repoBaseUrl points at the local parent dir → `git clone` is offline.
        const dest = join(dir, "checkout");
        const repoPath = await prepareTaskRepo(task, dest, defaultExec, join(dir), 30000);
        expect(repoPath).toBe(dest);
        const instance = toInstance(task, repoPath);
        expect(instance.testCmd).toBe("true");
        const result = await runInstance(instance, {
            ...DEPS,
            llm: new FixingLLM("math.js", "return a - b", "return a + b"),
        });
        expect(result.error).toBeUndefined();
        expect(result.patch).toContain("return a + b");
        const prediction = {
            instance_id: result.id,
            model_name_or_path: "fake-llm",
            model_patch: result.patch,
        };
        expect(prediction.instance_id).toBe("local__mathlib-1");
        expect(prediction.model_patch.length).toBeGreaterThan(0);
    }, 60000);
});
