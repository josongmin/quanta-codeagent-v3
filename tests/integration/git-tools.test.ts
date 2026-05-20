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

let repoDir = ""
let gitAvailable = false

beforeAll(async () => {
  gitAvailable = await hasGit()
  if (!gitAvailable) return
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
  test("environment probe", () => {
    if (!gitAvailable) {
      // Skip politely — log and pass.
      // biome-ignore lint/suspicious/noConsole: integration skip notice
      console.log("[skip] git not in PATH — integration tests are no-ops")
    }
    expect(true).toBe(true)
  })

  test("git_status: working tree clean after a commit", async () => {
    if (!gitAvailable) return
    const t = gitStatusTool(defaultGitRunner)
    const result = await collect(t, {}, repoDir)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Branch:")
    expect(result.output).toMatch(/clean|working tree clean/i)
  })

  test("git_status: detects unstaged modification", async () => {
    if (!gitAvailable) return
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

  test("git_status: detects untracked file", async () => {
    if (!gitAvailable) return
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

  test("git_diff: shows hunk after editing a committed file", async () => {
    if (!gitAvailable) return
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

  test("git_diff: clean tree → 'no diff'", async () => {
    if (!gitAvailable) return
    const result = await collect(gitDiffTool(defaultGitRunner), {}, repoDir)
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/no diff/i)
  })

  test("git_log: lists 2 commits", async () => {
    if (!gitAvailable) return
    const result = await collect(gitLogTool(defaultGitRunner), { n: 10 }, repoDir)
    expect(result.ok).toBe(true)
    const lines = result.output.split("\n").filter(Boolean)
    expect(lines.length).toBe(2)
    expect(result.output).toContain("initial commit")
    expect(result.output).toContain("tweak line 2")
    expect(result.output).toContain("Test Author")
  })

  test("git_log: with file restriction", async () => {
    if (!gitAvailable) return
    const result = await collect(gitLogTool(defaultGitRunner), { file: "foo.txt", n: 5 }, repoDir)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("initial commit")
  })

  test("git_blame: identifies last author/commit/summary for line 2", async () => {
    if (!gitAvailable) return
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

  test("not a git repository: status returns ok:false", async () => {
    if (!gitAvailable) return
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
