import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultGitRunner, gitBlameTool, gitDiffTool, gitLogTool, gitStatusTool } from "@/tool/git"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (tool: ExecutableTool, input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
}

const run = async (cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> => {
  const p = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return { ok: code === 0, out: `${out}\n${err}` }
}

const hasGit = async (): Promise<boolean> => {
  try {
    const p = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" })
    const code = await p.exited
    return code === 0
  } catch {
    return false
  }
}

// Probe git ONCE at module load (top-level await is allowed in Bun test files)
// so `test.skipIf(!HAS_GIT)` makes the runner emit a real `skipped` count when
// git is absent. The prior pattern (`if (!HAS_GIT) return`) silently
// PASSED — making the suite green in environments where git was missing was
// indistinguishable from an actually-green suite.
const HAS_GIT = await hasGit()

let repoDir = ""

beforeAll(async () => {
  if (!HAS_GIT) return
  repoDir = await mkdtemp(join(tmpdir(), "git-tools-it-"))
  // Init repo with explicit main branch (works on git < 2.28 too).
  await run(repoDir, ["init", "-q"])
  await run(repoDir, ["checkout", "-q", "-b", "main"])
  await writeFile(join(repoDir, "foo.txt"), "line 1\nline 2\nline 3\n")
  await run(repoDir, ["add", "foo.txt"])
  await run(repoDir, ["commit", "-q", "-m", "initial commit"])
  await writeFile(join(repoDir, "foo.txt"), "line 1\nLINE TWO\nline 3\n")
  await run(repoDir, ["add", "foo.txt"])
  await run(repoDir, ["commit", "-q", "-m", "tweak line 2"])
})

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true })
})

describe("git tools — integration (real git)", () => {
  // W1-A audit fix: previous "environment probe" test always called
  // `expect(true).toBe(true)` so it claimed PASS regardless of whether git
  // was actually probed. Replace with a real assertion: the suite runs only
  // when `HAS_GIT` is true (verified at module load), and this test
  // pins that the probe latched correctly. When git is absent the test is
  // skipped, surfaced as `skipped`, not silently green.
  test.skipIf(!HAS_GIT)("environment probe — git is available", () => {
    expect(HAS_GIT).toBe(true)
  })

  test.skipIf(!HAS_GIT)("git_status: working tree clean after a commit", async () => {
    const t = gitStatusTool(defaultGitRunner)
    const result = await collect(t, {}, repoDir)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Branch:")
    expect(result.output).toMatch(/clean|working tree clean/i)
  })

  test.skipIf(!HAS_GIT)("git_status: detects unstaged modification", async () => {
    await writeFile(join(repoDir, "foo.txt"), "line 1\nLINE TWO\nLINE 3 EDITED\n")
    try {
      const result = await collect(gitStatusTool(defaultGitRunner), {}, repoDir)
      expect(result.ok).toBe(true)
      expect(result.output).toContain("foo.txt")
      expect(result.output).toMatch(/modified/i)
    } finally {
      // Restore for downstream tests.
      await writeFile(join(repoDir, "foo.txt"), "line 1\nLINE TWO\nline 3\n")
    }
  })

  test.skipIf(!HAS_GIT)("git_status: detects untracked file", async () => {
    const newPath = join(repoDir, "untracked.txt")
    await writeFile(newPath, "hello\n")
    try {
      const result = await collect(gitStatusTool(defaultGitRunner), {}, repoDir)
      expect(result.ok).toBe(true)
      expect(result.output).toContain("untracked.txt")
      expect(result.output).toMatch(/untracked/i)
    } finally {
      await rm(newPath, { force: true })
    }
  })

  test.skipIf(!HAS_GIT)("git_diff: shows hunk after editing a committed file", async () => {
    await writeFile(join(repoDir, "foo.txt"), "line 1\nLINE TWO!!\nline 3\n")
    try {
      const result = await collect(gitDiffTool(defaultGitRunner), {}, repoDir)
      expect(result.ok).toBe(true)
      expect(result.output).toContain("diff --git")
      expect(result.output).toContain("foo.txt")
      expect(result.output).toMatch(/^\+LINE TWO!!|^-LINE TWO/m)
    } finally {
      await writeFile(join(repoDir, "foo.txt"), "line 1\nLINE TWO\nline 3\n")
    }
  })

  test.skipIf(!HAS_GIT)("git_diff: clean tree → 'no diff'", async () => {
    const result = await collect(gitDiffTool(defaultGitRunner), {}, repoDir)
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/no diff/i)
  })

  test.skipIf(!HAS_GIT)("git_log: lists 2 commits", async () => {
    const result = await collect(gitLogTool(defaultGitRunner), { n: 10 }, repoDir)
    expect(result.ok).toBe(true)
    const lines = result.output.split("\n").filter(Boolean)
    expect(lines.length).toBe(2)
    expect(result.output).toContain("initial commit")
    expect(result.output).toContain("tweak line 2")
    expect(result.output).toContain("Test Author")
  })

  test.skipIf(!HAS_GIT)("git_log: with file restriction", async () => {
    const result = await collect(gitLogTool(defaultGitRunner), { file: "foo.txt", n: 5 }, repoDir)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("initial commit")
  })

  test.skipIf(!HAS_GIT)("git_blame: identifies last author/commit/summary for line 2", async () => {
    const result = await collect(
      gitBlameTool(defaultGitRunner),
      { file: "foo.txt", line: 2 },
      repoDir,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("foo.txt:2")
    expect(result.output).toContain("Test Author")
    // Line 2 was changed in "tweak line 2".
    expect(result.output).toContain("tweak line 2")
    expect(result.output).toContain("LINE TWO")
  })

  test.skipIf(!HAS_GIT)("not a git repository: status returns ok:false", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "git-tools-nonrepo-"))
    try {
      const result = await collect(gitStatusTool(defaultGitRunner), {}, nonRepo)
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/not a git repository/i)
    } finally {
      await rm(nonRepo, { recursive: true, force: true })
    }
  })
})
