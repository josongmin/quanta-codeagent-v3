/**
 * E2E / integration HELLGATE — jun-08 long-tail NEW model-facing tools.
 *
 * Drives each new tool through the REAL surface, not a unit shape:
 *   - §7.2 git_co_change: a REAL git repo (git init + real commits) → real
 *     co-occurrence matrix, dispatched through a REAL ToolRegistry.
 *   - §5.4 gh_pr_code_tour: built through the REAL ghTools(opts.codeTour) factory,
 *     registered in a REAL ToolRegistry, executed end-to-end over a real-shaped
 *     unified diff.
 *   - §7.3 ci_finding: built through REAL ghTools(opts.ciFindingStore), a
 *     record → get round-trip through the REAL registry (the store persists
 *     across calls within the session).
 *   - WIRING: the REAL composition root `buildCiBotWiring` with the gates ON
 *     registers all three; gates OFF ⇒ byte-identical (the default-OFF proof
 *     through the live wiring, not just the factory).
 *   - §6.5 listVoices: the REAL realtime adapter port method end-to-end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCiBotWiring } from "@/apps/agent/mode-presets/ci-bot"
import { createBunWebSocketAdapter } from "@/realtime"
import { ToolRegistry } from "@/tool"
import { createCiFindingStore } from "@/tool/ci-finding"
import { type GhRunner, type GhRunResult, ghTools } from "@/tool/gh"
import { defaultGitRunner, gitCoChangeTool } from "@/tool/git"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext =>
  ({ cwd, signal: new AbortController().signal }) as unknown as ToolContext

const dispatch = async (
  reg: ToolRegistry,
  name: string,
  input: unknown,
  cwd: string,
): Promise<ToolResult> => {
  const tool = reg.get(name)
  if (tool === undefined) throw new Error(`tool '${name}' not registered`)
  let result: ToolResult | undefined
  for await (const ev of (tool as Tool).execute(
    input as never,
    ctx(cwd),
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("no result")
  return result
}

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
  const code = await p.exited
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`)
}

const hasGit = async (): Promise<boolean> => {
  try {
    const p = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" })
    return (await p.exited) === 0
  } catch {
    return false
  }
}

const HAS_GIT = await hasGit()

// ── §7.2 git_co_change — REAL git repo ───────────────────────────────────────
describe("HELLGATE §7.2 — git_co_change over a REAL repo via the REAL registry", () => {
  let dir = ""

  beforeAll(async () => {
    if (!HAS_GIT) return
    dir = await mkdtemp(join(tmpdir(), "co-change-e2e-"))
    await git(dir, ["init", "-q"])
    await git(dir, ["config", "user.email", "a@b.c"])
    await git(dir, ["config", "user.name", "T"])
    // Commit 1: foo.ts + foo.test.ts (they co-change).
    await writeFile(join(dir, "foo.ts"), "1")
    await writeFile(join(dir, "foo.test.ts"), "t1")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-q", "-m", "c1"])
    // Commit 2: foo.ts + foo.test.ts AGAIN (co-change twice).
    await writeFile(join(dir, "foo.ts"), "2")
    await writeFile(join(dir, "foo.test.ts"), "t2")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-q", "-m", "c2"])
    // Commit 3: foo.ts + README.md (foo↔README once).
    await writeFile(join(dir, "foo.ts"), "3")
    await writeFile(join(dir, "README.md"), "r")
    await git(dir, ["add", "."])
    await git(dir, ["commit", "-q", "-m", "c3"])
  })

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test.skipIf(!HAS_GIT)(
    "ranks foo.test.ts above README.md as co-changing with foo.ts",
    async () => {
      const reg = new ToolRegistry([gitCoChangeTool(defaultGitRunner) as Tool])
      const r = await dispatch(reg, "git_co_change", { file: "foo.ts" }, dir)
      expect(r.ok).toBe(true)
      const out = String(r.output)
      // foo.test.ts co-changed with foo.ts in 2 commits; README.md in 1.
      expect(out).toContain("foo.test.ts")
      expect(out).toContain("README.md")
      const idxTest = out.indexOf("foo.test.ts")
      const idxReadme = out.indexOf("README.md")
      expect(idxTest).toBeGreaterThanOrEqual(0)
      expect(idxTest).toBeLessThan(idxReadme) // higher co-count ranks first
    },
  )

  test.skipIf(!HAS_GIT)("pairs mode (no file) surfaces the foo.ts+foo.test.ts edge", async () => {
    const reg = new ToolRegistry([gitCoChangeTool(defaultGitRunner) as Tool])
    const r = await dispatch(reg, "git_co_change", {}, dir)
    expect(r.ok).toBe(true)
    expect(String(r.output)).toContain("foo.test.ts")
  })
})

// ── §5.4 gh_pr_code_tour — REAL ghTools factory + registry ───────────────────
describe("HELLGATE §5.4 — gh_pr_code_tour through the REAL ghTools registry", () => {
  const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@ fn a()
 x
+y
@@ -10,1 +11,2 @@ fn b()
+z
`
  const runner: GhRunner = async (argv): Promise<GhRunResult> => {
    // Assert the tool actually shells `gh pr diff <ref>` (no arg-injection).
    expect(argv.slice(0, 3)).toEqual(["gh", "pr", "diff"])
    return { code: 0, stdout: DIFF, stderr: "" }
  }

  test("registered via opts.codeTour, dispatched end-to-end, renders 2 stops", async () => {
    const reg = new ToolRegistry(ghTools(runner, { codeTour: true }))
    expect(reg.has("gh_pr_code_tour")).toBe(true)
    const r = await dispatch(reg, "gh_pr_code_tour", { pr: 99 }, "/repo")
    expect(r.ok).toBe(true)
    const out = String(r.output)
    expect(out).toContain("PR code tour — 2 stop(s)")
    expect(out).toContain("src/a.ts:1-3")
    expect(out).toContain("src/a.ts:11-12")
  })

  test("gate OFF (no opts) ⇒ tool ABSENT from the real registry", () => {
    const reg = new ToolRegistry(ghTools(runner))
    expect(reg.has("gh_pr_code_tour")).toBe(false)
  })
})

// ── §7.3 ci_finding — REAL registry, record→get round-trip ───────────────────
describe("HELLGATE §7.3 — ci_finding record→get round-trip through the REAL registry", () => {
  test("the session store persists a recorded finding across dispatch calls", async () => {
    const store = createCiFindingStore({ now: () => 0, idFactory: (s) => `F${s}` })
    const reg = new ToolRegistry(ghTools(undefined, { ciFindingStore: store }))
    expect(reg.has("ci_finding")).toBe(true)

    const rec = await dispatch(
      reg,
      "ci_finding",
      {
        op: "record",
        job: "test (ubuntu)",
        category: "test-failure",
        summary: "race in resume",
        root_cause: "unsynchronized cursor advance",
        confidence: "high",
      },
      "/repo",
    )
    expect(rec.ok).toBe(true)
    expect(String(rec.output)).toContain("[F0]")

    // A SECOND dispatch sees the SAME store (session persistence).
    const got = await dispatch(reg, "ci_finding", { op: "get", id: "F0" }, "/repo")
    expect(got.ok).toBe(true)
    expect(String(got.output)).toContain("unsynchronized cursor advance")
    expect(store.size()).toBe(1)
  })

  test("gate OFF (no store) ⇒ tool ABSENT from the real registry", () => {
    const reg = new ToolRegistry(ghTools())
    expect(reg.has("ci_finding")).toBe(false)
  })
})

// ── WIRING — the REAL composition root buildCiBotWiring, gated ───────────────
describe("HELLGATE wiring — buildCiBotWiring registers the new tools ONLY when gated", () => {
  // The ci-bot `ghRun` seam shape (args → {stdout,stderr,exitCode}), distinct
  // from the gh-tool GhRunner (argv,cwd,timeout → {code,...}).
  const fakeGh = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  })
  const withEnv = async <T>(patch: Record<string, string | undefined>, fn: () => T): Promise<T> => {
    const saved: Record<string, string | undefined> = {}
    for (const k of Object.keys(patch)) {
      saved[k] = process.env[k]
      if (patch[k] === undefined) delete process.env[k]
      else process.env[k] = patch[k]
    }
    try {
      return await fn()
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  }

  test("gates OFF ⇒ none of the new tools are wired (byte-identical legacy)", async () => {
    await withEnv(
      {
        QUANTA_GH_CODE_TOUR: undefined,
        QUANTA_CI_FINDING: undefined,
        QUANTA_GIT_CO_CHANGE: undefined,
      },
      () => {
        const w = buildCiBotWiring("/repo", { ghRun: fakeGh })
        expect(w.tools.has("gh_pr_code_tour")).toBe(false)
        expect(w.tools.has("ci_finding")).toBe(false)
        expect(w.tools.has("git_co_change")).toBe(false)
      },
    )
  })

  test("gates ON ⇒ all three new tools appear in the real ci-bot tool set", async () => {
    await withEnv(
      {
        QUANTA_GH_CODE_TOUR: "on",
        QUANTA_CI_FINDING: "on",
        QUANTA_GIT_CO_CHANGE: "on",
      },
      () => {
        const w = buildCiBotWiring("/repo", { ghRun: fakeGh })
        // gh_pr_code_tour + ci_finding are read-only ⇒ survive the ci-bot
        // read-only gh filter; git_co_change rides gitTools.
        expect(w.tools.has("gh_pr_code_tour")).toBe(true)
        expect(w.tools.has("ci_finding")).toBe(true)
        expect(w.tools.has("git_co_change")).toBe(true)
      },
    )
  })
})

// ── §6.5 listVoices — REAL realtime adapter ──────────────────────────────────
describe("HELLGATE §6.5 — listVoices end-to-end through the REAL realtime adapter", () => {
  test("no provider ⇒ voices-unsupported (default MVP, byte-identical pre-§6.5)", async () => {
    const port = createBunWebSocketAdapter()
    const r = await port.listVoices()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("voices-unsupported")
  })

  test("provider wired ⇒ the port returns the server-advertised voices", async () => {
    const port = createBunWebSocketAdapter({
      voicesProvider: async () => ({
        ok: true,
        value: [{ id: "marin", label: "Marin" }],
      }),
    })
    const r = await port.listVoices()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value[0]?.id).toBe("marin")
  })
})
