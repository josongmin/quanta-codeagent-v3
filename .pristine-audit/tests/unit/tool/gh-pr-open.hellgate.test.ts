/**
 * Hellgate battery for `gh_pr_open` (ADR-0460) — author + `gh pr create` in one
 * step. Adversarial cases pin every failure path BEFORE the PR is opened (so a
 * bad run never spends a `gh` call), the dry-run preview, branch resolution,
 * the push precondition, injection-safe argv, plus the two wiring seams
 * (`buildPrShipBlock` builder + `ghTools` opts) and byte-identical delegation
 * of `git_compose_pr` to the extracted `composePrText` core.
 */
import { describe, expect, test } from "bun:test"
import { buildPrShipBlock } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { GhRunResult } from "@/tool/gh"
import { ghPrOpenTool, ghTools } from "@/tool/gh"
import { gitComposePrTool } from "@/tool/git/compose"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// ── doubles ──────────────────────────────────────────────────────────────────

const gitOk = (stdout: string, exitCode = 0): GitRunResult => ({ stdout, stderr: "", exitCode })
const gitFail = (stderr: string, exitCode = 128): GitRunResult => ({ stdout: "", stderr, exitCode })

/** Scriptable git runner keyed on the leading argv. Records every call. */
const fakeGit = (
  overrides: {
    branch?: string // rev-parse --abbrev-ref HEAD
    diff?: GitRunResult
    log?: GitRunResult
    originHas?: boolean // rev-parse --verify origin/<head>
    revParseThrows?: boolean
  } = {},
): { runner: GitRunner; calls: string[][] } => {
  const calls: string[][] = []
  const revParse = (args: readonly string[]): GitRunResult => {
    if (overrides.revParseThrows) throw new Error("git boom")
    if (args.includes("--abbrev-ref")) return gitOk(`${overrides.branch ?? "feat/x"}\n`)
    if (args.includes("--verify")) {
      return overrides.originHas === false ? gitFail("", 1) : gitOk("deadbeef\n")
    }
    return gitOk("")
  }
  const runner: GitRunner = {
    async run(args) {
      calls.push([...args])
      if (args[0] === "rev-parse") return revParse(args)
      if (args[0] === "diff") return overrides.diff ?? gitOk("diff --git a/x b/x\n+y", 1)
      if (args[0] === "log") return overrides.log ?? gitOk("c1 wip")
      return gitOk("")
    },
  }
  return { runner, calls }
}

const gh = (r: Partial<GhRunResult>): ((...a: unknown[]) => Promise<GhRunResult>) => {
  return async () => ({ code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })
}
const recordingGh = (
  r: Partial<GhRunResult>,
): {
  runner: (argv: string[], cwd: string, t: number) => Promise<GhRunResult>
  argv: string[][]
} => {
  const argv: string[][] = []
  return {
    argv,
    runner: async (a) => {
      argv.push([...a])
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    },
  }
}

const streamText = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
class FakeAuthor implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly model = "fake-author"
  constructor(private readonly reply: StreamEvent[] | Error) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    if (this.reply instanceof Error) throw this.reply
    for (const e of this.reply) yield e
  }
}
const author = (text = "feat: do the thing\n\n## Summary\nbody"): FakeAuthor =>
  new FakeAuthor(streamText(text))

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })
const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolResult> => {
  let r: ToolResult | undefined
  for await (const e of it) if (e.type === "result") r = e.result
  if (!r) throw new Error("no result")
  return r
}

// ── gh_pr_open behaviour ──────────────────────────────────────────────────────

