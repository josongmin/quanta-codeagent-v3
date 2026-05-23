/**
 * GitHub CLI (`gh`) tool slice — RFC may-22 ci-bot mode.
 *
 * Exposes 4 read + 2 write tools wrapping the `gh` binary. The slice is the
 * SINGLE place that knows about `gh` invocation; per-mode wiring decides
 * whether to register these tools (ci-bot does; interactive does only if
 * operator opts in).
 *
 * Tools:
 *   - gh_pr_view     (read) — fetch PR title/body/diff
 *   - gh_issue_view  (read) — fetch issue body
 *   - gh_pr_comment  (write) — post a PR comment
 *   - gh_pr_create   (write) — open a PR (branch must NOT be protected)
 *   - gh_check_status (read) — fetch CI check status for a PR
 *   - gh_pr_list     (read) — list open PRs
 *
 * Design:
 *   - The slice talks ONLY through the `Tool` contract — no globals.
 *   - Spawn boundary is injectable for tests (`GhRunner` port).
 *   - `gh` argv is built as a string[] (no shell ⇒ no injection).
 *   - Errors return `ok:false` with a clean message; never throws to the
 *     loop (boundary discipline, not a fallback for missing data).
 */
import { z } from "zod";
import { scrubEnv } from "@/runtime";
/**
 * SECURITY (mirrors `git/diff.ts` leading-dash rejection): a PR/issue
 * identifier is a bare POSITIONAL argument to `gh` (`gh pr view <id>`). A
 * `-`-leading value (`--web`, `-R/owner/evil`, `--repo=…`) would be parsed by
 * `gh` as a FLAG rather than a number/URL — arg-injection. `gh` accepts a
 * numeric issue/PR number OR a full `https://…` URL; both are validated here.
 * A malformed identifier is rejected before it reaches argv, surfaced as a
 * deterministic `ok:false` (never thrown to the loop).
 *
 * Accepted: a positive integer (`42`, `#42`) or an `http(s)://…` URL. Anything
 * beginning with `-`, or any other shape, is rejected.
 */
