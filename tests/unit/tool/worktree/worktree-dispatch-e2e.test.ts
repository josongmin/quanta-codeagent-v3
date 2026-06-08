/**
 * ticket-11 (P8) — DISPATCH E2E + manifest drift-guard.
 *
 * Proves the worktree seams flow through the REAL `dispatchTool` pipeline:
 *   - `enter_worktree` via dispatch SETS the session slot; a subsequent `bash`
 *     via dispatch spawns INSIDE the worktree (the dispatch seam projected the
 *     slot's current value onto `ToolContext.activeWorktree`); `exit_worktree`
 *     CLEARS the slot and bash cwd is restored.
 *   - DEFAULT-OFF: no `activeWorktreeSlot` on the config ⇒ the worktree tools are
 *     NOT registered and `bash` cwd is the session cwd (byte-identical).
 *   - manifest drift-guard ×3: each worktree tool name is catalogued in the
 *     GATED manifest under one shared config-slot gate.
 *
 * Real `git` + real tmpdir repo (the tools are thin over `@/runtime`).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentConfig } from "@/agent"
import { createWorktreeSlot } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildSessionFeatures } from "@/agent/features"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { ALL_MANIFEST_TOOL_NAMES, buildDefaultTools, GATED_TOOLS, ToolRegistry } from "@/tool"
import { bashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { worktreeTools } from "@/tool/worktree"

const repos: string[] = []
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "wt-disp-"))
  repos.push(dir)
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir })
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "t@t.t"])
  git(["config", "user.name", "t"])
  execFileSync("bash", ["-lc", "echo seed > seed.txt"], { cwd: dir })
  git(["add", "."])
  git(["commit", "-q", "-m", "seed"])
  return dir
}

const perm: PermissionContext = { mode: "acceptEdits" }

const cfg = (repo: string, slot?: AgentConfig["activeWorktreeSlot"]): AgentConfig =>
  ({
    registry: new ToolRegistry([bashTool, editTool, ...(slot !== undefined ? worktreeTools : [])]),
    cwd: repo,
    signal: new AbortController().signal,
    permission: perm,
    // bash/enter/exit are mutating; approve the HITL prompt so the e2e exercises
    // the WORKTREE wiring rather than tripping on the permission gate.
    onConfirm: async () => true,
    ...(slot !== undefined ? { activeWorktreeSlot: slot } : {}),
  }) as unknown as AgentConfig

const tu = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `c-${name}-${Math.random().toString(36).slice(2)}`,
  name,
  input: input as Record<string, unknown>,
})

afterAll(async () => {
  for (const d of repos) await rm(d, { recursive: true, force: true }).catch(() => undefined)
})

describe("dispatch E2E — enter → bash(cwd=worktree) → exit → restored", () => {
  test("full lifecycle through the real dispatchTool", async () => {
    const repo = await makeRepo()
    const slot = createWorktreeSlot({ repoRoot: repo, sessionCwd: repo })
    const config = cfg(repo, slot)

    // 1. enter → slot set
    const enter = await dispatchTool(tu("enter_worktree", {}), config, perm)
    expect(enter.ok).toBe(true)
    const wtPath = slot.current()?.worktreePath ?? ""
    expect(existsSync(wtPath)).toBe(true)

    // 2. bash via dispatch → spawns INSIDE the worktree (dispatch projected the
    //    slot value onto ctx.activeWorktree). pwd prints the worktree path.
    const inWt = await dispatchTool(tu("bash", { command: "pwd" }), config, perm)
    expect(inWt.ok).toBe(true)
    if (inWt.ok) expect(inWt.block.content).toContain(wtPath)

    // 3. exit → slot cleared, worktree removed
    const exit = await dispatchTool(tu("exit_worktree", {}), config, perm)
    expect(exit.ok).toBe(true)
    expect(slot.current()).toBeUndefined()
    expect(existsSync(wtPath)).toBe(false)

    // 4. bash via dispatch again → cwd RESTORED to the session repo
    const restored = await dispatchTool(tu("bash", { command: "pwd" }), config, perm)
    expect(restored.ok).toBe(true)
    if (restored.ok) {
      expect(restored.block.content).toContain(repo)
      expect(restored.block.content).not.toContain(wtPath)
    }
  })
})

describe("DEFAULT-OFF — no slot ⇒ tools unregistered + bash cwd byte-identical", () => {
  test("buildSessionFeatures omits the worktree tools without a slot", async () => {
    const repo = await makeRepo()
    const features = await buildSessionFeatures(cfg(repo))
    const names = features.extraTools.map((t) => t.name)
    expect(names).not.toContain("enter_worktree")
    expect(names).not.toContain("exit_worktree")
    expect(names).not.toContain("worktree_status")
  })

  test("buildSessionFeatures INCLUDES the worktree tools WITH a slot", async () => {
    const repo = await makeRepo()
    const slot = createWorktreeSlot({ repoRoot: repo, sessionCwd: repo })
    const features = await buildSessionFeatures(cfg(repo, slot))
    const names = features.extraTools.map((t) => t.name)
    expect(names).toContain("enter_worktree")
    expect(names).toContain("exit_worktree")
    expect(names).toContain("worktree_status")
  })

  test("no-slot bash via dispatch spawns in the session cwd (byte-identical)", async () => {
    const repo = await makeRepo()
    const config = cfg(repo) // no slot
    const r = await dispatchTool(tu("bash", { command: "pwd" }), config, perm)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.block.content).toContain(repo)
  })
})

describe("manifest drift-guard ×3 — worktree tools catalogued", () => {
  test("all 3 worktree tool names are in the GATED manifest universe", () => {
    for (const name of ["enter_worktree", "exit_worktree", "worktree_status"]) {
      expect(ALL_MANIFEST_TOOL_NAMES).toContain(name)
    }
  })

  test("the worktree group shares ONE config-slot gate (QUANTA_WORKTREE_TOOL)", () => {
    const entry = GATED_TOOLS.find((e) => e.name === "enter_worktree")
    expect(entry).toBeDefined()
    expect(entry?.gate.kind).toBe("config-slot")
    if (entry?.gate.kind === "config-slot") {
      expect(entry.gate.env).toBe("QUANTA_WORKTREE_TOOL")
      expect(entry.gate.slot).toBe("AgentConfig.activeWorktreeSlot")
    }
    expect(entry?.group).toEqual(["exit_worktree", "worktree_status"])
  })

  test("the worktree tools are NOT in the BASE always-on set (default-OFF)", () => {
    const base = buildDefaultTools().map((t) => t.name)
    expect(base).not.toContain("enter_worktree")
    expect(base).not.toContain("exit_worktree")
    expect(base).not.toContain("worktree_status")
  })
})