describe("gh_pr_open", () => {
  test("happy path: authors, opens PR, returns url", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 0, stdout: "https://github.com/o/r/pull/42\n" })
    const res = await drain(ghPrOpenTool(g.runner, git, author()).execute({ base: "main" }, ctx()))
    expect(res.ok).toBe(true)
    expect(res.output).toBe("https://github.com/o/r/pull/42")
    const create = g.argv[0]
    if (create === undefined) throw new Error("expected gh invocation")
    expect(create).toContain("create")
    expect(create).toContain("--base")
    expect(create[create.indexOf("--base") + 1]).toBe("main")
    expect(create[create.indexOf("--head") + 1]).toBe("feat/x")
  })

  test("dryRun: authors but NEVER calls gh", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 0, stdout: "should-not-happen" })
    const res = await drain(ghPrOpenTool(g.runner, git, author()).execute({ dryRun: true }, ctx()))
    expect(res.ok).toBe(true)
    expect(res.output).toContain("[dry-run]")
    expect(g.argv.length).toBe(0)
  })

  test("empty diff: ok:false, gh NOT called, author NOT called", async () => {
    const { runner: git } = fakeGit({ diff: gitOk(""), originHas: true })
    const a = author()
    const g = recordingGh({ code: 0 })
    const res = await drain(ghPrOpenTool(g.runner, git, a).execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("nothing to open")
    expect(g.argv.length).toBe(0)
    expect(a.inputs.length).toBe(0)
  })

  test("head not on origin: ok:false with push hint, gh NOT called", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: false })
    const g = recordingGh({ code: 0 })
    const res = await drain(ghPrOpenTool(g.runner, git, author()).execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("git push -u origin feat/x")
    expect(g.argv.length).toBe(0)
  })

  test("protected head (main) refused, author NOT called", async () => {
    const { runner: git } = fakeGit({ originHas: true })
    const a = author()
    const res = await drain(
      ghPrOpenTool(gh({ code: 0 }) as never, git, a).execute({ head: "main" }, ctx()),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("protected")
    expect(a.inputs.length).toBe(0)
  })

  test("head === base refused", async () => {
    const { runner: git } = fakeGit({ originHas: true })
    const res = await drain(
      ghPrOpenTool(gh({ code: 0 }) as never, git, author()).execute(
        { head: "feat/x", base: "feat/x" },
        ctx(),
      ),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("nothing to open a PR for")
  })

  test("detached HEAD (no head + rev-parse=HEAD) ⇒ ok:false", async () => {
    const { runner: git } = fakeGit({ branch: "HEAD", originHas: true })
    const res = await drain(
      ghPrOpenTool(gh({ code: 0 }) as never, git, author()).execute({}, ctx()),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("detached HEAD")
  })

  test("gh pr create failure ⇒ ok:false, stderr surfaced", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 1, stderr: "GraphQL: protected branch" })
    const res = await drain(ghPrOpenTool(g.runner, git, author()).execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("gh pr create failed")
    expect(res.output).toContain("protected branch")
  })

  test("draft:true appends --draft", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 0, stdout: "url" })
    await drain(ghPrOpenTool(g.runner, git, author()).execute({ draft: true }, ctx()))
    expect(g.argv[0]).toContain("--draft")
  })

  test("base 'origin/' prefix is stripped for gh --base", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 0, stdout: "url" })
    await drain(ghPrOpenTool(g.runner, git, author()).execute({ base: "origin/release" }, ctx()))
    const create = g.argv[0]
    if (create === undefined) throw new Error("expected gh invocation")
    expect(create[create.indexOf("--base") + 1]).toBe("release")
  })

  test("explicit head skips the rev-parse --abbrev-ref resolve", async () => {
    const { runner: git, calls } = fakeGit({ originHas: true })
    const g = recordingGh({ code: 0, stdout: "url" })
    await drain(ghPrOpenTool(g.runner, git, author()).execute({ head: "feat/y" }, ctx()))
    expect(calls.some((c) => c[0] === "rev-parse" && c.includes("--abbrev-ref"))).toBe(false)
  })

  test("author LLM failure propagates, gh NOT called", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 0 })
    const res = await drain(
      ghPrOpenTool(g.runner, git, new FakeAuthor(new Error("stream boom"))).execute({}, ctx()),
    )
    expect(res.ok).toBe(false)
    expect(g.argv.length).toBe(0)
  })

  test("title/body travel as DISTINCT argv items (no shell, injection-safe)", async () => {
    const { runner: git } = fakeGit({ branch: "feat/x", originHas: true })
    const g = recordingGh({ code: 0, stdout: "url" })
    await drain(
      ghPrOpenTool(g.runner, git, author("feat: x; rm -rf /\n\nbody $(whoami)")).execute({}, ctx()),
    )
    const create = g.argv[0]
    if (create === undefined) throw new Error("expected gh invocation")
    const title = create[create.indexOf("--title") + 1]
    const body = create[create.indexOf("--body") + 1]
    expect(title).toBe("feat: x; rm -rf /")
    expect(body).toBe("body $(whoami)")
  })

  test("tool identity: write, not concurrency-safe", () => {
    const { runner: git } = fakeGit()
    const t = ghPrOpenTool(gh({}) as never, git, author())
    expect(t.name).toBe("gh_pr_open")
    expect(t.isReadOnly()).toBe(false)
    expect(t.isConcurrencySafe({})).toBe(false)
  })
})

// ── buildPrShipBlock wiring ───────────────────────────────────────────────────

describe("buildPrShipBlock", () => {
  const cfg = (over: Record<string, unknown> = {}): never => ({ llm: author(), ...over }) as never

  test("composeAuthoring slot absent ⇒ [] (byte-identical default-OFF)", () => {
    expect(buildPrShipBlock(cfg())).toEqual([])
  })

  test("slot present ⇒ exactly [gh_pr_open], a WRITE tool", () => {
    const tools = buildPrShipBlock(cfg({ composeAuthoring: { authorLLM: author() } }))
    expect(tools.map((t) => t.name)).toEqual(["gh_pr_open"])
    expect(tools[0]?.isReadOnly()).toBe(false)
  })
})

// ── ghTools factory gating ────────────────────────────────────────────────────

describe("ghTools — gh_pr_open registration", () => {
  test("no opts ⇒ gh_pr_open NOT registered (byte-identical)", () => {
    expect(ghTools().map((t) => t.name)).not.toContain("gh_pr_open")
  })

  test("authorLLM + gitRunner ⇒ gh_pr_open registered", () => {
    const { runner: git } = fakeGit()
    const names = ghTools(undefined, { authorLLM: author(), gitRunner: git }).map((t) => t.name)
    expect(names).toContain("gh_pr_open")
  })

  test("authorLLM WITHOUT gitRunner ⇒ NOT registered (both required)", () => {
    const names = ghTools(undefined, { authorLLM: author() }).map((t) => t.name)
    expect(names).not.toContain("gh_pr_open")
  })
})

// ── composePrText delegation: git_compose_pr stays byte-identical ─────────────

describe("git_compose_pr — still works via extracted composePrText core", () => {
  test("happy path returns title + body, opens nothing", async () => {
    const { runner: git } = fakeGit({ diff: gitOk("diff --git a/x b/x\n+y", 1) })
    const res = await drain(
      gitComposePrTool(git, author("feat(x): add\n\n## Summary\nbody")).execute({}, ctx()),
    )
    expect(res.ok).toBe(true)
    expect(res.output).toContain("title: feat(x): add")
  })

  test("empty range keeps the historical 'empty' message", async () => {
    const { runner: git } = fakeGit({ diff: gitOk("") })
    const res = await drain(gitComposePrTool(git, author()).execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("empty")
  })
})
