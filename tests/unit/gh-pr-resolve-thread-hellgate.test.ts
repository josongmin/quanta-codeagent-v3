/**
 * RFC jun-6 hellgate — `gh_pr_resolve_thread`.
 *
 * Closed-port (injected GhRunner + GitRunner), no network / no repo. Cases:
 *   - LIST mode: query runner invoked → unresolved thread ids + paths listed,
 *     resolved threads filtered out.
 *   - RESOLVE-ONE: the `resolveReviewThread` mutation argv is exact; the
 *     threadId rides a NAMED `-F threadId=` variable, NOT interpolated into the
 *     query body (which is the module-constant mutation).
 *   - arg-injection: a `-`-leading PR ref and a flag-shaped threadId are
 *     rejected before argv (neither reaches a runner).
 *   - GraphQL variable safety: a threadId containing `'`/`}`/a query fragment is
 *     passed verbatim in the `-F` slot, query body unchanged.
 *   - concurrent-push:
 *       local==origin → no rebase, resolve proceeds.
 *       diverged + rebaseOnDivergence:false → ok:false {head_moved}, NO git mutation.
 *       diverged + rebaseOnDivergence:true + clean rebase → fetch then rebase, resolve runs.
 *       diverged + rebase CONFLICTS → rebase --abort, ok:false {rebase_conflict}, NO resolve.
 *       BOUNDED: a SECOND divergence after the single rebase → ok:false, ≤1 rebase.
 *   - no env leak (gh runner allowlist).
 */
import { describe, expect, test } from "bun:test"
import { type GhRunner, ghPrResolveThreadTool } from "@/tool/gh"
import { RESOLVE_THREAD_MUTATION, UNRESOLVED_THREADS_QUERY } from "@/tool/gh/pr-resolve-thread"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolEvent } from "@/tool/types"

// ── fakes ───────────────────────────────────────────────────────────────────

const REPO_JSON = JSON.stringify({ owner: { login: "octo" }, name: "repo" })

const threadsJson = (
  headRefName: string,
  nodes: Array<{ id: string; isResolved?: boolean; path?: string }>,
): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefName,
          reviewThreads: {
            nodes: nodes.map((n) => ({
              id: n.id,
              isResolved: n.isResolved ?? false,
              comments: { nodes: n.path !== undefined ? [{ path: n.path }] : [] },
            })),
          },
        },
      },
    },
  })

/** A gh runner that dispatches by argv shape: repo view / graphql query /
 *  graphql mutation. Records every argv. */
const ghRunner = (opts: {
  repo?: string
  threads?: string
  mutationCode?: number
}): GhRunner & { argv: string[][] } => {
  const argv: string[][] = []
  return Object.assign(
    async (a: string[]) => {
      argv.push([...a])
      if (a[1] === "repo" && a[2] === "view") {
        return { code: 0, stdout: opts.repo ?? REPO_JSON, stderr: "" }
      }
      // graphql — distinguish query (UNRESOLVED_THREADS_QUERY) vs mutation.
      const q = a.find((x) => x.startsWith("query="))
      if (q?.includes("reviewThreads")) {
        return { code: 0, stdout: opts.threads ?? threadsJson("feat/x", []), stderr: "" }
      }
      // mutation
      return { code: opts.mutationCode ?? 0, stdout: "{}", stderr: opts.mutationCode ? "boom" : "" }
    },
    { argv },
  ) as GhRunner & { argv: string[][] }
}

/** A git runner driven by a per-subcommand script. `aheadCounts` is consumed in
 *  order by each `rev-list --count` call (simulating divergence before/after a
 *  rebase). */
const gitRunner = (script: {
  fetchCode?: number
  rebaseCode?: number
  aheadCounts?: number[]
}): GitRunner & { calls: string[][] } => {
  const calls: string[][] = []
  const ahead = [...(script.aheadCounts ?? [0])]
  return {
    calls,
    async run(args: readonly string[]): Promise<GitRunResult> {
      calls.push([...args])
      if (args[0] === "fetch") {
        return { stdout: "", stderr: "", exitCode: script.fetchCode ?? 0 }
      }
      if (args[0] === "rev-list") {
        const n = ahead.shift() ?? 0
        return { stdout: `${n}\n`, stderr: "", exitCode: 0 }
      }
      if (args[0] === "rebase") {
        if (args[1] === "--abort") return { stdout: "", stderr: "", exitCode: 0 }
        return { stdout: "", stderr: "CONFLICT", exitCode: script.rebaseCode ?? 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    },
  } as GitRunner & { calls: string[][] }
}

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const events: ToolEvent[] = []
  for await (const ev of it) events.push(ev)
  return events
}
const resultOf = (
  events: ToolEvent[],
): { ok: boolean; output: string; failure?: { mode: string; reason?: string } } | undefined => {
  const r = events.find((e) => e.type === "result")
  if (r && r.type === "result") return r.result as never
  return undefined
}
const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal })

