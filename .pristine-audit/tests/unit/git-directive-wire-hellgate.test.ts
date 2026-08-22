/**
 * ADR-0220 wire hellgate — `git_commit` / `git_branch_switch` × emitter seam.
 *
 * 4 invariants on the opt-in `gitDirectiveEmitter` option added to the two
 * mutating git tool factories:
 *
 *   HELL-GDW-01  default-OFF byte-identical — absent emitter ⇒ no extra
 *                git rev-parse call observed; tool result unchanged.
 *   HELL-GDW-02  successful `git_commit` emits exactly one `commit`
 *                directive carrying the commit message + non-empty SHA.
 *   HELL-GDW-03  failing `git_commit` (regular without message) emits
 *                ZERO directives — success-only contract.
 *   HELL-GDW-04  successful `git_branch_switch({create:true})` emits
 *                exactly one `create-branch` directive with the new
 *                branch name; dirty + autoWip also emits a `commit`
 *                directive for the wip checkpoint (FIFO order).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitDirective, GitDirectiveEmitter } from "@/agent/git-directives"
import { defaultGitRunner, type GitRunner, gitBranchSwitchTool, gitCommitTool } from "@/tool/git"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// ----------------------------------------------------------------------------
// Real-repo harness (same shape as tests/unit/git-tools-hellgate.test.ts)
// ----------------------------------------------------------------------------

const git = async (cwd: string, args: string[]): Promise<void> => {
  const r = await defaultGitRunner.run(args, cwd)
  if (r.exitCode !== 0) {
    throw new Error(`setup git ${args.join(" ")} failed: ${r.stderr}`)
  }
}

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-git-dirwire-"))
  await git(dir, ["init", "-b", "main"])
  await git(dir, ["config", "user.email", "wire@example.com"])
  await git(dir, ["config", "user.name", "Wire"])
  await git(dir, ["config", "commit.gpgsign", "false"])
  // One initial commit so subsequent ops have a HEAD.
  writeFileSync(join(dir, "README.md"), "init\n", "utf8")
  await git(dir, ["add", "."])
  await git(dir, ["commit", "-m", "init"])
  return dir
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const run = async (tool: ExecutableTool, input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("tool produced no result event")
  return result
}

const recordingEmitter = (): { emitter: GitDirectiveEmitter; events: GitDirective[] } => {
  const events: GitDirective[] = []
  const emitter: GitDirectiveEmitter = {
    emit(d: GitDirective): void {
      events.push(d)
    },
  }
  return { emitter, events }
}

// Wrap the real runner to count rev-parse invocations (so we can prove the
// default-OFF path skips the SHA lookup entirely).
const countingRunner = (inner: GitRunner): { runner: GitRunner; revParseCalls: number } => {
  const state = { revParseCalls: 0 }
  const runner: GitRunner = {
    async run(args, cwd, signal) {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        state.revParseCalls += 1
      }
      return inner.run(args, cwd, signal)
    },
  }
  // Expose count via getter so test reads the LIVE counter.
  return {
    runner,
    get revParseCalls(): number {
      return state.revParseCalls
    },
  } as { runner: GitRunner; revParseCalls: number }
}

let repoDir: string
beforeAll(async () => {
  repoDir = await makeRepo()
})
afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

// ----------------------------------------------------------------------------
// HELL-GDW-01 default-OFF byte-identical
// ----------------------------------------------------------------------------

describe("HELL-GDW-01 default-OFF byte-identical", () => {
  test("absent emitter: gitCommitTool runs no extra rev-parse, tool result unchanged", async () => {
    // Touch a file so there is something to commit.
    writeFileSync(join(repoDir, "a.txt"), "alpha\n", "utf8")
    const wrap = countingRunner(defaultGitRunner)
    const tool = gitCommitTool(wrap.runner) // NO opts
    const res = await run(tool as ExecutableTool, { message: "feat: a" }, repoDir)
    expect(res.ok).toBe(true)
    expect(wrap.revParseCalls).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-GDW-02 successful commit emits one commit directive
// ----------------------------------------------------------------------------

describe("HELL-GDW-02 successful commit emits one commit directive", () => {
  test("emitter wired: emit called once with kind=commit and non-empty sha", async () => {
    writeFileSync(join(repoDir, "b.txt"), "beta\n", "utf8")
    const { emitter, events } = recordingEmitter()
    const tool = gitCommitTool(defaultGitRunner, { gitDirectiveEmitter: emitter })
    const res = await run(tool as ExecutableTool, { message: "feat: b" }, repoDir)
    expect(res.ok).toBe(true)
    expect(events.length).toBe(1)
    const first = events[0]
    if (!first || first.kind !== "commit") throw new Error("expected commit directive")
    expect(first.message).toBe("feat: b")
    // SHA was resolved via rev-parse — must be a 40-char hex (or short).
    expect(first.sha.length).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-GDW-03 failing commit emits ZERO directives
// ----------------------------------------------------------------------------

describe("HELL-GDW-03 failing commit emits ZERO directives", () => {
  test("regular commit without message: emit never called", async () => {
    const { emitter, events } = recordingEmitter()
    const tool = gitCommitTool(defaultGitRunner, { gitDirectiveEmitter: emitter })
    // mode='regular' (default), message omitted → tool yields ok:false.
    const res = await run(tool as ExecutableTool, {}, repoDir)
    expect(res.ok).toBe(false)
    expect(events.length).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// HELL-GDW-04 branch-switch create=true emits create-branch
// ----------------------------------------------------------------------------

describe("HELL-GDW-04 branch-switch emits create-branch + wip commit (FIFO)", () => {
  test("dirty + autoWip + create=true → [commit (wip), create-branch] in FIFO order", async () => {
    // Make the tree dirty by touching a file.
    writeFileSync(join(repoDir, "c.txt"), "gamma\n", "utf8")
    const { emitter, events } = recordingEmitter()
    const tool = gitBranchSwitchTool(defaultGitRunner, { gitDirectiveEmitter: emitter })
    const res = await run(
      tool as ExecutableTool,
      { branch: "feat/wire-test", create: true, autoWip: true },
      repoDir,
    )
    expect(res.ok).toBe(true)
    // FIFO: wip commit first, then create-branch.
    expect(events.length).toBe(2)
    const [first, second] = events
    if (!first || first.kind !== "commit") throw new Error("expected commit first")
    if (!second || second.kind !== "create-branch") throw new Error("expected create-branch second")
    expect(second.name).toBe("feat/wire-test")
  })
})