const normalizeRef = (raw) => {
    const s = String(raw).trim();
    if (s.length === 0)
        return undefined;
    // Plain number, optionally with a leading `#` (a common human shorthand).
    const num = s.startsWith("#") ? s.slice(1) : s;
    if (/^[0-9]+$/.test(num))
        return num;
    // Full URL form — must be http(s) so it can never be a `-`-leading flag.
    if (/^https?:\/\//i.test(s))
        return s;
    return undefined;
};
/** Raised (and caught in `execute`) when a PR/issue identifier is malformed. */
const refRejected = (kind, raw) => `invalid ${kind} identifier '${String(raw)}': expected a positive number or an ` +
    "http(s) URL (a leading-dash value would be parsed as a gh flag)";
/** Default runner via Bun.spawn (no shell). Env is the CI-scoped allowlist
 *  from `@/runtime` — NEVER leaks `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` etc.
 *  The allowlist accepts `PATH`/`HOME`/`TMPDIR`/locale + `GH_TOKEN`/`GITHUB_*`,
 *  so `gh` authenticates from its own scoped token, not the user's host env. */
const CI_ENV_ALLOWLIST_LOCAL = Object.freeze([
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_ACTIONS",
    "GITHUB_RUN_ID",
]);
export const defaultGhRunner = async (argv, cwd, timeoutMs) => {
    const proc = Bun.spawn(argv, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: scrubEnv(CI_ENV_ALLOWLIST_LOCAL),
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return { code, stdout, stderr };
    }
    finally {
        clearTimeout(timer);
    }
};
const DEFAULT_TIMEOUT_MS = 60_000;
// ── Read tools ─────────────────────────────────────────────────────────────
const prViewSchema = z.object({
    pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
    fields: z
        .array(z.string())
        .optional()
        .describe("gh --json fields (default: title,body,headRefName,baseRefName,state,url)"),
});
const DEFAULT_PR_FIELDS = ["title", "body", "headRefName", "baseRefName", "state", "url"];
export const ghPrViewTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_view",
    description: "Fetch a GitHub PR via `gh pr view`. Returns the requested fields as JSON. " +
        "Read-only — never modifies repo or PR state.",
    inputSchema: prViewSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.pr);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } };
            return;
        }
        const fields = input.fields ?? DEFAULT_PR_FIELDS;
        const argv = ["gh", "pr", "view", ref, "--json", fields.join(",")];
        yield { type: "progress", message: `gh pr view #${input.pr}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr view failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: r.stdout.trim() } };
    },
});
const issueViewSchema = z.object({
    issue: z.union([z.string(), z.number()]).describe("Issue number or URL"),
});
export const ghIssueViewTool = (runner = defaultGhRunner) => ({
    name: "gh_issue_view",
    description: "Fetch a GitHub issue via `gh issue view --json`. Read-only.",
    inputSchema: issueViewSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.issue);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("issue", input.issue) } };
            return;
        }
        const argv = ["gh", "issue", "view", ref, "--json", "title,body,state,labels,url"];
        yield { type: "progress", message: `gh issue view #${input.issue}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh issue view failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: r.stdout.trim() } };
    },
});
const checkStatusSchema = z.object({
    pr: z.union([z.string(), z.number()]).describe("PR number"),
});
export const ghCheckStatusTool = (runner = defaultGhRunner) => ({
    name: "gh_check_status",
    description: "Fetch CI check status for a PR via `gh pr checks --json`. Read-only.",
    inputSchema: checkStatusSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.pr);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } };
            return;
        }
        const argv = ["gh", "pr", "checks", ref, "--json", "name,state,bucket,description"];
        yield { type: "progress", message: `gh pr checks #${input.pr}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr checks failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: r.stdout.trim() } };
    },
});
// ── Write tools ────────────────────────────────────────────────────────────
const prCommentSchema = z.object({
    pr: z.union([z.string(), z.number()]).describe("PR number"),
    body: z.string().min(1).describe("Comment body (markdown allowed)"),
});
export const ghPrCommentTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_comment",
    description: "Post a comment on a GitHub PR via `gh pr comment`. Write — gated by " +
        "the mode's permission policy. Returns the comment URL on success.",
    inputSchema: prCommentSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.pr);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } };
            return;
        }
        const argv = ["gh", "pr", "comment", ref, "--body", input.body];
        yield { type: "progress", message: `gh pr comment #${input.pr}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr comment failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: r.stdout.trim() || "comment posted" } };
    },
});
const prCreateSchema = z.object({
    title: z.string().min(1).describe("PR title"),
    body: z.string().describe("PR body (markdown allowed)"),
    base: z.string().describe("Base branch (e.g. main)"),
    head: z.string().describe("Head branch — MUST be a feature branch, not protected"),
    /** ADR-0104: open the PR as a draft (no review requested, no checks
     *  auto-required). Useful for early CI feedback before opening for review. */
    draft: z.boolean().optional().describe("Open as draft PR"),
});
export const ghPrCreateTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_create",
    description: "Open a new GitHub PR via `gh pr create`. Write — the head branch MUST " +
        "be a feature branch (not main/master/protected). The mode's gitWrite " +
        "lever is the structural gate; this tool just invokes `gh`. Optional " +
        "`draft:true` opens as a draft PR.",
    inputSchema: prCreateSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input, ctx) {
        const argv = [
            "gh",
            "pr",
            "create",
            "--title",
            input.title,
            "--body",
            input.body,
            "--base",
            input.base,
            "--head",
            input.head,
        ];
        if (input.draft === true)
            argv.push("--draft");
        yield { type: "progress", message: `gh pr create ${input.head} → ${input.base}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS * 2);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr create failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: r.stdout.trim() } };
    },
});
const PR_BLAME_PROXIMITY_LINES = 5;
const extractThreads = (raw) => {
    const rt = raw.reviewThreads;
    if (rt === undefined)
        return [];
    if (Array.isArray(rt))
        return rt;
    return rt.nodes ?? [];
};
const matchesPrBlameFilter = (thread, fileFilter, lineFilter) => {
    if (fileFilter !== undefined && thread.path !== fileFilter)
        return false;
    if (lineFilter !== undefined) {
        const anchor = thread.line ?? thread.originalLine ?? null;
        if (anchor === null)
            return false;
        if (Math.abs(anchor - lineFilter) > PR_BLAME_PROXIMITY_LINES)
            return false;
    }
    return true;
};
const renderPrBlameThread = (thread, idx) => {
    const path = thread.path ?? "(file unknown)";
    const line = thread.line ?? thread.originalLine ?? "?";
    const tags = [];
    if (thread.isResolved === true)
        tags.push("resolved");
    if (thread.isOutdated === true)
        tags.push("outdated");
    const header = `[${idx + 1}] ${path}:${line}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
    const comments = thread.comments?.nodes ?? [];
    if (comments.length === 0)
        return `${header}\n  (no comment body)`;
    const lines = comments.map((c) => {
        const author = c.author?.login ?? "(unknown)";
        const body = (c.body ?? "").trim().split("\n").join("\n  ");
        return `  @${author}: ${body}`;
    });
    return `${header}\n${lines.join("\n")}`;
};
const prBlameSchema = z.object({
    pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
    file: z.string().optional().describe("Restrict to comments on this file path"),
    line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Restrict to comments anchored within ±5 lines of this line"),
});
export const ghPrBlameTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_blame",
    description: "Anchor PR review-thread comments to file:line — like `git blame`, but with " +
        "reviewer comments instead of commit hashes. Filters by file path and ±5-line " +
        "proximity. Read-only.",
    inputSchema: prBlameSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.pr);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } };
            return;
        }
        const argv = ["gh", "pr", "view", ref, "--json", "url,headRefName,baseRefName,reviewThreads"];
        yield { type: "progress", message: `gh pr view #${input.pr} (reviewThreads)` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr view failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        let raw;
        try {
            raw = JSON.parse(r.stdout);
        }
        catch (parseErr) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: `gh pr view returned non-JSON: ${parseErr.message}`,
                },
            };
            return;
        }
        const threads = extractThreads(raw);
        const filtered = threads.filter((t) => matchesPrBlameFilter(t, input.file, input.line));
        if (filtered.length === 0) {
            const why = input.file !== undefined || input.line !== undefined
                ? "no review threads match the filter"
                : "no review threads on this PR";
            yield { type: "result", result: { ok: true, output: why } };
            return;
        }
        const body = filtered.map(renderPrBlameThread).join("\n\n");
        const header = raw.url ? `PR: ${raw.url}` : `PR: ${ref}`;
        yield { type: "result", result: { ok: true, output: `${header}\n\n${body}` } };
    },
});
/** Default cap for `gh_pr_review_diff` — 64 KiB matches the agent-side
 *  prompt budget. 1 MiB is the hard ceiling (schema). */
