class FakeRunner {
  result;
  calls = [];
  constructor(result) {
    this.result = result;
  }
  async run(args, cwd) {
    this.calls.push({ args: [...args], cwd });
    const r = typeof this.result === "function" ? this.result(args) : this.result;
    return r;
  }
}

class ThrowingRunner {
  async run() {
    throw new Error("spawn ENOENT");
  }
}
import { describe, expect, test } from "bun:test";
import { gitBlameTool, gitDiffTool, gitLogTool, gitStatusTool } from "@/tool/git";
const ctx = () => ({
  cwd: "/tmp",
  signal: new AbortController().signal
});
const collect = async (tool, input) => {
  const progress = [];
  let result;
  for await (const ev of tool.execute(input, ctx())) {
    if (ev.type === "progress")
      progress.push(ev.message);
    else
      result = ev.result;
  }
  if (!result)
    throw new Error("no result");
  return { result, progress };
};
const okResult = (stdout) => ({ stdout, stderr: "", exitCode: 0 });
const errResult = (stderr, exitCode = 128) => ({
  stdout: "",
  stderr,
  exitCode
});
describe("gitDiffTool", () => {
  test("metadata: read-only, concurrency-safe", () => {
    const t = gitDiffTool(new FakeRunner(okResult("")));
    expect(t.name).toBe("git_diff");
    expect(t.isReadOnly()).toBe(true);
    expect(t.isConcurrencySafe({})).toBe(true);
    expect(t.description).toMatch(/diff/i);
  });
  test("golden: working tree diff (exit 0, has content)", async () => {
    const diffOut = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
-old
+new
`;
    const runner = new FakeRunner(okResult(`diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
-old
+new
`));
    const t = gitDiffTool(runner);
    const { result } = await collect(t, {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("diff --git a/foo.ts");
    expect(runner.calls[0]?.args).toEqual(["diff"]);
  });
  test("exit 1 with diff output is OK (diff exits 1 when differences exist)", async () => {
    const runner = new FakeRunner({
      stdout: `diff --git a/x b/x
+added
`,
      stderr: "",
      exitCode: 1
    });
    const { result } = await collect(gitDiffTool(runner), {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("+added");
  });
  test("empty diff (exit 0, no output)", async () => {
    const { result } = await collect(gitDiffTool(new FakeRunner(okResult(""))), {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no diff");
  });
  test("staged + base + paths build the correct argv", async () => {
    const runner = new FakeRunner(okResult(""));
    await collect(gitDiffTool(runner), {
      staged: true,
      base: "HEAD~1",
      paths: ["a.ts", "b.ts"]
    });
    expect(runner.calls[0]?.args).toEqual(["diff", "--staged", "HEAD~1", "--", "a.ts", "b.ts"]);
  });
  test("not a git repository \u2192 ok:false with stderr", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository (or any of the parent directories): .git"));
    const { result } = await collect(gitDiffTool(runner), {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a git repository");
  });
  test("exit 2 with stderr \u2192 ok:false", async () => {
    const runner = new FakeRunner({ stdout: "", stderr: "fatal: bad object xyz", exitCode: 128 });
    const { result } = await collect(gitDiffTool(runner), { base: "xyz" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("bad object");
  });
  test("runner spawn failure \u2192 ok:false with the error message", async () => {
    const { result } = await collect(gitDiffTool(new ThrowingRunner), {});
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/spawn|ENOENT/i);
  });
  test("very large diff is truncated to 50_000 chars with marker", async () => {
    const huge = "x".repeat(60000);
    const { result } = await collect(gitDiffTool(new FakeRunner(okResult(huge))), {});
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(50200);
    expect(result.output).toMatch(/truncated/i);
  });
  test("schema rejects non-array paths", () => {
    const t = gitDiffTool(new FakeRunner(okResult("")));
    expect(t.inputSchema.safeParse({ paths: "a.ts" }).success).toBe(false);
  });
  test("leading-dash base is rejected (no option injection), runner never called", async () => {
    for (const base of ["--output=/tmp/pwn", "-G.", "--ext-diff"]) {
      const runner = new FakeRunner(okResult(""));
      const { result } = await collect(gitDiffTool(runner), { base });
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/must not begin with '-'/);
      expect(runner.calls.length).toBe(0);
    }
  });
  test("a normal revision is still passed through verbatim", async () => {
    const runner = new FakeRunner(okResult(""));
    await collect(gitDiffTool(runner), { base: "HEAD~3" });
    expect(runner.calls[0]?.args).toEqual(["diff", "HEAD~3"]);
  });
});
describe("gitStatusTool", () => {
  test("metadata", () => {
    const t = gitStatusTool(new FakeRunner(okResult("")));
    expect(t.name).toBe("git_status");
    expect(t.isReadOnly()).toBe(true);
    expect(t.isConcurrencySafe({})).toBe(true);
  });
  test("argv: porcelain v2 + branch", async () => {
    const runner = new FakeRunner(okResult(`# branch.head main
`));
    await collect(gitStatusTool(runner), {});
    expect(runner.calls[0]?.args).toEqual(["status", "--porcelain=v2", "--branch"]);
  });
  test("clean working tree", async () => {
    const out = `# branch.oid abc
# branch.head main
`;
    const { result } = await collect(gitStatusTool(new FakeRunner(okResult(`# branch.oid abc
# branch.head main
`))), {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Branch: main");
    expect(result.output).toContain("working tree clean");
  });
  test("parses porcelain v2: branch + ahead/behind + modified/untracked", async () => {
    const out = [
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -0",
      "1 M. N... 100644 100644 100644 a1 a2 src/foo.ts",
      "1 .M N... 100644 100644 100644 b1 b2 src/bar.ts",
      "? new.txt",
      ""
    ].join(`
`);
    const { result } = await collect(gitStatusTool(new FakeRunner(okResult(out))), {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Branch: main");
    expect(result.output).toContain("ahead 2");
    expect(result.output).toContain("src/foo.ts");
    expect(result.output).toContain("src/bar.ts");
    expect(result.output).toContain("new.txt");
    expect(result.output).toMatch(/modified/);
    expect(result.output).toMatch(/untracked/);
  });
  test("not a git repository \u2192 ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository"));
    const { result } = await collect(gitStatusTool(runner), {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a git repository");
  });
  test("runner spawn failure \u2192 ok:false", async () => {
    const { result } = await collect(gitStatusTool(new ThrowingRunner), {});
    expect(result.ok).toBe(false);
  });
});
describe("gitLogTool", () => {
  test("metadata", () => {
    const t = gitLogTool(new FakeRunner(okResult("")));
    expect(t.name).toBe("git_log");
    expect(t.isReadOnly()).toBe(true);
    expect(t.isConcurrencySafe({})).toBe(true);
  });
  test("default argv uses n=10", async () => {
    const runner = new FakeRunner(okResult(""));
    await collect(gitLogTool(runner), {});
    expect(runner.calls[0]?.args).toEqual([
      "log",
      "--no-textconv",
      "--no-ext-diff",
      "--format=%H%x1f%an%x1f%ai%x1f%s",
      "-n",
      "10"
    ]);
  });
  test("respects n + adds --follow for file", async () => {
    const runner = new FakeRunner(okResult(""));
    await collect(gitLogTool(runner), { n: 3, file: "src/foo.ts" });
    expect(runner.calls[0]?.args).toEqual([
      "log",
      "--no-textconv",
      "--no-ext-diff",
      "--format=%H%x1f%an%x1f%ai%x1f%s",
      "-n",
      "3",
      "--follow",
      "--",
      "src/foo.ts"
    ]);
  });
  test("formats commits as hash8 (author, date) subject", async () => {
    const US = "\x1F";
    const stdout = [
      "0123456789abcdef0123456789abcdef01234567\x1FAlice\x1F2024-01-02 03:04:05 +0000\x1Finitial",
      "fedcba9876543210fedcba9876543210fedcba98\x1FBob\x1F2024-02-03 04:05:06 +0000\x1Ffix bug",
      ""
    ].join(`
`);
    const { result } = await collect(gitLogTool(new FakeRunner(okResult(stdout))), {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("01234567");
    expect(result.output).toContain("Alice");
    expect(result.output).toContain("2024-01-02");
    expect(result.output).toContain("initial");
    expect(result.output).toContain("fedcba98");
    expect(result.output).toContain("fix bug");
  });
  test("empty log \u2192 (no commits)", async () => {
    const { result } = await collect(gitLogTool(new FakeRunner(okResult(""))), {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("(no commits)");
  });
  test("not a git repository \u2192 ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository"));
    const { result } = await collect(gitLogTool(runner), {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a git repository");
  });
  test("schema rejects n=0 and n>200", () => {
    const t = gitLogTool(new FakeRunner(okResult("")));
    expect(t.inputSchema.safeParse({ n: 0 }).success).toBe(false);
    expect(t.inputSchema.safeParse({ n: 201 }).success).toBe(false);
    expect(t.inputSchema.safeParse({ n: 10 }).success).toBe(true);
  });
  test("runner spawn failure \u2192 ok:false", async () => {
    const { result } = await collect(gitLogTool(new ThrowingRunner), {});
    expect(result.ok).toBe(false);
  });
});
describe("gitBlameTool", () => {
  test("metadata", () => {
    const t = gitBlameTool(new FakeRunner(okResult("")));
    expect(t.name).toBe("git_blame");
    expect(t.isReadOnly()).toBe(true);
    expect(t.isConcurrencySafe({ file: "x.ts", line: 1 })).toBe(true);
  });
  test("argv: -L line,line --porcelain -- file", async () => {
    const runner = new FakeRunner(okResult(""));
    runner.calls.length = 0;
    const t = gitBlameTool(runner);
    try {
      await collect(t, { file: "src/foo.ts", line: 5 });
    } catch {}
    expect(runner.calls[0]?.args).toEqual(["blame", "-L", "5,5", "--porcelain", "--", "src/foo.ts"]);
  });
  test("parses porcelain output: hash + author + date + summary + content", async () => {
    const stdout = [
      "1234567890abcdef1234567890abcdef12345678 7 7 1",
      "author Alice Example",
      "author-mail <alice@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Bob",
      "committer-mail <bob@example.com>",
      "committer-time 1700000000",
      "committer-tz +0000",
      "summary fix the thing",
      "previous abcdef1234 src/foo.ts",
      "filename src/foo.ts",
      "\tconst x = 42",
      ""
    ].join(`
`);
    const { result } = await collect(gitBlameTool(new FakeRunner(okResult(stdout))), {
      file: "src/foo.ts",
      line: 7
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/foo.ts:7");
    expect(result.output).toContain("12345678");
    expect(result.output).toContain("Alice Example");
    expect(result.output).toMatch(/2023-\d{2}-\d{2}/);
    expect(result.output).toContain("fix the thing");
    expect(result.output).toContain("const x = 42");
  });
  test("no such file \u2192 ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: no such path 'missing.ts' in HEAD"));
    const { result } = await collect(gitBlameTool(runner), { file: "missing.ts", line: 1 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no such/i);
  });
  test("line out of range \u2192 ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: file src/foo.ts has only 3 lines"));
    const { result } = await collect(gitBlameTool(runner), { file: "src/foo.ts", line: 999 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/only \d+ lines|out of range/i);
  });
  test("not a git repository \u2192 ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository"));
    const { result } = await collect(gitBlameTool(runner), { file: "x.ts", line: 1 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a git repository");
  });
  test("schema rejects missing line", () => {
    const t = gitBlameTool(new FakeRunner(okResult("")));
    expect(t.inputSchema.safeParse({ file: "x.ts" }).success).toBe(false);
    expect(t.inputSchema.safeParse({ file: "x.ts", line: 0 }).success).toBe(false);
    expect(t.inputSchema.safeParse({ file: "x.ts", line: -1 }).success).toBe(false);
    expect(t.inputSchema.safeParse({ line: 1 }).success).toBe(false);
  });
  test("runner spawn failure \u2192 ok:false", async () => {
    const { result } = await collect(gitBlameTool(new ThrowingRunner), {
      file: "x.ts",
      line: 1
    });
    expect(result.ok).toBe(false);
  });
});
describe("git tools barrel", () => {
  test("default runner module exports run()", async () => {
    const { defaultGitRunner } = await import("@/tool/git");
    expect(typeof defaultGitRunner.run).toBe("function");
  });
  test("gitTools() with no arg returns all twelve tools (10 read-only + 2 mutating)", async () => {
    const { gitTools } = await import("@/tool/git");
    const tools = gitTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "git_blame",
      "git_blame_heatmap",
      "git_branch_switch",
      "git_churn",
      "git_commit",
      "git_conflict_inspect",
      "git_diff",
      "git_log",
      "git_moved_code",
      "git_review_diff",
      "git_status",
      "git_upstream_check"
    ]);
    const readOnlyCount = tools.filter((t) => t.isReadOnly()).length;
    expect(readOnlyCount).toBe(10);
    const mutatingCount = tools.filter((t) => !t.isReadOnly()).length;
    expect(mutatingCount).toBe(2);
  });
  test("gitTools(runner) injects the runner across all twelve", async () => {
    const { gitTools } = await import("@/tool/git");
    const runner = new FakeRunner(okResult(""));
    const tools = gitTools(runner);
    expect(tools).toHaveLength(12);
    const statusTool = tools.find((x) => x.name === "git_status");
    if (!statusTool)
      throw new Error("git_status missing");
    await collect(statusTool, {});
    expect(runner.calls.length).toBeGreaterThan(0);
  });
});
