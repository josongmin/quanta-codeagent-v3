/** Unit tests for `git_branch_switch` — Claude Desktop 1.7196.3
 *  `commitWipForBranchSwitch` pattern absorption. Asserts:
 *    - schema validation + branch-name injection guard
 *    - hitlTier ⇒ pre-approval-ok (branch switch is reversible)
 *    - autoWip=true on dirty tree: wip commit FIRST, then `git switch <branch>`
 *    - autoWip=false on dirty tree: ok:false with stash hint
 *    - clean tree: `git switch` only (no commit)
 *    - create=true: `git switch -c <branch>`
 */
import { describe, expect, test } from "bun:test";
import { gitBranchSwitchTool } from "@/tool/git/branch-switch";
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
        return this.resolver(args, i);
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
const statusResult = (opts) => {
    if (opts.statusFail)
        return err("fatal: not a git repository");
    return ok(opts.dirty ? " M src/foo.ts\n?? new.txt\n" : "");
};
const subcommandResult = (head, opts) => {
    if (head === "add")
        return opts.addFail ? err("fatal: pathspec") : ok();
    if (head === "commit")
        return opts.commitFail ? err("fatal: nothing to commit", 1) : ok();
    if (head === "switch")
        return opts.switchFail ? err("fatal: invalid reference") : ok();
    return ok();
};
/** Build a resolver matching argv shape ⇒ predetermined result. The default
 *  porcelain output is empty (clean tree); override per-test via `dirty`. */
const resolver = (opts) => (args) => {
    const head = args[0];
    if (head === "status")
        return statusResult(opts);
    return subcommandResult(head, opts);
};
describe("gitBranchSwitchTool — metadata", () => {
    test("name + tiers + isReadOnly=false", () => {
        const t = gitBranchSwitchTool(new FakeRunner(resolver({})));
        expect(t.name).toBe("git_branch_switch");
        expect(t.isReadOnly()).toBe(false);
        expect(t.isConcurrencySafe({ branch: "main" })).toBe(false);
        expect(t.hitlTier?.({ branch: "main" })).toBe("pre-approval-ok");
        expect(t.description).toMatch(/branch|switch/i);
    });
});
describe("gitBranchSwitchTool — schema + injection guard", () => {
    test("schema rejects empty branch name", () => {
        const t = gitBranchSwitchTool(new FakeRunner(resolver({})));
        expect(t.inputSchema.safeParse({ branch: "" }).success).toBe(false);
    });
    test("schema accepts allowed chars [A-Za-z0-9._/+-]", () => {
        const t = gitBranchSwitchTool(new FakeRunner(resolver({})));
        expect(t.inputSchema.safeParse({ branch: "feature/abc-1.2_x+y" }).success).toBe(true);
    });
    test("schema rejects shell metacharacters in branch name", async () => {
        const t = gitBranchSwitchTool(new FakeRunner(resolver({})));
        for (const evil of [
            "feat;rm -rf /",
            "feat`whoami`",
            "feat$(id)",
            "feat|cat",
            "feat&background",
            "feat with space",
            "feat>x",
        ]) {
            expect(t.inputSchema.safeParse({ branch: evil }).success).toBe(false);
        }
    });
    test("schema rejects leading '-' (CLI-flag confusion)", () => {
        const t = gitBranchSwitchTool(new FakeRunner(resolver({})));
        expect(t.inputSchema.safeParse({ branch: "-evil" }).success).toBe(false);
        expect(t.inputSchema.safeParse({ branch: "--force" }).success).toBe(false);
    });
    test("schema enforces 64-char cap", () => {
        const t = gitBranchSwitchTool(new FakeRunner(resolver({})));
        expect(t.inputSchema.safeParse({ branch: "a".repeat(65) }).success).toBe(false);
        expect(t.inputSchema.safeParse({ branch: "a".repeat(64) }).success).toBe(true);
    });
});
describe("gitBranchSwitchTool — clean tree", () => {
    test("clean + no flags: status then `switch -- <branch>`", async () => {
        const runner = new FakeRunner(resolver({ dirty: false }));
        const r = await collect(gitBranchSwitchTool(runner), { branch: "main" });
        expect(r.ok).toBe(true);
        expect(runner.calls[0]?.args[0]).toBe("status");
        expect(runner.calls[1]?.args).toEqual(["switch", "--", "main"]);
        expect(runner.calls.length).toBe(2);
    });
    test("create=true: `switch -c <branch>`", async () => {
        const runner = new FakeRunner(resolver({ dirty: false }));
        await collect(gitBranchSwitchTool(runner), { branch: "feat-x", create: true });
        expect(runner.calls[1]?.args).toEqual(["switch", "-c", "feat-x"]);
    });
});
describe("gitBranchSwitchTool — dirty tree", () => {
    test("autoWip=true: wip commit FIRST, then switch", async () => {
        const runner = new FakeRunner(resolver({ dirty: true }));
        const r = await collect(gitBranchSwitchTool(runner), {
            branch: "feat",
            autoWip: true,
            create: true,
        });
        expect(r.ok).toBe(true);
        // Expected sequence: status → add → commit → switch -c
        const heads = runner.calls.map((c) => c.args[0]);
        expect(heads).toEqual(["status", "add", "commit", "switch"]);
        expect(runner.calls[1]?.args).toEqual(["add", "--", "."]);
        const commitArgs = runner.calls[2]?.args ?? [];
        expect(commitArgs[0]).toBe("commit");
        expect(commitArgs[1]).toBe("-m");
        expect(commitArgs[2]).toMatch(/^wip: /);
        expect(runner.calls[3]?.args).toEqual(["switch", "-c", "feat"]);
    });
    test("autoWip=false on dirty ⇒ ok:false with stash hint", async () => {
        const runner = new FakeRunner(resolver({ dirty: true }));
        const r = await collect(gitBranchSwitchTool(runner), { branch: "main", autoWip: false });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/dirty|stash|autoWip/i);
        // No mutation should have been attempted.
        const heads = runner.calls.map((c) => c.args[0]);
        expect(heads).toEqual(["status"]);
    });
    test("autoWip omitted on dirty ⇒ ok:false (default is false)", async () => {
        const runner = new FakeRunner(resolver({ dirty: true }));
        const r = await collect(gitBranchSwitchTool(runner), { branch: "main" });
        expect(r.ok).toBe(false);
    });
});
describe("gitBranchSwitchTool — failures", () => {
    test("status fails ⇒ ok:false (no mutation)", async () => {
        const runner = new FakeRunner(resolver({ statusFail: true }));
        const r = await collect(gitBranchSwitchTool(runner), { branch: "main" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/not a git repository/i);
    });
    test("wip commit fails ⇒ ok:false, no switch attempted", async () => {
        const runner = new FakeRunner(resolver({ dirty: true, commitFail: true }));
        const r = await collect(gitBranchSwitchTool(runner), {
            branch: "feat",
            autoWip: true,
        });
        expect(r.ok).toBe(false);
        const heads = runner.calls.map((c) => c.args[0]);
        expect(heads).not.toContain("switch");
    });
    test("switch fails ⇒ ok:false", async () => {
        const runner = new FakeRunner(resolver({ dirty: false, switchFail: true }));
        const r = await collect(gitBranchSwitchTool(runner), { branch: "doesnotexist" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/invalid reference/i);
    });
    test("spawn failure ⇒ ok:false", async () => {
        const r = await collect(gitBranchSwitchTool(new ThrowingRunner()), { branch: "main" });
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(/spawn|ENOENT/i);
    });
});