const PR_DIFF_DEFAULT_MAX_BYTES = 64 * 1024;
const prReviewDiffSchema = z.object({
    pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
    maxBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024)
        .optional()
        .describe("Truncate diff at this many bytes (default 64 KiB, max 1 MiB)"),
});
export const ghPrReviewDiffTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_review_diff",
    description: "Fetch the unified diff for a pull request via `gh pr diff`. Truncates at " +
        "`maxBytes` (default 64 KiB, max 1 MiB). Read-only.",
    inputSchema: prReviewDiffSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.pr);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } };
            return;
        }
        const cap = input.maxBytes ?? PR_DIFF_DEFAULT_MAX_BYTES;
        const argv = ["gh", "pr", "diff", ref];
        yield { type: "progress", message: `gh pr diff #${input.pr}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr diff failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        const diff = r.stdout;
        const body = diff.length > cap
            ? `${diff.slice(0, cap)}\n\n[truncated: ${diff.length} bytes total, showing first ${cap} bytes]`
            : diff;
        yield { type: "result", result: { ok: true, output: body } };
    },
});
const prAutoMergeSchema = z.object({
    pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
    method: z
        .enum(["merge", "squash", "rebase"])
        .optional()
        .describe("Merge method: merge (default) | squash | rebase"),
});
export const ghPrAutoMergeTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_auto_merge",
    description: "Enable auto-merge on a pull request — merges when all checks pass. " +
        "`method`: merge (default) | squash | rebase. Write — the mode's gitWrite " +
        "lever is the structural gate; this tool just invokes `gh`.",
    inputSchema: prAutoMergeSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input, ctx) {
        const ref = normalizeRef(input.pr);
        if (ref === undefined) {
            yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } };
            return;
        }
        const argv = ["gh", "pr", "merge", ref, "--auto"];
        switch (input.method) {
            case "squash":
                argv.push("--squash");
                break;
            case "rebase":
                argv.push("--rebase");
                break;
            default:
                argv.push("--merge");
                break;
        }
        yield {
            type: "progress",
            message: `gh pr merge #${input.pr} --auto --${input.method ?? "merge"}`,
        };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr merge failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield {
            type: "result",
            result: { ok: true, output: r.stdout.trim() || "auto-merge enabled" },
        };
    },
});
const prListSchema = z.object({
    state: z
        .enum(["open", "closed", "merged", "all"])
        .optional()
        .describe("Filter state (default open)"),
    limit: z.number().int().positive().optional().describe("Max results (default 20)"),
});
export const ghPrListTool = (runner = defaultGhRunner) => ({
    name: "gh_pr_list",
    description: "List GitHub PRs via `gh pr list --json`. Read-only.",
    inputSchema: prListSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const argv = [
            "gh",
            "pr",
            "list",
            "--state",
            input.state ?? "open",
            "--limit",
            String(input.limit ?? 20),
            "--json",
            "number,title,state,headRefName,baseRefName,url",
        ];
        yield { type: "progress", message: `gh pr list state=${input.state ?? "open"}` };
        const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS);
        if (r.code !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: `gh pr list failed: ${r.stderr.slice(0, 500)}` },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: r.stdout.trim() } };
    },
});
/** All gh tools (6 RFC may-22 + 3 ADR-0103/0104 = 9). Pass an injected
 *  runner for tests. Order: read-only first (view/issue/checks/list/blame/
 *  review_diff), then mutating (comment/create/auto_merge). */
export const ghTools = (runner = defaultGhRunner) => [
    ghPrViewTool(runner),
    ghIssueViewTool(runner),
    ghCheckStatusTool(runner),
    ghPrListTool(runner),
    // ADR-0103/0104 additions — read-only tools first.
    ghPrBlameTool(runner),
    ghPrReviewDiffTool(runner),
    // Mutating.
    ghPrCommentTool(runner),
    ghPrCreateTool(runner),
    ghPrAutoMergeTool(runner),
];
