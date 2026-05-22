/**
 * ★ CONTRACT — F3: ADR-0016 (src/tool/git/) — 9 git tools split 7 read-only +
 *   2 mutating (commit/branch_switch). All return TYPED graceful results on
 *   degenerate repos (empty / detached HEAD / dirty / no upstream / nothing
 *   staged); never crashes (`execute()` has no try/catch — an escaped throw is
 *   a real bug, not a slow test). Uses real `defaultGitRunner` against real
 *   tempdir + `git init`.
 *
 * F3 — git tools on DEGENERATE repos (HELLGATE).
 *
 * Unlike `git-tools.test.ts` (which injects a FakeRunner to assert argv +
 * parsing in isolation), this battery wires the REAL `defaultGitRunner` to
 * REAL throwaway repos in `os.tmpdir()` and pushes them into states that
 * routinely crash naive git wrappers:
 *   - a freshly `git init`-ed repo with ZERO commits (no HEAD)
 *   - detached HEAD
 *   - a tree dirty with untracked + staged + modified all at once
 *   - blame on a brand-new uncommitted file
 *   - branch names containing slashes / special chars (safeBranch contract)
 *
 * The invariant under test for every degenerate case: the tool yields a
 * TYPED `ToolResult` (ok:true|false) and NEVER lets an unhandled throw escape
 * `execute()`. We assert behavior, not just absence-of-crash.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  defaultGitRunner,
  gitBlameHeatmapTool,
  gitBlameTool,
  gitBranchSwitchTool,
  gitChurnTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  gitUpstreamCheckTool,
} from "@/tool/git"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* real-temp-repo harness                                             */
/* ------------------------------------------------------------------ */

const git = async (cwd: string, args: string[]): Promise<void> => {
  const r = await defaultGitRunner.run(args, cwd)
  if (r.exitCode !== 0) {
    throw new Error(`setup git ${args.join(" ")} failed: ${r.stderr}`)
  }
}

/** Make a fresh temp dir + `git init`, with deterministic identity + a fixed
 *  default branch so detached-HEAD / branch-switch assertions are stable. */
const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-git-hellgate-"))
  await git(dir, ["init", "-b", "main"])
  await git(dir, ["config", "user.email", "hellgate@example.com"])
  await git(dir, ["config", "user.name", "Hellgate"])
  await git(dir, ["config", "commit.gpgsign", "false"])
  return dir
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

/** Drive a tool to completion against a real repo. Crucially, we do NOT
 *  wrap in try/catch: if `execute()` throws, the test FAILS (that is the
 *  crash we are hunting). */
const run = async (tool: ExecutableTool, input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("tool produced no result event")
  return result
}

const created: string[] = []
const freshRepo = async (): Promise<string> => {
  const d = await makeRepo()
  created.push(d)
  return d
}

