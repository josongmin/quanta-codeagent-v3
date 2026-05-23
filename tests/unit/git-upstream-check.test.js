import { describe, expect, test } from "bun:test";
import { gitUpstreamCheckTool } from "@/tool/git";
const ctx = () => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
});
/** Routes each git invocation to a canned result keyed by the first
 *  meaningful subcommand fragment so we can script the multi-step tool. */
class ScriptedRunner {
    route;
    calls = [];
    constructor(route) {
        this.route = route;
    }
    async run(args, _cwd) {
        this.calls.push([...args]);
        return this.route(args);
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
const ok = (stdout) => ({ stdout, stderr: "", exitCode: 0 });
const err = (stderr, exitCode = 128) => ({ stdout: "", stderr, exitCode });
const isUpstreamRef = (args) => args.includes("@{upstream}") && args.includes("--symbolic-full-name");
const isBranch = (args) => args[0] === "rev-parse" && args.includes("HEAD") && !args.includes("@{upstream}");
const isCount = (args) => args[0] === "rev-list";
describe("gitUpstreamCheckTool", () => {
    test("metadata: read-only, concurrency-safe", () => {
        const t = gitUpstreamCheckTool(new ScriptedRunner(() => ok("")));
        expect(t.name).toBe("git_upstream_check");
        expect(t.isReadOnly()).toBe(true);
        expect(t.isConcurrencySafe({})).toBe(true);
    });
    test("never fetches (no network/index mutation)", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return ok("origin/main");
            if (isBranch(args))
                return ok("main");
            return ok("0\t0");
        });
        await collect(gitUpstreamCheckTool(runner), {});
        for (const call of runner.calls) {
            expect(call).not.toContain("fetch");
            expect(call).not.toContain("pull");
        }
    });
    test("reports behind with an actionable pull note", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return ok("origin/main");
            if (isBranch(args))
                return ok("main");
            if (isCount(args))
                return ok("0\t3\n");
            return ok("");
        });
        const r = await collect(gitUpstreamCheckTool(runner), {});
        expect(r.ok).toBe(true);
        expect(r.output).toContain("Branch main → upstream origin/main");
        expect(r.output).toContain("ahead 0, behind 3");
        expect(r.output).toContain("upstream has 3 new commit(s); consider pulling");
    });
    test("reports ahead-only as up to date with upstream", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return ok("origin/feature");
            if (isBranch(args))
                return ok("feature");
            if (isCount(args))
                return ok("2\t0");
            return ok("");
        });
        const r = await collect(gitUpstreamCheckTool(runner), {});
        expect(r.ok).toBe(true);
        expect(r.output).toContain("ahead 2, behind 0");
        expect(r.output).toContain("up to date with upstream");
    });
    test("no upstream configured → graceful ok", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return err("fatal: no upstream configured for branch 'main'");
            return ok("");
        });
        const r = await collect(gitUpstreamCheckTool(runner), {});
        expect(r.ok).toBe(true);
        expect(r.output).toBe("no upstream tracking branch");
    });
    test("non-zero exit on upstream resolution (non-no-upstream) → ok:false", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return err("fatal: not a git repository");
            return ok("");
        });
        const r = await collect(gitUpstreamCheckTool(runner), {});
        expect(r.ok).toBe(false);
        expect(r.output).toContain("not a git repository");
    });
    test("non-zero exit on rev-list count → ok:false", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return ok("origin/main");
            if (isBranch(args))
                return ok("main");
            if (isCount(args))
                return err("fatal: bad revision", 128);
            return ok("");
        });
        const r = await collect(gitUpstreamCheckTool(runner), {});
        expect(r.ok).toBe(false);
        expect(r.output).toContain("bad revision");
    });
    test("spawn error surfaces as ok:false", async () => {
        const r = await collect(gitUpstreamCheckTool(new ThrowingRunner()), {});
        expect(r.ok).toBe(false);
        expect(r.output).toContain("git upstream check failed");
    });
    test("branch resolution failure falls back to HEAD", async () => {
        const runner = new ScriptedRunner((args) => {
            if (isUpstreamRef(args))
                return ok("origin/main");
            if (isBranch(args))
                return err("detached", 1);
            if (isCount(args))
                return ok("0\t1");
            return ok("");
        });
        const r = await collect(gitUpstreamCheckTool(runner), {});
        expect(r.ok).toBe(true);
        expect(r.output).toContain("Branch HEAD → upstream origin/main");
    });
});
