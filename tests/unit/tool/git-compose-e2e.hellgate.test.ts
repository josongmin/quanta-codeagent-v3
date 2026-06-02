/**
 * e2e hellgate — `git_compose_commit` against a REAL temp git repo, then the
 * authored message round-tripped into `git_commit` (regular mode) so a REAL
 * commit lands; plus the knob env-flip registry seam through `buildSessionFeatures`.
 *
 * DETERMINISTIC: the author LLM is a ScriptedLLM (fixed Conventional Commits
 * reply) — no network. We assert STRUCTURAL / parse facts only (the authored
 * subject lands verbatim in `git log`, the tools are / are not registered) —
 * NO heuristic scoring of message "quality".
 *
 * Axes:
 *   A. REAL e2e — stage a file → git_compose_commit authors a message →
 *      git_commit(mode:'regular', message) → the commit exists in `git log`
 *      with the authored subject.
 *   B. ENV-FLIP REGISTRY — QUANTA_COMPOSE_AUTHORING="1" ⇒ buildSessionFeatures
 *      registers git_compose_commit + git_compose_pr; absent ⇒ NOT registered
 *      (byte-identical extraTools).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSessionFeatures } from "@/agent/features"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { applyKnobs, knobsForSurface, resolveKnobs, type Surface } from "@/runner/knobs"
import type { StreamPort } from "@/stream"
import {
  defaultGitRunner,
  defaultTools,
  type ToolContext,
  type ToolEvent,
  ToolRegistry,
  type ToolResult,
} from "@/tool"
import { gitCommitTool } from "@/tool/git/commit"
import { gitComposeCommitTool } from "@/tool/git/compose"

// ─── git harness (real spawn, isolated config) ───────────────────────────────

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

const git = async (
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  const p = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return { ok: code === 0, stdout, stderr }
}

const hasGit = async (): Promise<boolean> => {
  try {
    const p = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" })
    return (await p.exited) === 0
  } catch {
    return false
  }
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const e of it) if (e.type === "result") result = e.result
  if (result === undefined) throw new Error("tool yielded no result")
  return result
}

// ─── deterministic author LLM ────────────────────────────────────────────────

const AUTHORED_MESSAGE = "feat(compose): add diff→prose authoring\n\nWHY: closes the yeet gap."

class ScriptedLLM implements LLMPort {
  readonly model = "scripted-author"
  constructor(private readonly reply: string) {}
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: this.reply }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

let gitAvailable = false
let repoDir = ""

beforeAll(async () => {
  gitAvailable = await hasGit()
  if (!gitAvailable) return
  repoDir = await mkdtemp(join(tmpdir(), "git-compose-e2e-"))
  await git(repoDir, ["init", "-q"])
  await git(repoDir, ["checkout", "-q", "-b", "main"])
  await writeFile(join(repoDir, "seed.txt"), "seed\n")
  await git(repoDir, ["add", "seed.txt"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed"])
})

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true })
})

// ─── A. REAL e2e: author → commit ────────────────────────────────────────────

describe("git_compose_commit → git_commit (real git repo)", () => {
  test("environment probe — git available", () => {
    expect(gitAvailable).toBe(true)
  })

  test("stage → author message → git_commit lands the authored subject", async () => {
    if (!gitAvailable) return
    // Stage a real change.
    await writeFile(join(repoDir, "feature.ts"), "export const x = 1\n")
    await git(repoDir, ["add", "feature.ts"])

    // Author from the staged diff (ScriptedLLM is deterministic).
    const composeRes = await drain(
      gitComposeCommitTool(defaultGitRunner, new ScriptedLLM(AUTHORED_MESSAGE)).execute(
        {},
        ctx(repoDir),
      ),
    )
    expect(composeRes.ok).toBe(true)
    const authored = composeRes.output as string
    expect(authored).toContain("feat(compose): add diff→prose authoring")
    const structured = composeRes.structured as { conventional: boolean; type: string }
    expect(structured.conventional).toBe(true)
    expect(structured.type).toBe("feat")

    // Round-trip into git_commit regular mode — a REAL commit must result.
    const commitRes = await drain(
      gitCommitTool(defaultGitRunner).execute({ mode: "regular", message: authored }, ctx(repoDir)),
    )
    expect(commitRes.ok).toBe(true)

    // The authored subject is the new HEAD commit subject.
    const log = await git(repoDir, ["log", "--oneline", "-1"])
    expect(log.ok).toBe(true)
    expect(log.stdout).toContain("feat(compose): add diff→prose authoring")

    // The body landed too (full message in the commit object).
    const body = await git(repoDir, ["log", "-1", "--pretty=%B"])
    expect(body.stdout).toContain("WHY: closes the yeet gap.")
  })

  test("nothing staged ⇒ typed ok:false, NO commit created (clean tree)", async () => {
    if (!gitAvailable) return
    const before = await git(repoDir, ["rev-parse", "HEAD"])
    const res = await drain(
      gitComposeCommitTool(defaultGitRunner, new ScriptedLLM(AUTHORED_MESSAGE)).execute(
        {},
        ctx(repoDir),
      ),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("nothing staged")
    const after = await git(repoDir, ["rev-parse", "HEAD"])
    expect(after.stdout).toBe(before.stdout) // HEAD unchanged — authoring never commits
  })
})

// ─── B. ENV-FLIP REGISTRY (knob → features assembly) ─────────────────────────

const baseCfg = (): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: new ScriptedLLM("feat: x") as unknown as LLMPort,
  }) as AgentConfig

const flip = (env: NodeJS.ProcessEnv, surface: Surface): AgentConfig => {
  const knobs = knobsForSurface(surface)
  const values = resolveKnobs({ surface, knobs, envVars: env })
  return applyKnobs(baseCfg(), knobs, values, { surface })
}

describe("compose-authoring env-flip — buildSessionFeatures registry", () => {
  test("knob ABSENT ⇒ compose tools NOT registered (byte-identical extraTools)", async () => {
    const off = flip({}, "cli")
    const features = await buildSessionFeatures(off)
    const names = features.extraTools.map((t) => t.name)
    expect(names).not.toContain("git_compose_commit")
    expect(names).not.toContain("git_compose_pr")
  })

  test('QUANTA_COMPOSE_AUTHORING="1" ⇒ BOTH compose tools registered', async () => {
    const on = flip({ QUANTA_COMPOSE_AUTHORING: "1" }, "cli")
    const features = await buildSessionFeatures(on)
    const names = features.extraTools.map((t) => t.name)
    expect(names).toContain("git_compose_commit")
    expect(names).toContain("git_compose_pr")
  })
})