afterAll(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

/* ------------------------------------------------------------------ */
/* 1. EMPTY repo — git init, zero commits, no HEAD                     */
/* ------------------------------------------------------------------ */

describe("F3 empty repo (zero commits, no HEAD)", () => {
  let dir = ""
  beforeAll(async () => {
    dir = await freshRepo()
  })

  test("git_status on empty repo → ok:true, clean / no crash", async () => {
    const r = await run(gitStatusTool(defaultGitRunner), {}, dir)
    expect(r.ok).toBe(true)
    // An empty repo on `main` (unborn branch) is reported as clean.
    expect(r.output).toMatch(/clean|main/i)
  })

  test("git_log on empty repo → ok-typed, no commits sentinel (no throw)", async () => {
    const r = await run(gitLogTool(defaultGitRunner), {}, dir)
    // `git log` exits non-zero on an unborn branch; the tool must surface a
    // typed result either way — never an unhandled throw.
    expect(typeof r.ok).toBe("boolean")
    if (r.ok) {
      expect(r.output).toMatch(/no commits/i)
    } else {
      // graceful typed failure carrying git's own diagnostic
      expect(r.output.length).toBeGreaterThan(0)
    }
  })

  test("git_diff on empty repo → ok:true, empty diff", async () => {
    const r = await run(gitDiffTool(defaultGitRunner), {}, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/no diff/i)
  })

  test("git_blame on a brand-new uncommitted file (no history) → typed, no crash", async () => {
    writeFileSync(join(dir, "fresh.ts"), "const x = 1\n")
    const r = await run(gitBlameTool(defaultGitRunner), { file: "fresh.ts", line: 1 }, dir)
    // Uncommitted file: git blame either errors (no such path in HEAD) or
    // blames the working copy with a zero-sha; both must be typed.
    expect(typeof r.ok).toBe("boolean")
    expect(r.output.length).toBeGreaterThan(0)
  })

  test("git_churn on empty repo → typed result, no crash", async () => {
    const r = await run(gitChurnTool(defaultGitRunner), {}, dir)
    expect(typeof r.ok).toBe("boolean")
    if (r.ok) expect(r.output).toMatch(/no churn/i)
  })

  test("git_blame_heatmap on empty repo (uncommitted file) → typed, no crash", async () => {
    writeFileSync(join(dir, "heat.ts"), "a\nb\nc\n")
    const r = await run(gitBlameHeatmapTool(defaultGitRunner), { file: "heat.ts" }, dir)
    expect(typeof r.ok).toBe("boolean")
    expect(r.output.length).toBeGreaterThan(0)
  })

  test("git_upstream_check with no upstream configured → typed 'no upstream', not a throw", async () => {
    const r = await run(gitUpstreamCheckTool(defaultGitRunner), {}, dir)
    // No remote, no upstream tracking branch: the tool returns ok:true with a
    // sentinel rather than throwing on the failed @{upstream} resolution.
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/no upstream/i)
  })

  test("git_commit with NOTHING staged → typed failure, not crash", async () => {
    // Use a pristine isolated repo: the shared `dir` above has had uncommitted
    // files written into it (fresh.ts/heat.ts), and git_commit's default
    // staging is `git add -- .`, which would stage them. To exercise the
    // genuine "nothing to commit" path we need a repo with an EMPTY working
    // tree (one prior commit, no pending changes).
    const clean = await freshRepo()
    writeFileSync(join(clean, "seed.ts"), "1\n")
    await git(clean, ["add", "."])
    await git(clean, ["commit", "-m", "seed"])
    // Now the tree is clean: `git add -- .` stages nothing, `git commit` fails
    // with exit 1. NOTE: git prints "nothing to commit" to STDOUT, but the
    // tool's `stderrReason` only inspects stderr, so the surfaced diagnostic is
    // the exit-code fallback ("git commit exited 1"). The contract we assert is
    // the important one: a TYPED ok:false with a non-empty reason, never a crash.
    const r = await run(gitCommitTool(defaultGitRunner), { message: "noop" }, clean)
    expect(r.ok).toBe(false)
    expect(r.output.length).toBeGreaterThan(0)
    expect(r.output).toMatch(/nothing to commit|no changes added|working tree clean|exited 1/i)
  })
})

/* ------------------------------------------------------------------ */
/* 2. DIRTY tree — untracked + staged + modified simultaneously        */
/* ------------------------------------------------------------------ */

describe("F3 dirty tree (untracked + staged + modified)", () => {
  test("git_status reports all three categories at once", async () => {
    const dir = await freshRepo()
    // Seed an initial commit so we have a tracked file to modify.
    writeFileSync(join(dir, "tracked.ts"), "v1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "init"])

    // (a) MODIFIED: change the tracked file in the working tree (not staged).
    writeFileSync(join(dir, "tracked.ts"), "v2-modified\n")
    // (b) STAGED: a new file that is added to the index.
    writeFileSync(join(dir, "staged.ts"), "new staged\n")
    await git(dir, ["add", "staged.ts"])
    // (c) UNTRACKED: a file git has never seen.
    writeFileSync(join(dir, "untracked.ts"), "never seen\n")

    const r = await run(gitStatusTool(defaultGitRunner), {}, dir)
    expect(r.ok).toBe(true)
    // All three filenames surface.
    expect(r.output).toContain("tracked.ts")
    expect(r.output).toContain("staged.ts")
    expect(r.output).toContain("untracked.ts")
    // And the three category labels.
    expect(r.output).toMatch(/modified/i)
    expect(r.output).toMatch(/staged/i)
    expect(r.output).toMatch(/untracked/i)
    expect(r.output).not.toMatch(/working tree clean/i)
  })

  test("git_churn / git_blame_heatmap rank hotspots on a multi-commit repo", async () => {
    const dir = await freshRepo()
    // hot.ts changes 3×, cold.ts changes 1× → hot.ts must out-rank cold.ts.
    writeFileSync(join(dir, "hot.ts"), "1\n")
    writeFileSync(join(dir, "cold.ts"), "x\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])
    writeFileSync(join(dir, "hot.ts"), "1\n2\n")
    await git(dir, ["commit", "-am", "c2"])
    writeFileSync(join(dir, "hot.ts"), "1\n2\n3\n")
    await git(dir, ["commit", "-am", "c3"])

    const churn = await run(gitChurnTool(defaultGitRunner), {}, dir)
    expect(churn.ok).toBe(true)
    const hotIdx = churn.output.indexOf("hot.ts")
    const coldIdx = churn.output.indexOf("cold.ts")
    expect(hotIdx).toBeGreaterThanOrEqual(0)
    // hot.ts ranked above cold.ts (appears earlier in the ranked output).
    if (coldIdx >= 0) expect(hotIdx).toBeLessThan(coldIdx)

    const heat = await run(gitBlameHeatmapTool(defaultGitRunner), { file: "hot.ts" }, dir)
    expect(heat.ok).toBe(true)
    expect(heat.output).toContain("Hellgate") // the only author owns 100%
    expect(heat.output).toMatch(/100%/)
  })
})

/* ------------------------------------------------------------------ */
/* 3. DETACHED HEAD                                                    */
/* ------------------------------------------------------------------ */

describe("F3 detached HEAD", () => {
  test("git_status behaves sanely in detached HEAD (no crash)", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])
    // Detach onto the commit sha.
    const head = await defaultGitRunner.run(["rev-parse", "HEAD"], dir)
    const sha = head.stdout.trim()
    await git(dir, ["checkout", "--detach", sha])

    const r = await run(gitStatusTool(defaultGitRunner), {}, dir)
    expect(r.ok).toBe(true)
    expect(r.output.length).toBeGreaterThan(0)
    // Detached HEAD has no branch.head name; the tool must not blow up trying
    // to render a branch line.
  })

  test("git_branch_switch out of detached HEAD onto a real branch works", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])
    const head = await defaultGitRunner.run(["rev-parse", "HEAD"], dir)
    await git(dir, ["checkout", "--detach", head.stdout.trim()])

    const r = await run(gitBranchSwitchTool(defaultGitRunner), { branch: "main" }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("switched to main")
  })
})

