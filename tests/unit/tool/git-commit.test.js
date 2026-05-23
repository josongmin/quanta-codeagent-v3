/** Unit tests for `git_commit` — Claude Desktop 1.7196.3
 *  `commitWipForBranchSwitch` pattern absorption. Asserts:
 *    - schema validation
 *    - hitlTier branches (wip = pre-approval-ok; regular = always-confirm)
 *    - argv order: `git add <paths|.>` then `git commit -m <msg>`
 *    - wip mode auto-generates a message
 *    - injection-resistant commit message (argv, no shell)
 *    - spawn failure ⇒ ok:false
 */
import { describe, expect, test } from "bun:test";
import { gitCommitTool } from "@/tool/git/commit";
const ctx = () => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
});
class FakeRunner {
    resolver;
    calls = [];
    constructor(resolver) {
        this.resolver = resolver;
    }
    async run(args, cwd) {
        const i = this.calls.length;
        this.calls.push({ args: [...args], cwd });
        return typeof this.resolver === "function" ? this.resolver(args, i) : this.resolver;
    }
}
class ThrowingRunner {
    async run() {
        throw new Error("spawn ENOENT");
    }
}
const collect = async (tool, input) => {
    let result;
    for await (const ev of tool.execute(input, ctx())) {
        if (ev.type === "result")
            result = ev.result;
    }
    if (!result)
        throw new Error("no result");
    return result;
};
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const err = (stderr, exitCode = 128) => ({ stdout: "", stderr, exitCode });
describe("gitCommitTool — metadata", () => {
    test("name + read-only + concurrency-safe = false", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.name).toBe("git_commit");
        expect(t.isReadOnly()).toBe(false);
        expect(t.isConcurrencySafe({ message: "x" })).toBe(false);
        expect(t.description).toMatch(/commit/i);
    });
    test("hitlTier: regular ⇒ always-confirm", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.hitlTier?.({ message: "fix bug" })).toBe("always-confirm");
        expect(t.hitlTier?.({ message: "fix bug", mode: "regular" })).toBe("always-confirm");
    });
    test("hitlTier: wip ⇒ pre-approval-ok", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.hitlTier?.({ message: "noop", mode: "wip" })).toBe("pre-approval-ok");
    });
});
describe("gitCommitTool — schema", () => {
    test("schema rejects empty message", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.inputSchema.safeParse({ message: "" }).success).toBe(false);
    });
    test("schema rejects unknown mode", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.inputSchema.safeParse({ message: "x", mode: "amend" }).success).toBe(false);
    });
    test("schema accepts wip without message (default applied at runtime)", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.inputSchema.safeParse({ mode: "wip" }).success).toBe(true);
    });
    test("schema accepts paths array", () => {
        const t = gitCommitTool(new FakeRunner(ok()));
        expect(t.inputSchema.safeParse({ message: "x", paths: ["a.ts", "b.ts"] }).success).toBe(true);
    });
});
describe("gitCommitTool — argv order (regular mode)", () => {
    test("default: git add . && git commit -m <msg>", async () => {
        const runner = new FakeRunner(ok());
        await collect(gitCommitTool(runner), { message: "regular fix" });
        expect(runner.calls.length).toBe(2);
        expect(runner.calls[0]?.args).toEqual(["add", "--", "."]);
        expect(runner.calls[1]?.args).toEqual(["commit", "-m", "regular fix"]);
    });
    test("paths: stage specific files only", async () => {
        const runner = new FakeRunner(ok());
        await collect(gitCommitTool(runner), { message: "scoped", paths: ["a.ts", "b.ts"] });
        expect(runner.calls[0]?.args).toEqual(["add", "--", "a.ts", "b.ts"]);
        expect(runner.calls[1]?.args).toEqual(["commit", "-m", "scoped"]);
    });
    test("injection-resistant: shell metachars in message survive as a single argv slot", async () => {
        const runner = new FakeRunner(ok());
        const evil = `"; rm -rf / #`;
        await collect(gitCommitTool(runner), { message: evil });
        // Spawn is argv-based — the runner must receive the message as one slot.
        expect(runner.calls[1]?.args).toEqual(["commit", "-m", evil]);
    });
});
describe("gitCommitTool — wip mode", () => {
    test("wip auto-generates message and stages all files", async () => {
        const runner = new FakeRunner(ok());
        await collect(gitCommitTool(runner), { mode: "wip" });
        expect(runner.calls[0]?.args).toEqual(["add", "--", "."]);
        const commitArgs = runner.calls[1]?.args ?? [];
        expect(commitArgs[0]).toBe("commit");
        expect(commitArgs[1]).toBe("-m");
        expect(commitArgs[2]).toMatch(/^wip: /);
    });
    test("wip honors user-provided message when present", async () => {
        const runner = new FakeRunner(ok());
        await collect(gitCommitTool(runner), { mode: "wip", message: "wip: tweak" });
        expect(runner.calls[1]?.args).toEqual(["commit", "-m", "wip: tweak"]);
    });
    test("wip does NOT pass --no-verify (hooks run)", async () => {
        const runner = new FakeRunner(ok());
        await collect(gitCommitTool(runner), { mode: "wip" });
        for (const c of runner.calls) {
            expect(c.args).not.toContain("--no-verify");
        }
    });
});
describe("gitCommitTool — error paths", () => {
    test("git add failure aborts before commit", async () => {
        const runner = new FakeRunner((args) => args[0] === "add" ? err("fatal: pathspec did not match", 128) : ok());
        const r = await collect(gitCommitTool(runner), { message: "x" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/pathspec|add/i);
        expect(runner.calls.length).toBe(1);
    });
    test("git commit failure surfaces stderr", async () => {
        const runner = new FakeRunner((args) => args[0] === "add" ? ok() : err("fatal: nothing to commit", 1));
        const r = await collect(gitCommitTool(runner), { message: "x" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/nothing to commit/i);
    });
    test("spawn failure ⇒ ok:false", async () => {
        const r = await collect(gitCommitTool(new ThrowingRunner()), { message: "x" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/spawn|ENOENT/i);
    });
    test("not a git repository ⇒ ok:false", async () => {
        const runner = new FakeRunner(err("fatal: not a git repository"));
        const r = await collect(gitCommitTool(runner), { message: "x" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/not a git repository/i);
    });
});
