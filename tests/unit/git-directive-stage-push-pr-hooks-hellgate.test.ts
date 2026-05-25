/**
 * Git-directive hook hellgate — stage / push / create-pr (ADR-0240).
 *
 * Closes the ADR-0221 5-directive emit-protocol wire. The W3-3 round wired
 * the `commit` / `create-branch` hooks; this round wires the remaining
 * three — `stage` (via `git_stage`), `push` (via `git_push`), and
 * `create-pr` (via `gh_pr_create`).
 *
 * Closed-port tests — runners injected, NO subprocess. Verifies:
 *
 *   HELL-GDH-01  git_stage success ⇒ ONE stage directive on each wired
 *                surface (ADR-0220 emitter + ADR-0234 collector); shapes
 *                differ by field name (`paths` vs `files`) but agree on
 *                content.
 *   HELL-GDH-02  git_stage FAILURE ⇒ ZERO directives (success-only invariant).
 *   HELL-GDH-03  git_stage with NO wired surfaces ⇒ byte-identical legacy
 *                (no emit, no record); tool still succeeds.
 *   HELL-GDH-04  git_push success (default args) ⇒ push directive on both
 *                surfaces; force=false; ref defaults to remote-only.
 *   HELL-GDH-05  git_push --force ⇒ both surfaces record force=true; argv
 *                contains `--force-with-lease` (safe variant, never plain
 *                `--force`).
 *   HELL-GDH-06  git_push FAILURE ⇒ ZERO directives.
 *   HELL-GDH-07  gh_pr_create success ⇒ create-pr directive with URL
 *                extracted from stdout, isDraft=false.
 *   HELL-GDH-08  gh_pr_create --draft ⇒ argv contains `--draft`; directive
 *                isDraft=true.
 *   HELL-GDH-09  gh_pr_create FAILURE (non-zero exit) ⇒ ZERO directives;
 *                tool result is ok:false.
 *   HELL-GDH-10  emitter THROWING ⇒ tool result still ok:true (publish
 *                failure NEVER poisons the mutation outcome) for all three
 *                tools.
 *   HELL-GDH-11  collector THROWING ⇒ same swallow discipline; tool result
 *                still ok:true.
 *   HELL-GDH-12  full 5-directive flow integration — stage + push + create-pr
 *                fired in sequence ⇒ collector records exactly 3 directives
 *                in order, each with the right kind.
 *   HELL-GDH-13  emitter wired only (no collector) ⇒ ONLY emitter sees the
 *                directive (no collector record). Mirror invariant for
 *                collector-only wire.
 */

import { describe, expect, test } from "bun:test"
import type { GitDirective as Directive0220, GitDirectiveEmitter } from "@/agent/git-directives"
import type { GitDirective as Directive0234, GitDirectiveCollector } from "@/git/directive-emit"
import type { GhRunner } from "@/tool/gh"
import { ghPrCreateTool } from "@/tool/gh"
import type { GitRunner, GitRunResult } from "@/tool/git"
import { gitPushTool, gitStageTool } from "@/tool/git"
import type { ToolEvent, ToolResult } from "@/tool/types"

// ─── Tiny rig helpers ───────────────────────────────────────────────────────

const ctx = (cwd = "/tmp") => ({ cwd, signal: new AbortController().signal })

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const events: ToolEvent[] = []
  for await (const ev of it) events.push(ev)
  return events
}

const resultOf = (events: ToolEvent[]): ToolResult | undefined => {
  const r = events.find((e) => e.type === "result")
  if (r && r.type === "result") return r.result
  return undefined
}

// ─── Fake git runner ────────────────────────────────────────────────────────

const makeGitRunner = (
  reply: (args: readonly string[]) => GitRunResult,
): GitRunner & { calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args])
      return reply(args)
    },
  }
}

const okGit = (stdout = ""): GitRunResult => ({ exitCode: 0, stdout, stderr: "" })
const failGit = (stderr = "fatal"): GitRunResult => ({ exitCode: 1, stdout: "", stderr })