/* ------------------------------------------------------------------ */
/* 4. git_branch_switch — safeBranch + special-char names              */
/* ------------------------------------------------------------------ */

describe("F3 git_branch_switch safeBranch contract", () => {
  test("a branch name with slashes (feature/foo) is accepted + created", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])

    const r = await run(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "feature/foo", create: true },
      dir,
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("feature/foo")
    // Confirm git actually moved there.
    const cur = await defaultGitRunner.run(["rev-parse", "--abbrev-ref", "HEAD"], dir)
    expect(cur.stdout.trim()).toBe("feature/foo")
  })

  test("option-injection / shell-metachar names are rejected at the SCHEMA, runner never spawned", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])

    // A spy runner that fails loudly if the dangerous argv reaches git.
    let spawned = false
    const spyRunner = {
      async run(args: readonly string[], cwd: string) {
        spawned = true
        return defaultGitRunner.run(args, cwd)
      },
    }
    // These violate BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._/+-]{1,64}$/:
    // leading '-' (option confusion), spaces, ';', newline-embedded → all must
    // be rejected BEFORE the spawn boundary so git never even sees them.
    for (const branch of ["--track=evil", "-D", "a;rm -rf /", "a b", "branch\n-x", "a~b", "a:b"]) {
      spawned = false
      const r = await run(gitBranchSwitchTool(spyRunner), { branch }, dir)
      expect(r.ok).toBe(false)
      expect(r.output).toMatch(/invalid input|branch must match/i)
      // The malicious name never reached the spawn boundary.
      expect(spawned).toBe(false)
    }
  })

  test("schema-legal but git-illegal names (`..`) → typed ok:false from git, not a crash", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])

    // `..` and `a..b` are within the schema alphabet ([A-Za-z0-9._/+-]) so they
    // pass validation and DO reach git — which rejects them as invalid refs.
    // The contract here is "no crash, typed failure carrying git's diagnostic",
    // not "schema-blocked".
    for (const branch of ["..", "a..b"]) {
      const r = await run(gitBranchSwitchTool(defaultGitRunner), { branch, create: true }, dir)
      expect(r.ok).toBe(false)
      expect(r.output.length).toBeGreaterThan(0)
      // Still on main — the bad switch never took effect.
      const cur = await defaultGitRunner.run(["rev-parse", "--abbrev-ref", "HEAD"], dir)
      expect(cur.stdout.trim()).toBe("main")
    }
  })

  test("dirty tree without autoWip → typed rejection with stash hint (no switch, no crash)", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])
    writeFileSync(join(dir, "a.ts"), "dirty\n") // dirty working tree

    const r = await run(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "other", create: true },
      dir,
    )
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/dirty|stash/i)
    // We are still on main — the switch did not happen.
    const cur = await defaultGitRunner.run(["rev-parse", "--abbrev-ref", "HEAD"], dir)
    expect(cur.stdout.trim()).toBe("main")
  })

  test("dirty tree WITH autoWip → wip checkpoint then switch (real repo)", async () => {
    const dir = await freshRepo()
    writeFileSync(join(dir, "a.ts"), "1\n")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-m", "c1"])
    writeFileSync(join(dir, "a.ts"), "dirty\n")

    const r = await run(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "wip-target", create: true, autoWip: true },
      dir,
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("wip-target")
    expect(r.output).toMatch(/wip checkpoint/i)
    // The wip commit is real and recoverable.
    const log = await defaultGitRunner.run(["log", "--oneline", "-n", "1"], dir)
    expect(log.stdout).toMatch(/wip:/)
  })
})
