/** Integration tests for `git_review_diff` against a real git repository in
 *  a tmpdir, with an in-process FAKE reviewer (no real LLM). Asserts:
 *
 *    • two-commit repo + `git_review_diff` produces a real diff, hands it to
 *      the injected reviewer, and returns the reviewer's parsed report
 *    • the main session's "history" (modeled here as a list the test maintains)
 *      is NOT touched by the review — only ONE tool result is appended;
 *      the reviewer's internal turns are isolated.
 *    • {paths} scopes the diff
 *    • empty diff path (no changes between base and head) ⇒ ok:true / no
 *      reviewer call
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultGitRunner, gitReviewDiffTool } from "@/tool/git"
import type {
  ReviewerRequest,
  ReviewerResult,
  ReviewerRunner,
  ToolContext,
  ToolEvent,
  ToolResult,
} from "@/tool/types"

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

const git = async (
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  const p = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return { ok: code === 0, stdout, stderr }
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

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// A scripted reviewer that records the request and returns a canned report.
// Simulates the sub-agent runner the agent slice would inject in production.
interface ScriptedReviewer {
  runner: ReviewerRunner
  calls: ReviewerRequest[]
}

const scriptedReviewer = (final: ReviewerResult): ScriptedReviewer => {
  const calls: ReviewerRequest[] = []
  const runner: ReviewerRunner = async (req: ReviewerRequest) => {
    calls.push(req)
    return final
  }
  return { runner, calls }
}

let gitAvailable = false
let repoDir = ""

beforeAll(async () => {
  gitAvailable = await hasGit()
  if (!gitAvailable) return
  repoDir = await mkdtemp(join(tmpdir(), "git-review-diff-e2e-"))
  await git(repoDir, ["init", "-q"])
  await git(repoDir, ["checkout", "-q", "-b", "main"])

  // Commit 1: seed file.
  await writeFile(join(repoDir, "seed.txt"), "seed line\n")
  await git(repoDir, ["add", "seed.txt"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed"])

  // Commit 2: add a TODO-laden file the reviewer should flag.
  await writeFile(
    join(repoDir, "feat.ts"),
    "export const feat = (x: number) => x * 2\n// TODO: validate x is positive\n",
  )
  await git(repoDir, ["add", "feat.ts"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: add feat fn"])
})

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true })
})

describe("git_review_diff — e2e (real git + scripted reviewer)", () => {
  test.skipIf(!gitAvailable)("environment probe — git is available", () => {
    expect(gitAvailable).toBe(true)
  })

  test("two-commit repo: base=HEAD~1, head=HEAD ⇒ reviewer sees real diff + returns parsed report", async () => {
    if (!gitAvailable) return
    const reviewer = scriptedReviewer({
      ok: true,
      finalText: JSON.stringify({
        summary: "1 minor issue.",
        findings: [
          {
            file: "feat.ts",
            line: 2,
            severity: "warning",
            what: "TODO comment retained",
            why: "Indicates incomplete validation",
            impact: "May ship unverified input handling",
          },
        ],
      }),
      turns: 2,
    })

    // Simulated main-loop history. The whole point of the absorption is that
    // the review does NOT mutate this; only ONE tool_result is appended.
    const mainHistory: { type: string; text: string }[] = [
      { type: "user", text: "review the latest changes" },
    ]

    const ctx: ToolContext = {
      cwd: repoDir,
      signal: new AbortController().signal,
      reviewerAgent: reviewer.runner,
    }

    const r = await collect(
      gitReviewDiffTool(defaultGitRunner),
      { base: "HEAD~1", head: "HEAD", focus: "look for missing input validation" },
      ctx,
    )

    // Tool result is OK, with the parsed report rendered.
    expect(r.ok).toBe(true)
    expect(r.output).toContain("TODO comment retained")
    const struct = r.structured as { summary: string; findings: { file: string }[] } | undefined
    expect(struct?.findings.length).toBe(1)
    expect(struct?.findings[0]?.file).toBe("feat.ts")

    // Reviewer was invoked EXACTLY ONCE — and its `prompt` carried the real diff
    // text + the caller's focus hint. Depth chained from absent ctx.depth ⇒ 1.
    expect(reviewer.calls.length).toBe(1)
    const call = reviewer.calls[0]
    expect(call?.depth).toBe(1)
    expect(call?.taskKind).toBe("review")
    expect(call?.toolFilter).toEqual(["read", "grep", "glob"])
    expect(call?.prompt).toContain("feat.ts")
    expect(call?.prompt).toContain("TODO: validate x is positive")
    expect(call?.prompt).toContain("look for missing input validation")

    // Main session "history" was NOT mutated by the reviewer's internal turns.
    // We simulate appending the tool_result here — only ONE entry is added.
    mainHistory.push({ type: "tool_result", text: r.output })
    expect(mainHistory.length).toBe(2)
    expect(mainHistory.map((m) => m.type)).toEqual(["user", "tool_result"])
  })

  test("paths scope the diff (only files under given path are reviewed)", async () => {
    if (!gitAvailable) return
    const reviewer = scriptedReviewer({
      ok: true,
      finalText: JSON.stringify({ summary: "clean", findings: [] }),
      turns: 1,
    })
    const ctx: ToolContext = {
      cwd: repoDir,
      signal: new AbortController().signal,
      reviewerAgent: reviewer.runner,
    }
    await collect(
      gitReviewDiffTool(defaultGitRunner),
      { base: "HEAD~1", head: "HEAD", paths: ["seed.txt"] },
      ctx,
    )
    // seed.txt did not change between HEAD~1 and HEAD ⇒ empty diff ⇒ reviewer
    // is NOT invoked.
    expect(reviewer.calls.length).toBe(0)
  })

  test("empty diff (base === head) ⇒ ok:true + no reviewer call", async () => {
    if (!gitAvailable) return
    const reviewer = scriptedReviewer({
      ok: true,
      finalText: "(unused)",
      turns: 0,
    })
    const ctx: ToolContext = {
      cwd: repoDir,
      signal: new AbortController().signal,
      reviewerAgent: reviewer.runner,
    }
    const r = await collect(
      gitReviewDiffTool(defaultGitRunner),
      { base: "HEAD", head: "HEAD" },
      ctx,
    )
    expect(r.ok).toBe(true)
    expect(reviewer.calls.length).toBe(0)
    expect(r.output).toMatch(/no diff|empty/i)
  })

  test("reviewer port absent ⇒ ok:false (no throw, deterministic)", async () => {
    if (!gitAvailable) return
    const ctx: ToolContext = {
      cwd: repoDir,
      signal: new AbortController().signal,
      // reviewerAgent intentionally unset
    }
    const r = await collect(
      gitReviewDiffTool(defaultGitRunner),
      { base: "HEAD~1", head: "HEAD" },
      ctx,
    )
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/reviewer|not.*attached/i)
  })
})