// ─── Fake gh runner ─────────────────────────────────────────────────────────

const makeGhRunner = (
  reply: (argv: string[]) => { code: number; stdout: string; stderr: string },
): GhRunner & { calls: string[][] } => {
  const calls: string[][] = []
  const fn: GhRunner = async (argv) => {
    calls.push([...argv])
    return reply(argv)
  }
  return Object.assign(fn, { calls })
}

const okGh = (stdout: string) => ({ code: 0, stdout, stderr: "" })
const failGh = (stderr: string) => ({ code: 1, stdout: "", stderr })

// ─── Recording surfaces ─────────────────────────────────────────────────────

const recordingEmitter = (): {
  emitter: GitDirectiveEmitter
  events: Directive0220[]
} => {
  const events: Directive0220[] = []
  return {
    events,
    emitter: {
      emit: (d) => {
        events.push(d)
      },
    },
  }
}

const recordingCollector = (): {
  collector: GitDirectiveCollector
  records: Directive0234[]
} => {
  const records: Directive0234[] = []
  const collector: GitDirectiveCollector = {
    record: (d) => {
      records.push(d)
    },
    flush: () => [],
    get length() {
      return records.length
    },
  }
  return { records, collector }
}

const throwingEmitter = (msg: string): GitDirectiveEmitter => ({
  emit: () => {
    throw new Error(msg)
  },
})

const throwingCollector = (msg: string): GitDirectiveCollector => ({
  record: () => {
    throw new Error(msg)
  },
  flush: () => [],
  get length() {
    return 0
  },
})

// ─── Cases ──────────────────────────────────────────────────────────────────

