/**
 * H6 (jun-3-misc §3) — Passive-VCS bash post-exec WIRING e2e hellgate.
 *
 * Drives the REAL `bash` tool running git/gh-style commands in a throwaway
 * git repo and asserts the classified structured VCS event reaches the wired
 * `vcsEventSink` (the seam a host adapts onto the turn-diff `AgentEvent` bus)
 * when the `QUANTA_PASSIVE_VCS` knob is ON — and that the path is byte-identical
 * (zero events, unchanged `output`) when the knob is OFF or no sink is wired.
 *
 * Matrix:
 *  A. knob OFF                       → no event (byte-identical)
 *  B. knob ON, no sink wired         → no event (host opt-in still required)
 *  C. knob ON + sink, real merge     → branch.action "merged" reaches the sink
 *  D. knob ON + sink, real commit    → commit.kind "commit" + sha reaches the sink
 *  E. knob ON + sink, non-git cmd    → no event (classifier rejects)
 *  F. knob ON + sink, failed git     → no event (exitCode≠0 guard)
 *  G. the tool `output` is identical with the hook ON vs OFF (pure observability)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PassiveVcsEventSink, VcsEvent } from "@/git/passive-classify"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { ToolContext, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"

// ── helpers ──────────────────────────────────────────────────────────────────

const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
}

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "passive-vcs-e2e-"))
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "t@t"])
  git(dir, ["config", "user.name", "t"])
  writeFileSync(join(dir, "a.txt"), "1\n")
  git(dir, ["add", "."])
  git(dir, ["commit", "-q", "-m", "init"])
  return dir
}

interface RecordingSink extends PassiveVcsEventSink {
  readonly events: VcsEvent[]
}
const recordingSink = (): RecordingSink => {
  const events: VcsEvent[] = []
  return { events, emit: (e) => void events.push(e) }
}

/** Build a ToolContext, optionally carrying the duck-typed `vcsEventSink`. */
const ctxWith = (cwd: string, sink?: PassiveVcsEventSink): ToolContext =>
  ({
    cwd,
    signal: new AbortController().signal,
    ...(sink ? { vcsEventSink: sink } : {}),
  }) as ToolContext

const runBash = async (command: string, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute({ command } as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const tmpDirs: string[] = []
const repo = (): string => {
  const d = makeRepo()
  tmpDirs.push(d)
  return d
}

beforeEach(() => {
  __resetRuntimeConfig()
})

afterEach(() => {
  delete process.env.QUANTA_PASSIVE_VCS
  __resetRuntimeConfig()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/* ================================================================== */
/*  A/B. default-OFF posture                                          */
/* ================================================================== */

describe("A/B. default-OFF byte-identical", () => {
  test("HELL-E2E-A: knob OFF → sink receives NOTHING even for a real merge", async () => {
    const dir = repo()
    git(dir, ["checkout", "-q", "-b", "feature"])
    writeFileSync(join(dir, "b.txt"), "2\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-q", "-m", "feature change"])
    git(dir, ["checkout", "-q", "main"])

    const sink = recordingSink()
    delete process.env.QUANTA_PASSIVE_VCS // OFF
    __resetRuntimeConfig()
    await runBash("git merge --no-ff -m merge feature", ctxWith(dir, sink))
    expect(sink.events).toHaveLength(0)
  })

  test("HELL-E2E-B: knob ON but NO sink wired → no crash, host opt-in still required", async () => {
    const dir = repo()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    // No sink on ctx ⇒ the hook resolves nothing and skips classification.
    const r = await runBash("git status", ctxWith(dir))
    expect(r.ok).toBe(true)
  })
})

/* ================================================================== */
/*  C/D. knob ON → events reach the sink (turn-diff bus seam)         */
/* ================================================================== */

describe("C/D. knob ON → classified events reach the wired sink", () => {
  test("HELL-E2E-C: real non-fast-forward merge → branch.action 'merged' reaches sink", async () => {
    const dir = repo()
    git(dir, ["checkout", "-q", "-b", "feature"])
    writeFileSync(join(dir, "b.txt"), "2\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-q", "-m", "feature change"])
    git(dir, ["checkout", "-q", "main"])

    const sink = recordingSink()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    await runBash("git merge --no-ff -m 'merge feature' feature", ctxWith(dir, sink))

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.branch).toEqual({ action: "merged" })
    // Real `git merge --no-ff` prints `Merge made by ...` but NOT a
    // `[main sha]` bracket line by default ⇒ commit.kind "merge" with no sha.
    // (sha-bearing merge output is covered by the unit hellgate HELL-A2.)
    expect(sink.events[0]?.commit?.kind).toBe("merge")
  })

  test("HELL-E2E-D: real commit → commit.kind 'commit' + sha reaches sink", async () => {
    const dir = repo()
    writeFileSync(join(dir, "c.txt"), "3\n")
    git(dir, ["add", "."])

    const sink = recordingSink()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    await runBash("git commit -m 'add c'", ctxWith(dir, sink))

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.commit?.kind).toBe("commit")
    expect(sink.events[0]?.commit?.sha).toMatch(/^[0-9a-f]{7,40}$/)
  })

  test("HELL-E2E-D2: real --amend → commit.kind 'amend' + branch 'amended' reaches sink", async () => {
    const dir = repo()
    const sink = recordingSink()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    await runBash("git commit --amend -m 'reworded init'", ctxWith(dir, sink))

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.commit?.kind).toBe("amend")
    expect(sink.events[0]?.branch).toEqual({ action: "amended" })
  })
})

/* ================================================================== */
/*  E/F. negative paths under knob ON                                 */
/* ================================================================== */

describe("E/F. knob ON negative paths", () => {
  test("HELL-E2E-E: non-git command (echo of a git phrase) → no event", async () => {
    const dir = repo()
    const sink = recordingSink()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    await runBash('echo "Fast-forward main -> main"', ctxWith(dir, sink))
    expect(sink.events).toHaveLength(0)
  })

  test("HELL-E2E-F: FAILED git (exitCode≠0) → no event", async () => {
    const dir = repo()
    const sink = recordingSink()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    // Merge a nonexistent ref ⇒ git exits non-zero.
    const r = await runBash("git merge does-not-exist-branch", ctxWith(dir, sink))
    expect(r.ok).toBe(false)
    expect(sink.events).toHaveLength(0)
  })
})

/* ================================================================== */
/*  G. pure observability — output unchanged ON vs OFF                */
/* ================================================================== */

describe("G. hook is pure observability — output unchanged", () => {
  test("HELL-E2E-G: tool `output` is identical with the hook ON vs OFF", async () => {
    const dir = repo()
    writeFileSync(join(dir, "d.txt"), "4\n")
    git(dir, ["add", "."])

    // OFF run.
    delete process.env.QUANTA_PASSIVE_VCS
    __resetRuntimeConfig()
    const off = await runBash("git status --porcelain", ctxWith(dir))

    // ON run (same command, with a sink).
    const sink = recordingSink()
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    const on = await runBash("git status --porcelain", ctxWith(dir, sink))

    // `git status` matches no pattern ⇒ sink stays empty AND output is identical.
    expect(sink.events).toHaveLength(0)
    expect(on.output).toBe(off.output)
  })
})
