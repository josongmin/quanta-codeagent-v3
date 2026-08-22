/** Unit tests for the §7.4 3-WAY dirty-checkout extension to
 *  `git_branch_switch`. The tool historically had only two dirty-tree paths:
 *  `autoWip:true` (commit a wip checkpoint) OR reject. This adds an explicit
 *  `dirtyAction: "commit-wip" | "stash" | "discard"` input so the model can
 *  choose how to clear a dirty tree before the switch.
 *
 *  Asserts:
 *    - DEFAULT-OFF byte-identity: when `dirtyAction` is ABSENT, the argv
 *      sequence is exactly the legacy `autoWip`-driven behavior.
 *    - dirtyAction:"commit-wip" ⇒ add + commit (wip) then switch.
 *    - dirtyAction:"stash" ⇒ `git stash push -u -m <label>` then switch.
 *    - dirtyAction:"discard" ⇒ discard tracked + untracked then switch.
 *    - schema rejects unknown dirtyAction values.
 *    - failures in the chosen flow abort BEFORE the switch (no half-state).
 *    - clean tree ignores dirtyAction (no stash/discard/commit runs).
 */

import { describe, expect, test } from "bun:test"
import { gitBranchSwitchTool } from "@/tool/git/branch-switch"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
})

class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; cwd: string }[] = []
  constructor(private readonly resolver: (args: readonly string[], i: number) => GitRunResult) {}
  async run(args: readonly string[], cwd: string): Promise<GitRunResult> {
    const i = this.calls.length
    this.calls.push({ args: [...args], cwd })
    return this.resolver(args, i)
  }
}

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (tool: ExecutableTool, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const ok = (stdout = ""): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const err = (stderr: string, exitCode = 128): GitRunResult => ({ stdout: "", stderr, exitCode })

interface ResolverOpts {
  dirty?: boolean
  failHead?: string // first arg of the subcommand that should fail
}

const resolver =
  (opts: ResolverOpts) =>
  (args: readonly string[]): GitRunResult => {
    const head = args[0]
    if (head === "status") return ok(opts.dirty ? " M src/foo.ts\n?? new.txt\n" : "")
    if (opts.failHead !== undefined && head === opts.failHead) {
      return err(`fatal: ${opts.failHead} failed`, 1)
    }
    return ok()
  }

const heads = (r: FakeRunner): (string | undefined)[] => r.calls.map((c) => c.args[0])

describe("git_branch_switch — dirtyAction byte-identity (default-OFF)", () => {
  test("dirtyAction ABSENT + autoWip:true ⇒ identical argv to legacy commit-wip", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", autoWip: true })
    expect(r.ok).toBe(true)
    // Legacy sequence is exactly: status → add -- . → commit -m wip → switch.
    expect(heads(runner)).toEqual(["status", "add", "commit", "switch"])
    expect(runner.calls[1]?.args).toEqual(["add", "--", "."])
    expect(runner.calls[2]?.args[0]).toBe("commit")
    expect(runner.calls[3]?.args).toEqual(["switch", "--", "feat"])
  })

  test("dirtyAction ABSENT + autoWip omitted on dirty ⇒ reject (legacy)", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/dirty|stash|autoWip/i)
    expect(heads(runner)).toEqual(["status"]) // no mutation
  })

  test("dirtyAction ABSENT + clean tree ⇒ plain switch (legacy)", async () => {
    const runner = new FakeRunner(resolver({ dirty: false }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat" })
    expect(r.ok).toBe(true)
    expect(heads(runner)).toEqual(["status", "switch"])
  })
})

describe("git_branch_switch — dirtyAction HITL tier (destructive escalation)", () => {
  test("discard escalates to always-confirm (irreversible work loss)", () => {
    const t = gitBranchSwitchTool(new FakeRunner(resolver({})))
    expect(t.hitlTier?.({ branch: "feat", dirtyAction: "discard" })).toBe("always-confirm")
  })

  test("stash + commit-wip stay pre-approval-ok (recoverable)", () => {
    const t = gitBranchSwitchTool(new FakeRunner(resolver({})))
    expect(t.hitlTier?.({ branch: "feat", dirtyAction: "stash" })).toBe("pre-approval-ok")
    expect(t.hitlTier?.({ branch: "feat", dirtyAction: "commit-wip" })).toBe("pre-approval-ok")
  })

  test("no dirtyAction stays pre-approval-ok (legacy byte-identity)", () => {
    const t = gitBranchSwitchTool(new FakeRunner(resolver({})))
    expect(t.hitlTier?.({ branch: "feat" })).toBe("pre-approval-ok")
    expect(t.hitlTier?.({ branch: "feat", autoWip: true })).toBe("pre-approval-ok")
  })
})

