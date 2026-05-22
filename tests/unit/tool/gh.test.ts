/**
 * GitHub CLI tool slice — hermetic tests with an injected `GhRunner`.
 *
 * No real `gh` binary required; the runner returns a fixture per argv.
 */
import { describe, expect, test } from "bun:test"
import { ghTools, type GhRunner, type GhRunResult } from "@/../src/tool/gh"

const makeRunner = (
  responses: Record<string, GhRunResult>,
): { runner: GhRunner; calls: string[][] } => {
  const calls: string[][] = []
  const runner: GhRunner = async (argv) => {
    calls.push([...argv])
    const key = argv.slice(0, 3).join(" ")
    const r = responses[key]
    return r ?? { code: 1, stdout: "", stderr: `no fixture for ${key}` }
  }
  return { runner, calls }
}

const ctx = {
  cwd: "/tmp/work",
  signal: new AbortController().signal,
}

const runOnce = async <I>(
  tool: ReturnType<typeof ghTools>[number],
  input: unknown,
): Promise<{ ok: boolean; output?: string }> => {
  for await (const ev of (tool.execute as (i: unknown, c: typeof ctx) => AsyncIterable<{
    type: string
    result?: { ok: boolean; output?: string }
  }>)(input, ctx)) {
    if (ev.type === "result" && ev.result) return ev.result
  }
  return { ok: false, output: "no result emitted" }
}

describe("ghTools registry", () => {
  test("ghTools() returns 6 tools", () => {
    const tools = ghTools()
    expect(tools.length).toBe(6)
    const names = tools.map((t) => t.name)
    expect(names).toEqual([
      "gh_pr_view",
      "gh_issue_view",
      "gh_check_status",
      "gh_pr_comment",
      "gh_pr_create",
      "gh_pr_list",
    ])
  })

  test("read tools are readOnly + concurrencySafe", () => {
    const tools = ghTools()
    const reads = tools.filter((t) =>
      ["gh_pr_view", "gh_issue_view", "gh_check_status", "gh_pr_list"].includes(t.name),
    )
    for (const t of reads) {
      expect(t.isReadOnly()).toBe(true)
      expect(t.isConcurrencySafe({} as never)).toBe(true)
    }
  })

  test("write tools are NOT readOnly + NOT concurrencySafe", () => {
    const tools = ghTools()
    const writes = tools.filter((t) => ["gh_pr_comment", "gh_pr_create"].includes(t.name))
    for (const t of writes) {
      expect(t.isReadOnly()).toBe(false)
      expect(t.isConcurrencySafe({} as never)).toBe(false)
    }
  })
})

describe("gh_pr_view", () => {
  test("builds correct argv + returns stdout on success", async () => {
    const { runner, calls } = makeRunner({
      "gh pr view": { code: 0, stdout: '{"title":"X","body":"…"}', stderr: "" },
    })
    const [view] = ghTools(runner)
    if (!view) throw new Error("missing tool")
    const r = await runOnce(view, { pr: 42 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("title")
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "42",
      "--json",
      "title,body,headRefName,baseRefName,state,url",
    ])
  })

  test("custom fields are honored", async () => {
    const { runner, calls } = makeRunner({ "gh pr view": { code: 0, stdout: "{}", stderr: "" } })
    const [view] = ghTools(runner)
    if (!view) throw new Error("missing tool")
    await runOnce(view, { pr: 1, fields: ["title"] })
    expect(calls[0]?.[5]).toBe("title")
  })

  test("non-zero gh exit → ok:false with stderr tail", async () => {
    const { runner } = makeRunner({
      "gh pr view": { code: 1, stdout: "", stderr: "authentication required" },
    })
    const [view] = ghTools(runner)
    if (!view) throw new Error("missing tool")
    const r = await runOnce(view, { pr: 1 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("authentication required")
  })

  test("leading-dash PR identifier is rejected before reaching argv (arg-injection)", async () => {
    const { runner, calls } = makeRunner({
      "gh pr view": { code: 0, stdout: "{}", stderr: "" },
    })
    const [view] = ghTools(runner)
    if (!view) throw new Error("missing tool")
    // `--web` / `-R/owner/evil` would be parsed by `gh` as a FLAG, not a PR ref.
    const r = await runOnce(view, { pr: "--web" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid PR identifier")
    // The malformed value never reached the runner.
    expect(calls.length).toBe(0)
  })

  test("a full http(s) URL and a #-prefixed number are accepted", async () => {
    const { runner, calls } = makeRunner({
      "gh pr view": { code: 0, stdout: "{}", stderr: "" },
    })
    const [view] = ghTools(runner)
    if (!view) throw new Error("missing tool")
    await runOnce(view, { pr: "https://github.com/o/r/pull/7" })
    expect(calls[0]?.[3]).toBe("https://github.com/o/r/pull/7")

    await runOnce(view, { pr: "#42" })
    // `#42` normalizes to the bare number.
    expect(calls[1]?.[3]).toBe("42")
  })
})

describe("gh leading-dash rejection across positional-ref tools", () => {
  test("gh_issue_view rejects a leading-dash issue id", async () => {
    const { runner, calls } = makeRunner({})
    const tools = ghTools(runner)
    const tool = tools.find((t) => t.name === "gh_issue_view")
    if (!tool) throw new Error("missing tool")
    const r = await runOnce(tool, { issue: "-R/evil" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid issue identifier")
    expect(calls.length).toBe(0)
  })

  test("gh_check_status rejects a leading-dash pr id", async () => {
    const { runner, calls } = makeRunner({})
    const tools = ghTools(runner)
    const tool = tools.find((t) => t.name === "gh_check_status")
    if (!tool) throw new Error("missing tool")
    const r = await runOnce(tool, { pr: "--json" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid PR identifier")
    expect(calls.length).toBe(0)
  })

  test("gh_pr_comment rejects a leading-dash pr id", async () => {
    const { runner, calls } = makeRunner({})
    const tools = ghTools(runner)
    const tool = tools.find((t) => t.name === "gh_pr_comment")
    if (!tool) throw new Error("missing tool")
    const r = await runOnce(tool, { pr: "-x", body: "hi" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid PR identifier")
    expect(calls.length).toBe(0)
  })
})

describe("gh_pr_comment", () => {
  test("posts comment via correct argv", async () => {
    const { runner, calls } = makeRunner({
      "gh pr comment": { code: 0, stdout: "https://github.com/x/y/pull/1#…", stderr: "" },
    })
    const tools = ghTools(runner)
    const comment = tools.find((t) => t.name === "gh_pr_comment")
    if (!comment) throw new Error("missing tool")
    const r = await runOnce(comment, { pr: 1, body: "LGTM with caveats." })
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual(["gh", "pr", "comment", "1", "--body", "LGTM with caveats."])
  })
})

describe("gh_pr_create", () => {
  test("creates PR with explicit head + base", async () => {
    const { runner, calls } = makeRunner({
      "gh pr create": { code: 0, stdout: "https://github.com/x/y/pull/42", stderr: "" },
    })
    const tools = ghTools(runner)
    const create = tools.find((t) => t.name === "gh_pr_create")
    if (!create) throw new Error("missing tool")
    const r = await runOnce(create, {
      title: "fix: x",
      body: "details",
      base: "main",
      head: "fix/x",
    })
    expect(r.ok).toBe(true)
    const argv = calls[0]
    expect(argv).toContain("--head")
    expect(argv).toContain("fix/x")
    expect(argv).toContain("--base")
    expect(argv).toContain("main")
  })
})