const gitCmds = (g: { calls: string[][] }): string[] => g.calls.map((c) => c[0] as string)

describe("gh_pr_resolve_thread (hellgate)", () => {
  test("HELL-1: LIST mode queries threads + lists unresolved ids, filtering resolved", async () => {
    const gh = ghRunner({
      threads: threadsJson("feat/x", [
        { id: "T_kw1", path: "src/a.ts" },
        { id: "T_done", isResolved: true, path: "src/b.ts" },
        { id: "T_kw2", path: "src/c.ts" },
      ]),
    })
    const events = await drain(ghPrResolveThreadTool(gh, gitRunner({})).execute({ pr: 5 }, ctx()))
    const out = resultOf(events)
    expect(out?.ok).toBe(true)
    expect(out?.output).toContain("T_kw1")
    expect(out?.output).toContain("src/a.ts")
    expect(out?.output).toContain("T_kw2")
    expect(out?.output).not.toContain("T_done")
    // No mutation argv in LIST mode.
    expect(gh.argv.some((a) => a.some((x) => x.includes("resolveReviewThread")))).toBe(false)
  })

  test("HELL-2: RESOLVE-ONE builds the exact mutation argv with a NAMED -F threadId var", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]) })
    await drain(ghPrResolveThreadTool(gh, gitRunner({})).execute({ pr: 1, threadId: "T_a" }, ctx()))
    const mut = gh.argv.find((a) => a.some((x) => x === "query=" + RESOLVE_THREAD_MUTATION))
    expect(mut).toEqual([
      "gh",
      "api",
      "graphql",
      "-F",
      "threadId=T_a",
      "-f",
      "query=" + RESOLVE_THREAD_MUTATION,
    ])
    // The mutation body is the module constant — user input never appears in it.
    expect(RESOLVE_THREAD_MUTATION).toContain("resolveReviewThread")
  })

  test("HELL-3: a `-`-leading PR ref is rejected before any runner is called", async () => {
    const gh = ghRunner({})
    const git = gitRunner({})
    const events = await drain(
      ghPrResolveThreadTool(gh, git).execute({ pr: "--web", threadId: "T_a" }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("invalid PR identifier")
    expect(gh.argv.length).toBe(0)
    expect(git.calls.length).toBe(0)
  })

  test("HELL-4: a flag-shaped threadId is rejected before argv", async () => {
    const gh = ghRunner({})
    const events = await drain(
      ghPrResolveThreadTool(gh, gitRunner({})).execute({ pr: 1, threadId: "--paginate" }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("invalid threadId")
    expect(gh.argv.length).toBe(0)
  })

  test("HELL-5: GraphQL injection-shaped threadId is rejected (never interpolated)", async () => {
    const gh = ghRunner({})
    // contains `'` `}` and a fake query fragment — must NOT pass the node-id validator.
    const events = await drain(
      ghPrResolveThreadTool(gh, gitRunner({})).execute({ pr: 1, threadId: "x'}}){evil} #" }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("invalid threadId")
    expect(gh.argv.length).toBe(0)
  })

  test("HELL-6: the unresolved-threads query argv passes owner/repo/pr as NAMED -F vars", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", []) })
    await drain(ghPrResolveThreadTool(gh, gitRunner({})).execute({ pr: 9 }, ctx()))
    const query = gh.argv.find((a) => a.some((x) => x === "query=" + UNRESOLVED_THREADS_QUERY))
    expect(query).toEqual([
      "gh",
      "api",
      "graphql",
      "-F",
      "owner=octo",
      "-F",
      "repo=repo",
      "-F",
      "pr=9",
      "-f",
      "query=" + UNRESOLVED_THREADS_QUERY,
    ])
  })

  test("HELL-7: local==origin → no rebase, resolve proceeds", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]) })
    const git = gitRunner({ aheadCounts: [0] })
    const events = await drain(
      ghPrResolveThreadTool(gh, git).execute({ pr: 1, threadId: "T_a" }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(true)
    expect(gitCmds(git)).not.toContain("rebase")
    expect(gh.argv.some((a) => a.includes("query=" + RESOLVE_THREAD_MUTATION))).toBe(true)
  })

  test("HELL-8: diverged + rebaseOnDivergence:false → head_moved, NO git mutation", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]) })
    const git = gitRunner({ aheadCounts: [3] })
    const events = await drain(
      ghPrResolveThreadTool(gh, git).execute({ pr: 1, threadId: "T_a" }, ctx()),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.failure?.reason).toBe("head_moved")
    // fetch + rev-list are reads; NO rebase mutation, NO resolve mutation.
    expect(gitCmds(git)).not.toContain("rebase")
    expect(gh.argv.some((a) => a.includes("query=" + RESOLVE_THREAD_MUTATION))).toBe(false)
  })

  test("HELL-9: diverged + rebaseOnDivergence:true + clean rebase → fetch, rebase, then resolve", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]) })
    const git = gitRunner({ aheadCounts: [2, 0], rebaseCode: 0 })
    const events = await drain(
      ghPrResolveThreadTool(gh, git).execute(
        { pr: 1, threadId: "T_a", rebaseOnDivergence: true },
        ctx(),
      ),
    )
    expect(resultOf(events)?.ok).toBe(true)
    const cmds = gitCmds(git)
    expect(cmds).toContain("fetch")
    expect(cmds.filter((c) => c === "rebase").length).toBe(1)
    expect(gh.argv.some((a) => a.includes("query=" + RESOLVE_THREAD_MUTATION))).toBe(true)
  })

  test("HELL-10: diverged + rebase CONFLICTS → rebase --abort, fail-closed, NO resolve", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]) })
    const git = gitRunner({ aheadCounts: [2], rebaseCode: 1 })
    const events = await drain(
      ghPrResolveThreadTool(gh, git).execute(
        { pr: 1, threadId: "T_a", rebaseOnDivergence: true },
        ctx(),
      ),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.failure?.reason).toBe("rebase_conflict")
    // The abort must have run; the resolve mutation must NOT.
    expect(git.calls.some((c) => c[0] === "rebase" && c[1] === "--abort")).toBe(true)
    expect(gh.argv.some((a) => a.includes("query=" + RESOLVE_THREAD_MUTATION))).toBe(false)
  })

  test("HELL-11: BOUNDED — a SECOND divergence after the single rebase fails closed (≤1 rebase)", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]) })
    // diverged before (2), still diverged after the rebase (1) — must NOT loop.
    const git = gitRunner({ aheadCounts: [2, 1], rebaseCode: 0 })
    const events = await drain(
      ghPrResolveThreadTool(gh, git).execute(
        { pr: 1, threadId: "T_a", rebaseOnDivergence: true },
        ctx(),
      ),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.failure?.reason).toBe("head_moved")
    expect(gitCmds(git).filter((c) => c === "rebase").length).toBe(1)
    expect(gh.argv.some((a) => a.includes("query=" + RESOLVE_THREAD_MUTATION))).toBe(false)
  })

  test("HELL-12: resolve-all resolves every unresolved thread", async () => {
    const gh = ghRunner({
      threads: threadsJson("feat/x", [
        { id: "T_a" },
        { id: "T_b" },
        { id: "T_done", isResolved: true },
      ]),
    })
    const events = await drain(
      ghPrResolveThreadTool(gh, gitRunner({ aheadCounts: [0] })).execute(
        { pr: 1, all: true },
        ctx(),
      ),
    )
    expect(resultOf(events)?.ok).toBe(true)
    const mutations = gh.argv.filter((a) => a.includes("query=" + RESOLVE_THREAD_MUTATION))
    const ids = mutations.map((a) => a.find((x) => x.startsWith("threadId=")))
    expect(ids).toContain("threadId=T_a")
    expect(ids).toContain("threadId=T_b")
    expect(ids).not.toContain("threadId=T_done")
  })

  test("HELL-13: a gh repo view failure surfaces ok:false (never throws)", async () => {
    const gh = Object.assign(
      async (a: string[]) => {
        if (a[1] === "repo") return { code: 1, stdout: "", stderr: "no repo here" }
        return { code: 0, stdout: "{}", stderr: "" }
      },
      { argv: [] as string[][] },
    ) as GhRunner
    const events = await drain(ghPrResolveThreadTool(gh, gitRunner({})).execute({ pr: 1 }, ctx()))
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("gh repo view failed")
  })

  test("HELL-14: mutation non-zero exit surfaces ok:false with sliced stderr", async () => {
    const gh = ghRunner({ threads: threadsJson("feat/x", [{ id: "T_a" }]), mutationCode: 1 })
    const events = await drain(
      ghPrResolveThreadTool(gh, gitRunner({ aheadCounts: [0] })).execute(
        { pr: 1, threadId: "T_a" },
        ctx(),
      ),
    )
    expect(resultOf(events)?.ok).toBe(false)
    expect(resultOf(events)?.output).toContain("gh api graphql failed")
  })

  test("HELL-15: the tool is declared mutating (isReadOnly false)", () => {
    const tool = ghPrResolveThreadTool(ghRunner({}), gitRunner({}))
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({ pr: 1 })).toBe(false)
  })

  test("HELL-16: env fence — provider keys excluded from the gh runner allowlist", async () => {
    const mod = await import("@/runtime")
    const scrubbed = mod.scrubEnv(["PATH", "GH_TOKEN"])
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