describe("git_branch_switch — dirtyAction schema", () => {
  test("accepts the three actions", () => {
    const t = gitBranchSwitchTool(new FakeRunner(resolver({})))
    for (const a of ["commit-wip", "stash", "discard"]) {
      expect(t.inputSchema.safeParse({ branch: "feat", dirtyAction: a }).success).toBe(true)
    }
  })

  test("rejects unknown dirtyAction", () => {
    const t = gitBranchSwitchTool(new FakeRunner(resolver({})))
    expect(t.inputSchema.safeParse({ branch: "feat", dirtyAction: "nuke" }).success).toBe(false)
    expect(t.inputSchema.safeParse({ branch: "feat", dirtyAction: "" }).success).toBe(false)
  })
})

describe("git_branch_switch — dirtyAction:commit-wip", () => {
  test("dirty ⇒ add + commit (wip) then switch", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), {
      branch: "feat",
      dirtyAction: "commit-wip",
    })
    expect(r.ok).toBe(true)
    expect(heads(runner)).toEqual(["status", "add", "commit", "switch"])
    expect(runner.calls[2]?.args[2]).toMatch(/^wip: /)
  })

  test("dirtyAction:commit-wip does NOT require autoWip", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), {
      branch: "feat",
      dirtyAction: "commit-wip",
      autoWip: false,
    })
    // dirtyAction takes precedence over the legacy autoWip:false reject.
    expect(r.ok).toBe(true)
    expect(heads(runner)).toContain("commit")
  })
})

describe("git_branch_switch — dirtyAction:stash", () => {
  test("dirty ⇒ `git stash push -u -m <label>` then switch", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "stash" })
    expect(r.ok).toBe(true)
    expect(heads(runner)).toEqual(["status", "stash", "switch"])
    const stashArgs = runner.calls[1]?.args ?? []
    expect(stashArgs[0]).toBe("stash")
    expect(stashArgs[1]).toBe("push")
    expect(stashArgs).toContain("-u") // include untracked
    expect(stashArgs).toContain("-m")
    // The stash label should be a deterministic, identifiable prefix.
    const msgIdx = stashArgs.indexOf("-m")
    expect(stashArgs[msgIdx + 1]).toMatch(/branch-switch/)
  })

  test("stash failure aborts BEFORE switch (no half-state)", async () => {
    const runner = new FakeRunner(resolver({ dirty: true, failHead: "stash" }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "stash" })
    expect(r.ok).toBe(false)
    expect(heads(runner)).not.toContain("switch")
  })

  test("result note mentions stash so user can recover", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "stash" })
    expect(r.output).toMatch(/stash/i)
  })
})

describe("git_branch_switch — dirtyAction:discard", () => {
  test("dirty ⇒ discard tracked + untracked then switch", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "discard" })
    expect(r.ok).toBe(true)
    // Must clear tracked edits AND untracked files before switch.
    const hs = heads(runner)
    expect(hs[0]).toBe("status")
    expect(hs[hs.length - 1]).toBe("switch")
    // checkout/restore (tracked) + clean (untracked) must both run.
    expect(hs).toContain("clean")
    expect(hs.some((h) => h === "checkout" || h === "restore" || h === "reset")).toBe(true)
  })

  test("discard uses `git clean -fd` (untracked dirs too)", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "discard" })
    const cleanCall = runner.calls.find((c) => c.args[0] === "clean")
    expect(cleanCall?.args).toContain("-fd")
  })

  test("discard failure aborts BEFORE switch (no half-state)", async () => {
    const runner = new FakeRunner(resolver({ dirty: true, failHead: "clean" }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "discard" })
    expect(r.ok).toBe(false)
    expect(heads(runner)).not.toContain("switch")
  })

  test("result note warns that changes were discarded (destructive)", async () => {
    const runner = new FakeRunner(resolver({ dirty: true }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: "discard" })
    expect(r.output).toMatch(/discard/i)
  })
})

describe("git_branch_switch — dirtyAction on a clean tree is a no-op pre-switch", () => {
  test.each([
    "commit-wip",
    "stash",
    "discard",
  ])("clean tree + dirtyAction:%s ⇒ only status + switch", async (action) => {
    const runner = new FakeRunner(resolver({ dirty: false }))
    const r = await collect(gitBranchSwitchTool(runner), { branch: "feat", dirtyAction: action })
    expect(r.ok).toBe(true)
    expect(heads(runner)).toEqual(["status", "switch"])
  })
})
