/**
 * search_codebase `scope` (§21.5) hellgate.
 *
 * Pins the directory-scoping surface added to the tool:
 *  - absent/blank scope ⇒ byte-identical to the pre-scope path (fetch exactly
 *    `k`, no filter)
 *  - present scope ⇒ POST-filters ranked hits to the prefix, widens the
 *    candidate pool to MAX_K, slices back to `k`
 *  - traversal / absolute scope ⇒ typed `invalid-config` rejection (no search)
 *  - scope that matches nothing ⇒ honest empty result
 */

import { describe, expect, test } from "bun:test"
import type { SearchHit, SearchPipeline, SearchQuery } from "@/retrieval/pipeline"
import { err, ok } from "@/shared"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { searchCodebaseTool } from "@/tool/search-codebase"

const ctx = (aborted = false): ToolContext => {
  const ac = new AbortController()
  if (aborted) ac.abort()
  return { cwd: "/tmp/x", signal: ac.signal } as ToolContext
}

const hit = (path: string): SearchHit => ({
  id: path,
  score: 0.9,
  text: `body of ${path}`,
  source: "lexical",
  metadata: { path },
})

/** A pipeline that records queries and returns a fixed hit list. */
const makePipeline = (
  hits: readonly SearchHit[],
): { pipeline: SearchPipeline; calls: SearchQuery[] } => {
  const calls: SearchQuery[] = []
  return {
    calls,
    pipeline: {
      async search(q: SearchQuery) {
        calls.push(q)
        return ok(hits)
      },
    },
  }
}

const runFull = async (
  tool: ReturnType<typeof searchCodebaseTool>,
  input: unknown,
  c: ToolContext = ctx(),
): Promise<ToolResult> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, c)) last = ev
  if (last?.type !== "result") throw new Error("no result event")
  return last.result
}

const run = async (
  tool: ReturnType<typeof searchCodebaseTool>,
  input: unknown,
): Promise<string> => (await runFull(tool, input)).output

describe("HELL-SCOPE-1 — absent scope is byte-identical (fetch k, no filter)", () => {
  test("no scope ⇒ pipeline called with exactly k, all hits rendered", async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts"), hit("docs/b.md")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", k: 7 })
    expect(calls[0]?.k).toBe(7)
    expect(out).toContain("src/a.ts")
    expect(out).toContain("docs/b.md")
  })

  test("empty-string scope is treated as no filter (fetch k)", async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts"), hit("docs/b.md")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", k: 3, scope: "  " })
    expect(calls[0]?.k).toBe(3)
    expect(out).toContain("docs/b.md")
  })
})

describe("HELL-SCOPE-2 — present scope filters to the prefix + widens pool", () => {
  test("only in-scope hits survive; pool widened to MAX_K (50)", async () => {
    const { pipeline, calls } = makePipeline([
      hit("src/auth/login.ts"),
      hit("src/auth/session.ts"),
      hit("src/db/pool.ts"),
      hit("docs/auth.md"),
    ])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", k: 10, scope: "src/auth" })
    expect(calls[0]?.k).toBe(50) // widened to the existing MAX_K cap, not k
    expect(out).toContain("src/auth/login.ts")
    expect(out).toContain("src/auth/session.ts")
    expect(out).not.toContain("src/db/pool.ts")
    expect(out).not.toContain("docs/auth.md")
  })

  test("exact-directory match is NOT a prefix false-positive (src/auth ≠ src/authx)", async () => {
    const { pipeline } = makePipeline([hit("src/authx/evil.ts"), hit("src/auth/ok.ts")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "src/auth" })
    expect(out).toContain("src/auth/ok.ts")
    expect(out).not.toContain("src/authx/evil.ts")
  })

  test("filtered result is sliced back to k", async () => {
    const many = Array.from({ length: 20 }, (_, i) => hit(`src/auth/f${i}.ts`))
    const { pipeline } = makePipeline(many)
    const out = await run(searchCodebaseTool(pipeline), { query: "x", k: 5, scope: "src/auth" })
    expect(out).toContain("Found 5 hit(s)")
  })
})

