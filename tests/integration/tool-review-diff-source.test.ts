/** RFC-02 B3 — generated-file filter front-door receipt (real git + real
 *  `.gitattributes`, scripted reviewer; no LLM).
 *
 *  Proves through the REAL `git_review_diff` tool against a real repo:
 *    • a source picker (`{source:{kind:"commit"}}`) drives the scoped diff;
 *    • `filterGenerated:true` EXCLUDES a file the repo DECLARES generated
 *      (`dist/bundle.js linguist-generated=true`) from the reviewer's context;
 *    • a sibling `dist/other.js` that is NOT declared SURVIVES the filter even
 *      with the toggle on (red-on-injection: name alone never triggers it);
 *    • toggle OFF ⇒ the declared file is present again (byte behavior restored).
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

const git = async (cwd: string, args: string[]): Promise<void> => {
  const p = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  await p.exited
}

const hasGit = async (): Promise<boolean> => {
  try {
    const p = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" })
    return (await p.exited) === 0
  } catch {
    return false
  }
}

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of (gitReviewDiffTool(defaultGitRunner) as ExecutableTool).execute(
    input as never,
    c,
  )) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const scriptedReviewer = (): { runner: ReviewerRunner; calls: ReviewerRequest[] } => {
  const calls: ReviewerRequest[] = []
  const final: ReviewerResult = {
    ok: true,
    finalText: JSON.stringify({ summary: "clean", findings: [] }),
    turns: 1,
  }
  const runner: ReviewerRunner = async (req: ReviewerRequest) => {
    calls.push(req)
    return final
  }
  return { runner, calls }
}

const HAS_GIT = await hasGit()
let repoDir = ""

beforeAll(async () => {
  if (!HAS_GIT) return
  repoDir = await mkdtemp(join(tmpdir(), "review-diff-source-"))
  await git(repoDir, ["init", "-q"])
  await git(repoDir, ["checkout", "-q", "-b", "main"])
  await writeFile(join(repoDir, "seed.txt"), "seed\n")
  await git(repoDir, ["add", "seed.txt"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed"])

  // Second commit: a declared-generated file, an UNDECLARED sibling in the same
  // dir, a real source file, and the .gitattributes declaration itself.
  await writeFile(join(repoDir, ".gitattributes"), "dist/bundle.js linguist-generated=true\n")
  await Bun.write(join(repoDir, "dist/bundle.js"), "console.log('generated')\n")
  await Bun.write(join(repoDir, "dist/other.js"), "console.log('hand-written in dist')\n")
  await Bun.write(join(repoDir, "src/app.ts"), "export const app = () => 1\n")
  await git(repoDir, ["add", "-A"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: add files"])
})

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true })
})

const ctxFor = (reviewer: { runner: ReviewerRunner }): ToolContext => ({
  cwd: repoDir,
  signal: new AbortController().signal,
  reviewerAgent: reviewer.runner,
})

describe("git_review_diff — generated filter (real git)", () => {
  test.skipIf(!HAS_GIT)(
    "filterGenerated:true hides the DECLARED file, keeps the undeclared sibling",
    async () => {
      const reviewer = scriptedReviewer()
      await collect(
        { source: { kind: "commit", oid: "HEAD" }, filterGenerated: true },
        ctxFor(reviewer),
      )
      expect(reviewer.calls.length).toBe(1)
      const prompt = reviewer.calls[0]?.prompt ?? ""
      // Declared generated ⇒ its diff hunk + content are excluded from the
      // reviewer's context. (The path string also appears inside the committed
      // .gitattributes line, so assert on the diff HEADER + file CONTENT, not the
      // bare path.)
      expect(prompt).not.toContain("diff --git a/dist/bundle.js")
      expect(prompt).not.toContain("console.log('generated')")
      // Undeclared sibling under dist/ SURVIVES (red-on-injection).
      expect(prompt).toContain("diff --git a/dist/other.js")
      expect(prompt).toContain("console.log('hand-written in dist')")
      expect(prompt).toContain("diff --git a/src/app.ts")
    },
  )

  test.skipIf(!HAS_GIT)("filterGenerated OFF ⇒ the declared file is present again", async () => {
    const reviewer = scriptedReviewer()
    await collect({ source: { kind: "commit", oid: "HEAD" } }, ctxFor(reviewer))
    const prompt = reviewer.calls[0]?.prompt ?? ""
    // Toggle OFF ⇒ the declared file's hunk + content are present again.
    expect(prompt).toContain("diff --git a/dist/bundle.js")
    expect(prompt).toContain("console.log('generated')")
    expect(prompt).toContain("diff --git a/dist/other.js")
  })

  test.skipIf(!HAS_GIT)(
    "ROOT commit source ⇒ empty-tree base, diff shows the root file added",
    async () => {
      // The seed commit is the repo ROOT (no parent) ⇒ base resolves to the
      // empty tree. This exercises the empty-tree argv end-to-end through real git.
      const reviewer = scriptedReviewer()
      const r = await collect({ source: { kind: "commit", oid: "HEAD~1" } }, ctxFor(reviewer))
      expect(r.ok).toBe(true)
      const prompt = reviewer.calls[0]?.prompt ?? ""
      expect(prompt).toContain("diff --git a/seed.txt")
      expect(prompt).toContain("+seed")
    },
  )
})