describe("git-directive stage/push/create-pr hooks hellgate (ADR-0240)", () => {
  test("HELL-GDH-01: git_stage success ⇒ stage directive on both surfaces (paths vs files)", async () => {
    const runner = makeGitRunner(() => okGit(""))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = gitStageTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(await drain(tool.execute({ paths: ["src/a.ts", "src/b.ts"] }, ctx())))
    expect(result?.ok).toBe(true)
    expect(em.events).toHaveLength(1)
    expect(em.events[0]).toEqual({ kind: "stage", paths: ["src/a.ts", "src/b.ts"] })
    expect(co.records).toHaveLength(1)
    expect(co.records[0]).toEqual({ kind: "stage", files: ["src/a.ts", "src/b.ts"] })
    expect(runner.calls[0]).toEqual(["add", "--", "src/a.ts", "src/b.ts"])
  })

  test("HELL-GDH-02: git_stage FAILURE ⇒ ZERO directives (success-only)", async () => {
    const runner = makeGitRunner(() => failGit("permission denied"))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = gitStageTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(await drain(tool.execute({ paths: ["x.ts"] }, ctx())))
    expect(result?.ok).toBe(false)
    expect(em.events).toHaveLength(0)
    expect(co.records).toHaveLength(0)
  })

  test("HELL-GDH-03: git_stage with NO surfaces ⇒ byte-identical legacy (tool succeeds)", async () => {
    const runner = makeGitRunner(() => okGit(""))
    const tool = gitStageTool(runner) // no opts at all
    const result = resultOf(await drain(tool.execute({ paths: ["x.ts"] }, ctx())))
    expect(result?.ok).toBe(true)
    // runner saw exactly the single `git add` call.
    expect(runner.calls).toEqual([["add", "--", "x.ts"]])
  })

  test("HELL-GDH-04: git_push success defaults ⇒ push directive both surfaces, force=false", async () => {
    const runner = makeGitRunner(() => okGit(""))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = gitPushTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(await drain(tool.execute({}, ctx())))
    expect(result?.ok).toBe(true)
    expect(em.events).toHaveLength(1)
    expect(em.events[0]).toEqual({ kind: "push", remote: "origin", branch: "" })
    expect(co.records).toHaveLength(1)
    expect(co.records[0]).toEqual({ kind: "push", ref: "origin", force: false })
    // Argv: no force flag, no remote, no branch.
    expect(runner.calls[0]).toEqual(["push"])
  })

  test("HELL-GDH-05: git_push --force ⇒ both surfaces force=true; argv has --force-with-lease", async () => {
    const runner = makeGitRunner(() => okGit(""))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = gitPushTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(
      await drain(tool.execute({ remote: "origin", branch: "feature-x", force: true }, ctx())),
    )
    expect(result?.ok).toBe(true)
    expect(em.events[0]).toEqual({ kind: "push", remote: "origin", branch: "feature-x" })
    expect(co.records[0]).toEqual({ kind: "push", ref: "origin/feature-x", force: true })
    expect(runner.calls[0]).toEqual(["push", "--force-with-lease", "origin", "feature-x"])
    // Critical security invariant — never plain --force.
    expect(runner.calls[0]).not.toContain("--force")
  })

  test("HELL-GDH-06: git_push FAILURE ⇒ ZERO directives", async () => {
    const runner = makeGitRunner(() => failGit("rejected"))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = gitPushTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(await drain(tool.execute({ branch: "feat" }, ctx())))
    expect(result?.ok).toBe(false)
    expect(em.events).toHaveLength(0)
    expect(co.records).toHaveLength(0)
  })

  test("HELL-GDH-07: gh_pr_create success ⇒ create-pr directive with URL, isDraft=false", async () => {
    const url = "https://github.com/o/r/pull/42"
    const runner = makeGhRunner(() => okGh(`${url}\n`))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = ghPrCreateTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(
      await drain(tool.execute({ title: "T", body: "B", base: "main", head: "feat" }, ctx())),
    )
    expect(result?.ok).toBe(true)
    expect(em.events).toHaveLength(1)
    expect(em.events[0]).toEqual({ kind: "create-pr", url, isDraft: false })
    expect(co.records).toHaveLength(1)
    expect(co.records[0]).toEqual({ kind: "create-pr", url, isDraft: false })
    expect(runner.calls[0]).not.toContain("--draft")
  })

  test("HELL-GDH-08: gh_pr_create --draft ⇒ argv has --draft; isDraft=true", async () => {
    const url = "https://github.com/o/r/pull/9"
    const runner = makeGhRunner(() => okGh(`${url}\n`))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = ghPrCreateTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(
      await drain(
        tool.execute({ title: "T", body: "B", base: "main", head: "feat", draft: true }, ctx()),
      ),
    )
    expect(result?.ok).toBe(true)
    expect(em.events[0]).toEqual({ kind: "create-pr", url, isDraft: true })
    expect(co.records[0]).toEqual({ kind: "create-pr", url, isDraft: true })
    expect(runner.calls[0]).toContain("--draft")
  })

  test("HELL-GDH-09: gh_pr_create FAILURE ⇒ ZERO directives; result ok:false", async () => {
    const runner = makeGhRunner(() => failGh("not authorized"))
    const em = recordingEmitter()
    const co = recordingCollector()
    const tool = ghPrCreateTool(runner, {
      gitDirectiveEmitter: em.emitter,
      gitDirectiveCollector: co.collector,
    })
    const result = resultOf(
      await drain(tool.execute({ title: "T", body: "B", base: "main", head: "feat" }, ctx())),
    )
    expect(result?.ok).toBe(false)
    expect(em.events).toHaveLength(0)
    expect(co.records).toHaveLength(0)
  })

  test("HELL-GDH-10: emitter THROWING ⇒ tool result still ok:true (publish swallow)", async () => {
    // stage
    const stageRunner = makeGitRunner(() => okGit(""))
    const stageTool = gitStageTool(stageRunner, {
      gitDirectiveEmitter: throwingEmitter("emitter-fault"),
    })
    const stageRes = resultOf(await drain(stageTool.execute({ paths: ["x.ts"] }, ctx())))
    expect(stageRes?.ok).toBe(true)

    // push
    const pushRunner = makeGitRunner(() => okGit(""))
    const pushTool = gitPushTool(pushRunner, {
      gitDirectiveEmitter: throwingEmitter("emitter-fault"),
    })
    const pushRes = resultOf(await drain(pushTool.execute({}, ctx())))
    expect(pushRes?.ok).toBe(true)

    // pr-create
    const url = "https://github.com/o/r/pull/1"
    const ghRunner = makeGhRunner(() => okGh(`${url}\n`))
    const prTool = ghPrCreateTool(ghRunner, {
      gitDirectiveEmitter: throwingEmitter("emitter-fault"),
    })
    const prRes = resultOf(
      await drain(prTool.execute({ title: "T", body: "B", base: "main", head: "f" }, ctx())),
    )
    expect(prRes?.ok).toBe(true)
  })

  test("HELL-GDH-11: collector THROWING ⇒ tool result still ok:true (publish swallow)", async () => {
    // stage
    const stageRunner = makeGitRunner(() => okGit(""))
    const stageTool = gitStageTool(stageRunner, {
      gitDirectiveCollector: throwingCollector("collector-fault"),
    })
    const stageRes = resultOf(await drain(stageTool.execute({ paths: ["x.ts"] }, ctx())))
    expect(stageRes?.ok).toBe(true)

    // push
    const pushRunner = makeGitRunner(() => okGit(""))
    const pushTool = gitPushTool(pushRunner, {
      gitDirectiveCollector: throwingCollector("collector-fault"),
    })
    const pushRes = resultOf(await drain(pushTool.execute({}, ctx())))
    expect(pushRes?.ok).toBe(true)

    // pr-create
    const url = "https://github.com/o/r/pull/2"
    const ghRunner = makeGhRunner(() => okGh(`${url}\n`))
    const prTool = ghPrCreateTool(ghRunner, {
      gitDirectiveCollector: throwingCollector("collector-fault"),
    })
    const prRes = resultOf(
      await drain(prTool.execute({ title: "T", body: "B", base: "main", head: "f" }, ctx())),
    )
    expect(prRes?.ok).toBe(true)
  })

  test("HELL-GDH-12: 3-tool flow ⇒ collector records [stage, push, create-pr] in order", async () => {
    const co = recordingCollector()
    const stageRunner = makeGitRunner(() => okGit(""))
    const pushRunner = makeGitRunner(() => okGit(""))
    const url = "https://github.com/o/r/pull/3"
    const ghRunner = makeGhRunner(() => okGh(`${url}\n`))
    const stage = gitStageTool(stageRunner, { gitDirectiveCollector: co.collector })
    const push = gitPushTool(pushRunner, { gitDirectiveCollector: co.collector })
    const pr = ghPrCreateTool(ghRunner, { gitDirectiveCollector: co.collector })

    await drain(stage.execute({ paths: ["a.ts"] }, ctx()))
    await drain(push.execute({ branch: "feat" }, ctx()))
    await drain(pr.execute({ title: "T", body: "B", base: "main", head: "feat" }, ctx()))

    expect(co.records.map((d) => d.kind)).toEqual(["stage", "push", "create-pr"])
  })

  test("HELL-GDH-13: emitter-only wire ⇒ NO collector record; collector-only ⇒ NO emit", async () => {
    // Emitter-only
    const emOnlyRunner = makeGitRunner(() => okGit(""))
    const em = recordingEmitter()
    const stageEmOnly = gitStageTool(emOnlyRunner, { gitDirectiveEmitter: em.emitter })
    await drain(stageEmOnly.execute({ paths: ["a.ts"] }, ctx()))
    expect(em.events).toHaveLength(1)

    // Collector-only
    const coOnlyRunner = makeGitRunner(() => okGit(""))
    const co = recordingCollector()
    const stageCoOnly = gitStageTool(coOnlyRunner, { gitDirectiveCollector: co.collector })
    await drain(stageCoOnly.execute({ paths: ["b.ts"] }, ctx()))
    expect(co.records).toHaveLength(1)

    // The emitter from the second test was never touched (different rig).
    // Asserting cross-isolation by counting events on each instance.
    expect(em.events).toHaveLength(1)
  })
})