describe("HELL-SCOPE-3 — traversal/absolute scope is rejected (no search)", () => {
  test("'..' segment ⇒ invalid-config, pipeline never called", async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "../etc" })
    expect(out).toContain("scope escapes the workspace")
    expect(calls.length).toBe(0)
  })

  test("absolute scope ⇒ invalid-config, pipeline never called", async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "/etc/passwd" })
    expect(out).toContain("scope escapes the workspace")
    expect(calls.length).toBe(0)
  })

  test("nested '..' anywhere in the path is caught", async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "src/../../etc" })
    expect(out).toContain("scope escapes the workspace")
    expect(calls.length).toBe(0)
  })
})

describe("HELL-SCOPE-4 — scope matching nothing ⇒ honest empty", () => {
  test("no hit under scope ⇒ 'No hits' (not a crash, not stale rows)", async () => {
    const { pipeline } = makePipeline([hit("docs/a.md"), hit("docs/b.md")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "src/auth" })
    expect(out).toContain("No hits")
  })
})

describe("HELL-SCOPE-5 — separator/dot normalization (audit findings 1-3)", () => {
  test("backslash-delimited scope matches forward-slash hit paths", async () => {
    const { pipeline } = makePipeline([hit("src/auth/ok.ts"), hit("src/db/x.ts")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "src\\auth" })
    expect(out).toContain("src/auth/ok.ts")
    expect(out).not.toContain("src/db/x.ts")
  })

  test('scope="." means whole workspace (no filter, k not widened)', async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts"), hit("docs/b.md")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "." })
    expect(calls[0]?.k).toBe(10) // NOT widened to MAX_K ⇒ treated as no-filter
    expect(out).toContain("src/a.ts")
    expect(out).toContain("docs/b.md")
  })

  test('scope="./" and "././" also mean whole workspace', async () => {
    for (const scope of ["./", "././"]) {
      const { pipeline, calls } = makePipeline([hit("src/a.ts")])
      const out = await run(searchCodebaseTool(pipeline), { query: "x", scope })
      expect(calls[0]?.k).toBe(10)
      expect(out).toContain("src/a.ts")
    }
  })

  test("redundant leading ./ prefixes are stripped (`././src` filters to src/)", async () => {
    const { pipeline } = makePipeline([hit("src/login.ts"), hit("docs/x.md")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "././src" })
    expect(out).toContain("src/login.ts")
    expect(out).not.toContain("docs/x.md")
  })

  test("backslash traversal is still rejected (fold then ..-detect)", async () => {
    const { pipeline, calls } = makePipeline([hit("src/a.ts")])
    const out = await run(searchCodebaseTool(pipeline), { query: "x", scope: "src\\..\\..\\etc" })
    expect(out).toContain("scope escapes the workspace")
    expect(calls.length).toBe(0)
  })
})

describe("HELL-SCOPE-6 — error-kind passthrough on the scoped path (audit finding 5)", () => {
  test("pipeline throw ⇒ ok:false + modelVisibleError 'stage-failed'", async () => {
    const pipeline: SearchPipeline = {
      async search() {
        throw new Error("boom")
      },
    }
    const r = await runFull(searchCodebaseTool(pipeline), { query: "x", scope: "src/auth" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("boom")
    expect(r.failure?.mode === "error" && r.failure.modelVisibleError).toBe("stage-failed")
  })

  test("pipeline err({kind:'no-results'}) ⇒ kind passthrough", async () => {
    const pipeline: SearchPipeline = {
      async search() {
        return err({ kind: "no-results" })
      },
    }
    const r = await runFull(searchCodebaseTool(pipeline), { query: "x" })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode === "error" && r.failure.modelVisibleError).toBe("no-results")
  })

  test("already-aborted ctx ⇒ 'aborted before start', pipeline never called", async () => {
    const calls: SearchQuery[] = []
    const pipeline: SearchPipeline = {
      async search(q) {
        calls.push(q)
        return ok([])
      },
    }
    const r = await runFull(searchCodebaseTool(pipeline), { query: "x", scope: "src/auth" }, ctx(true))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("aborted before start")
    expect(calls.length).toBe(0)
  })
})
