/** RFC-02 B4 — admitted source front door (real git + scripted reviewer; no LLM).
 *
 *  B1–B3 already expose `branch-base` / `commit` / `range` + the generated toggle
 *  through the REAL `git_review_diff` tool. B4 admits the two remaining front-door
 *  arms:
 *    • `working-tree` — a FIRST-CLASS supported source (`git diff <against>`,
 *      default `HEAD`) that reviews UNCOMMITTED changes; and
 *    • `last-turn` — an UNSUPPORTED arm that returns a STABLE prerequisite error
 *      (RFC-02 B5, parked) — never a crash, never a silent fallback to a working
 *      or branch diff.
 *
 *  RED before B4: an operator cannot select `working-tree` (schema rejects it as
 *  generic `invalid input`), and `last-turn` collapses to the same generic parse
 *  error rather than a stable, self-describing prerequisite message.
 *
 *  Anti-vacuity: every assertion is on the REAL `git diff` bytes reaching the
 *  reviewer (or the REAL deny reason), fed through the REAL tool `execute` against
 *  a real temporary repo — never a hand-built argv.
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
  repoDir = await mkdtemp(join(tmpdir(), "review-frontdoor-"))
  await git(repoDir, ["init", "-q"])
  await git(repoDir, ["checkout", "-q", "-b", "main"])
  // Commit 1 (ROOT): seed.
  await writeFile(join(repoDir, "seed.txt"), "seed\n")
  await git(repoDir, ["add", "seed.txt"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed"])
  // Commit 2: a source file, a declared-generated file + its sibling + attrs.
  await writeFile(join(repoDir, ".gitattributes"), "dist/bundle.js linguist-generated=true\n")
  await Bun.write(join(repoDir, "dist/bundle.js"), "console.log('generated v1')\n")
  await Bun.write(join(repoDir, "src/app.ts"), "export const app = () => 1\n")
  await git(repoDir, ["add", "-A"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: add files"])
  // DIRTY working tree (uncommitted): edit a tracked source file AND the declared
  // generated file. `git diff HEAD` must show BOTH; the committed history must not.
  await Bun.write(join(repoDir, "src/app.ts"), "export const app = () => 2 // WORKTREE_EDIT\n")
  await Bun.write(join(repoDir, "dist/bundle.js"), "console.log('generated v2 WORKTREE')\n")
})

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true })
})

const ctxFor = (reviewer: { runner: ReviewerRunner }): ToolContext => ({
  cwd: repoDir,
  signal: new AbortController().signal,
  reviewerAgent: reviewer.runner,
})

describe("git_review_diff — B4 working-tree front door (real git)", () => {
  test.skipIf(!HAS_GIT)(
    "working-tree source reviews the UNCOMMITTED edit (default against HEAD)",
    async () => {
      const reviewer = scriptedReviewer()
      const r = await collect({ source: { kind: "working-tree" } }, ctxFor(reviewer))
      expect(r.ok).toBe(true)
      // The reviewer was actually invoked (NOT denied at parse) — proves the arm
      // is first-class, not a generic `invalid input` rejection.
      expect(reviewer.calls.length).toBe(1)
      const prompt = reviewer.calls[0]?.prompt ?? ""
      // The dirty working-tree edit is present …
      expect(prompt).toContain("diff --git a/src/app.ts")
      expect(prompt).toContain("WORKTREE_EDIT")
      // … and this is NOT the branch-base/commit diff: the seed commit's own
      // "add files" content (v1) is not what working-tree-vs-HEAD reports as +.
      expect(prompt).not.toContain("+export const app = () => 1")
    },
  )

  test.skipIf(!HAS_GIT)("working-tree against an explicit commit widens the base", async () => {
    const reviewer = scriptedReviewer()
    // Against the ROOT commit: working tree vs seed ⇒ shows the WHOLE second
    // commit's source file plus the uncommitted edit on top.
    const r = await collect(
      { source: { kind: "working-tree", against: "HEAD~1" } },
      ctxFor(reviewer),
    )
    expect(r.ok).toBe(true)
    const prompt = reviewer.calls[0]?.prompt ?? ""
    expect(prompt).toContain("diff --git a/src/app.ts")
    expect(prompt).toContain("WORKTREE_EDIT")
  })

  test.skipIf(!HAS_GIT)(
    "working-tree + filterGenerated hides the declared file, keeps the source edit",
    async () => {
      const reviewer = scriptedReviewer()
      await collect({ source: { kind: "working-tree" }, filterGenerated: true }, ctxFor(reviewer))
      const prompt = reviewer.calls[0]?.prompt ?? ""
      // Declared-generated file's dirty hunk is filtered out …
      expect(prompt).not.toContain("diff --git a/dist/bundle.js")
      expect(prompt).not.toContain("generated v2 WORKTREE")
      // … the hand-written source edit survives (operator source → B3 filter).
      expect(prompt).toContain("diff --git a/src/app.ts")
      expect(prompt).toContain("WORKTREE_EDIT")
    },
  )

  test.skipIf(!HAS_GIT)(
    "source selection is VISIBLE: working-tree bytes differ from commit bytes",
    async () => {
      const wt = scriptedReviewer()
      await collect({ source: { kind: "working-tree" } }, ctxFor(wt))
      const commit = scriptedReviewer()
      await collect({ source: { kind: "commit", oid: "HEAD" } }, ctxFor(commit))
      const wtPrompt = wt.calls[0]?.prompt ?? ""
      const commitPrompt = commit.calls[0]?.prompt ?? ""
      // The committed HEAD patch does NOT contain the uncommitted marker; the
      // working-tree diff does. Same tool, different source ⇒ different bytes.
      expect(wtPrompt).toContain("WORKTREE_EDIT")
      expect(commitPrompt).not.toContain("WORKTREE_EDIT")
      expect(wtPrompt).not.toBe(commitPrompt)
    },
  )

  test.skipIf(!HAS_GIT)("working-tree against a leading-dash ref fails closed", async () => {
    const reviewer = scriptedReviewer()
    const r = await collect(
      { source: { kind: "working-tree", against: "--output=/tmp/x" } },
      ctxFor(reviewer),
    )
    expect(r.ok).toBe(false)
    expect(reviewer.calls.length).toBe(0)
    expect(r.output).toContain("must not begin with '-'")
  })

  test.skipIf(!HAS_GIT)(
    "working-tree against a nonexistent ref fails closed (NO working-tree fallback)",
    async () => {
      const reviewer = scriptedReviewer()
      const r = await collect(
        { source: { kind: "working-tree", against: "no-such-ref-xyz" } },
        ctxFor(reviewer),
      )
      // git diff errors on an unresolvable ref ⇒ deny; never silently degrades to
      // a bare `git diff`.
      expect(r.ok).toBe(false)
      expect(reviewer.calls.length).toBe(0)
    },
  )
})

describe("git_review_diff — B4 last-turn stable prerequisite error", () => {
  test.skipIf(!HAS_GIT)(
    "last-turn returns a STABLE prerequisite error, not a crash or generic parse error",
    async () => {
      const reviewer = scriptedReviewer()
      const r = await collect({ source: { kind: "last-turn", turnId: "turn-1" } }, ctxFor(reviewer))
      // Deterministic ok:false (no throw), reviewer never invoked, no diff run.
      expect(r.ok).toBe(false)
      expect(reviewer.calls.length).toBe(0)
      // Self-describing + stable: names the arm and its parked prerequisite, and
      // is NOT the generic zod `invalid input` string.
      expect(r.output).toContain("last-turn")
      expect(r.output.toLowerCase()).toContain("boundary")
      expect(r.output).not.toContain("invalid input")
    },
  )
})

describe("git_review_diff — B4 schema unchanged + legacy default intact", () => {
  test.skipIf(!HAS_GIT)(
    "structured result keeps the {summary, findings} shape across the new arm",
    async () => {
      const reviewer = scriptedReviewer()
      const r = await collect({ source: { kind: "working-tree" } }, ctxFor(reviewer))
      expect(r.ok).toBe(true)
      const structured = r.structured as { summary?: unknown; findings?: unknown } | undefined
      expect(typeof structured?.summary).toBe("string")
      expect(Array.isArray(structured?.findings)).toBe(true)
    },
  )

  test.skipIf(!HAS_GIT)("no source ⇒ legacy branch-base default still runs", async () => {
    const reviewer = scriptedReviewer()
    // origin/main is absent in this fixture ⇒ git diff origin/main...HEAD errors ⇒
    // deny. The point is the UNSET path still routes through the legacy argv
    // (byte-identical), not the new front door.
    const r = await collect({}, ctxFor(reviewer))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("origin/main")
  })
})
