/**
 * ADR-0103 + ADR-0104 hellgate — gh_pr_blame / gh_pr_review_diff /
 * gh_pr_auto_merge + gh_pr_create draft flag.
 *
 * Closed-port (injected GhRunner), so all cases exercise state-machine
 * behavior with canned `gh` outputs. Real `gh` smoke is left to the
 * integration suite — this hellgate pins parser/argv contracts.
 *
 * 18 adversarial cases.
 */
import { describe, expect, test } from "bun:test";
import { ghPrAutoMergeTool, ghPrBlameTool, ghPrCreateTool, ghPrReviewDiffTool, } from "@/tool/gh";
const okGh = (stdout) => ({ code: 0, stdout, stderr: "" });
const failGh = (stderr) => ({ code: 1, stdout: "", stderr });
const captureCalls = (reply) => {
    const argv = [];
    return Object.assign(async (a, _cwd, _t) => {
        argv.push([...a]);
        return reply(a);
    }, { argv });
};
const drain = async (it) => {
    const events = [];
    for await (const ev of it)
        events.push(ev);
    return events;
};
const resultOf = (events) => {
    const r = events.find((e) => e.type === "result");
    if (r && r.type === "result")
        return r.result;
    return undefined;
};
// ── gh_pr_blame (ADR-0103) ──────────────────────────────────────────────
describe("gh_pr_blame (hellgate)", () => {
    test("HELL-1: builds correct argv for `gh pr view --json reviewThreads`", async () => {
        const runner = captureCalls(async () => okGh(JSON.stringify({ url: "https://github.com/x/y/pull/1", reviewThreads: [] })));
        const tool = ghPrBlameTool(runner);
        await drain(tool.execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(runner.argv[0]).toEqual([
            "gh",
            "pr",
            "view",
            "1",
            "--json",
            "url,headRefName,baseRefName,reviewThreads",
        ]);
    });
    test("HELL-2: renders thread bodies anchored to file:line with reviewer attribution", async () => {
        const json = JSON.stringify({
            url: "https://github.com/x/y/pull/42",
            reviewThreads: [
                {
                    path: "src/foo.ts",
                    line: 12,
                    comments: { nodes: [{ author: { login: "alice" }, body: "nit: rename" }] },
                },
            ],
        });
        const runner = captureCalls(async () => okGh(json));
        const tool = ghPrBlameTool(runner);
        const events = await drain(tool.execute({ pr: 42 }, { cwd: "/tmp", signal: new AbortController().signal }));
        const result = resultOf(events);
        expect(result?.ok).toBe(true);
        expect(result?.output).toContain("src/foo.ts:12");
        expect(result?.output).toContain("@alice");
        expect(result?.output).toContain("nit: rename");
        expect(result?.output).toContain("https://github.com/x/y/pull/42");
    });
    test("HELL-3: tags resolved + outdated threads visibly", async () => {
        const json = JSON.stringify({
            reviewThreads: [
                {
                    path: "f.ts",
                    line: 1,
                    isResolved: true,
                    isOutdated: true,
                    comments: { nodes: [{ author: { login: "bob" }, body: "fixed" }] },
                },
            ],
        });
        const runner = captureCalls(async () => okGh(json));
        const events = await drain(ghPrBlameTool(runner).execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        const out = resultOf(events)?.output ?? "";
        expect(out).toContain("(resolved, outdated)");
    });
    test("HELL-4: filter by file matches exact path only", async () => {
        const json = JSON.stringify({
            reviewThreads: [
                { path: "src/a.ts", line: 1, comments: { nodes: [{ body: "A" }] } },
                { path: "src/b.ts", line: 1, comments: { nodes: [{ body: "B" }] } },
            ],
        });
        const events = await drain(ghPrBlameTool(captureCalls(async () => okGh(json))).execute({ pr: 1, file: "src/a.ts" }, { cwd: "/tmp", signal: new AbortController().signal }));
        const out = resultOf(events)?.output ?? "";
        expect(out).toContain("src/a.ts");
        expect(out).not.toContain("src/b.ts");
    });
    test("HELL-5: filter by line uses ±5 proximity window", async () => {
        const json = JSON.stringify({
            reviewThreads: [
                { path: "f.ts", line: 10, comments: { nodes: [{ body: "near" }] } },
                { path: "f.ts", line: 100, comments: { nodes: [{ body: "far" }] } },
            ],
        });
        const events = await drain(ghPrBlameTool(captureCalls(async () => okGh(json))).execute({ pr: 1, file: "f.ts", line: 12 }, { cwd: "/tmp", signal: new AbortController().signal }));
        const out = resultOf(events)?.output ?? "";
        expect(out).toContain("near");
        expect(out).not.toContain("far");
    });
    test("HELL-6: returns explanatory message when threads empty", async () => {
        const events = await drain(ghPrBlameTool(captureCalls(async () => okGh(JSON.stringify({ reviewThreads: [] })))).execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(resultOf(events)?.ok).toBe(true);
        expect(resultOf(events)?.output).toContain("no review threads on this PR");
    });
    test("HELL-7: handles `reviewThreads.nodes` shape (GraphQL connections)", async () => {
        const json = JSON.stringify({
            reviewThreads: {
                nodes: [{ path: "x.ts", line: 1, comments: { nodes: [{ body: "ok" }] } }],
            },
        });
        const events = await drain(ghPrBlameTool(captureCalls(async () => okGh(json))).execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(resultOf(events)?.output).toContain("x.ts:1");
    });
    test("HELL-8: non-JSON stdout surfaces a parse error (does not throw)", async () => {
        const events = await drain(ghPrBlameTool(captureCalls(async () => okGh("definitely not json"))).execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(resultOf(events)?.ok).toBe(false);
        expect(resultOf(events)?.output).toContain("non-JSON");
    });
    test("HELL-9: gh non-zero exit surfaces stderr (truncated)", async () => {
        const events = await drain(ghPrBlameTool(captureCalls(async () => failGh("HTTP 404\nTry gh auth login"))).execute({ pr: 999 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(resultOf(events)?.ok).toBe(false);
        expect(resultOf(events)?.output).toContain("HTTP 404");
    });
    test("HELL-10: leading-dash PR ref rejected (no flag injection)", async () => {
        const runner = captureCalls(async () => okGh("{}"));
        const events = await drain(ghPrBlameTool(runner).execute({ pr: "--web" }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(resultOf(events)?.ok).toBe(false);
        expect(resultOf(events)?.output).toContain("invalid PR identifier");
        // Runner MUST NOT have been called.
        expect(runner.argv.length).toBe(0);
    });
});
// ── gh_pr_review_diff (ADR-0104) ────────────────────────────────────────
describe("gh_pr_review_diff (hellgate)", () => {
    test("HELL-11: argv is `gh pr diff <ref>`", async () => {
        const runner = captureCalls(async () => okGh("diff body"));
        await drain(ghPrReviewDiffTool(runner).execute({ pr: 5 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(runner.argv[0]).toEqual(["gh", "pr", "diff", "5"]);
    });
    test("HELL-12: huge diff truncated at maxBytes with marker", async () => {
        const huge = "x".repeat(200 * 1024);
        const events = await drain(ghPrReviewDiffTool(captureCalls(async () => okGh(huge))).execute({ pr: 1, maxBytes: 64 * 1024 }, { cwd: "/tmp", signal: new AbortController().signal }));
        const out = resultOf(events)?.output ?? "";
        expect(out).toContain("[truncated:");
        expect(out).toContain(`${200 * 1024} bytes total`);
        expect(out.indexOf("\n\n[truncated:")).toBe(64 * 1024);
    });
    test("HELL-13: maxBytes>1MiB rejected by schema (dispatcher-side gate)", async () => {
        // The schema's `.max(1024*1024)` cap is enforced at the dispatcher
        // validation layer (`tool.inputSchema.safeParse(input)`), not inside
        // execute(). Verify by parsing directly — the test surfaces a contract
        // a dispatcher MUST honor.
        const tool = ghPrReviewDiffTool(captureCalls(async () => okGh("x")));
        const result = tool.inputSchema.safeParse({ pr: 1, maxBytes: 10 * 1024 * 1024 });
        expect(result.success).toBe(false);
    });
    test("HELL-14: small diff passes through unchanged", async () => {
        const events = await drain(ghPrReviewDiffTool(captureCalls(async () => okGh("small diff"))).execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(resultOf(events)?.output).toBe("small diff");
    });
});
// ── gh_pr_auto_merge (ADR-0104) ─────────────────────────────────────────
describe("gh_pr_auto_merge (hellgate)", () => {
    test("HELL-15: default method is `--merge`", async () => {
        const runner = captureCalls(async () => okGh("auto-merge enabled"));
        await drain(ghPrAutoMergeTool(runner).execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(runner.argv[0]).toEqual(["gh", "pr", "merge", "1", "--auto", "--merge"]);
    });
    test("HELL-16: explicit method maps to correct flag (squash / rebase)", async () => {
        const r1 = captureCalls(async () => okGh(""));
        await drain(ghPrAutoMergeTool(r1).execute({ pr: 1, method: "squash" }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(r1.argv[0]).toContain("--squash");
        const r2 = captureCalls(async () => okGh(""));
        await drain(ghPrAutoMergeTool(r2).execute({ pr: 1, method: "rebase" }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(r2.argv[0]).toContain("--rebase");
    });
});
// ── gh_pr_create draft flag (ADR-0104) ──────────────────────────────────
describe("gh_pr_create draft flag (hellgate)", () => {
    test("HELL-17: draft:true adds `--draft` flag to argv", async () => {
        const runner = captureCalls(async () => okGh("https://github.com/x/y/pull/1"));
        await drain(ghPrCreateTool(runner).execute({ title: "t", body: "b", base: "main", head: "feature/x", draft: true }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(runner.argv[0]).toContain("--draft");
    });
    test("HELL-18: draft absent ⇒ no `--draft` flag (byte-identical pre-ADR)", async () => {
        const runner = captureCalls(async () => okGh("https://github.com/x/y/pull/1"));
        await drain(ghPrCreateTool(runner).execute({ title: "t", body: "b", base: "main", head: "feature/x" }, { cwd: "/tmp", signal: new AbortController().signal }));
        expect(runner.argv[0]).not.toContain("--draft");
    });
});
