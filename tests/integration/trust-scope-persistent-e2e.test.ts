/**
 * E2E for trust-scope L3→L4 promotion: full path through `runAdmissibilityGate`
 * with a PERSISTENT TrustScopeRegistry (file-backed). Two adversarial flows:
 *
 *   E-1   First call asks → user approves → grant persisted → SECOND identical
 *         call auto-passes (ask-skip via trust-scope short-circuit).
 *   E-2   Persistent store survives a "process boundary": after `flush()` a
 *         freshly-constructed registry hydrated from the same files satisfies
 *         hasGrant for the prior grant, and the gate observably short-circuits.
 *   E-3   `extractShellCommand`-derived actionKey is what the gate uses, so a
 *         per-command grant (`bash|git status`) matches the live call but a
 *         DIFFERENT command (`bash|rm -rf`) still routes through onConfirm.
 *
 *  These are integration tests because they touch the filesystem (tmp dir),
 *  exercise the JsonStateFile engine, and run the gate end-to-end with a real
 *  ToolRegistry + extractShellCommand path.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import { createPersistentTrustScopeRegistry, type PermissionContext } from "@/permission"
import { type Tool, ToolRegistry } from "@/tool"

const bashShell: Tool = {
  name: "bash",
  description: "shell tool",
  inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  extractShellCommand: (input: unknown) => {
    const parsed = input as { command?: unknown }
    return typeof parsed?.command === "string" ? parsed.command : null
  },
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
}

const mkCfg = (
  registry: ToolRegistry,
  trustScope: AgentConfig["trustScope"],
  onConfirm: AgentConfig["onConfirm"],
): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: { mode: "default" } as PermissionContext,
    registry,
    onConfirm,
    trustScope,
  }) as AgentConfig

const call = (command: string, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "bash",
  input: { command },
})

const action = (command: string) => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
})

describe("trust-scope L4 — E2E with persistent registry", () => {
  test("E-1: user approves once → grant persisted → SECOND call auto-passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-trust-scope-e2e-"))
    try {
      const file = join(dir, "grants.json")
      const reg = createPersistentTrustScopeRegistry({ filePath: file, debounceMs: 0 })
      await reg.hydrate()

      const toolReg = new ToolRegistry([bashShell])
      let onConfirmCalls = 0
      // First turn: onConfirm approves AND the host writes a per-action grant.
      const cfg1 = mkCfg(toolReg, { registry: reg, projectKey: "/repo" }, async (a) => {
        onConfirmCalls += 1
        // Host extracts the same command the gate sees, persists a project-scoped grant.
        const command = (a.input as { command?: string }).command ?? ""
        reg.grant("/repo", {
          tool: a.tool,
          scope: "project",
          actionKey: `${a.tool}|${command}`,
        })
        return true
      })
      const r1 = await runAdmissibilityGate(
        call("git status"),
        cfg1,
        { mode: "default" },
        action("git status"),
      )
      expect(onConfirmCalls).toBe(1)
      expect(r1).toBeNull() // admitted

      // Second turn: identical call, onConfirm MUST NOT be invoked.
      const r2 = await runAdmissibilityGate(
        call("git status", "c2"),
        cfg1,
        { mode: "default" },
        action("git status"),
      )
      expect(onConfirmCalls).toBe(1) // still 1 — ask-skipped
      expect(r2).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("E-2: persistent store survives process boundary (flush → new instance → hydrate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-trust-scope-e2e-"))
    try {
      const file = join(dir, "grants.json")
      const reg1 = createPersistentTrustScopeRegistry({ filePath: file, debounceMs: 0 })
      await reg1.hydrate()
      reg1.grant("/repo", { tool: "bash", scope: "project", actionKey: "bash|pytest -q" })
      await reg1.flush()

      // Simulate a process restart: drop reg1, build reg2 over the same file.
      const reg2 = createPersistentTrustScopeRegistry({ filePath: file, debounceMs: 0 })
      await reg2.hydrate()

      const registry = new ToolRegistry([bashShell])
      let onConfirmCalls = 0
      const cfg = mkCfg(registry, { registry: reg2, projectKey: "/repo" }, async () => {
        onConfirmCalls += 1
        return false // would have denied — proves the gate took the short-circuit
      })
      const r = await runAdmissibilityGate(
        call("pytest -q"),
        cfg,
        { mode: "default" },
        action("pytest -q"),
      )
      expect(onConfirmCalls).toBe(0)
      expect(r).toBeNull() // admitted via persistent grant
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("E-3: per-command grant is keyed via extractShellCommand — different command still asks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-trust-scope-e2e-"))
    try {
      const file = join(dir, "grants.json")
      const reg = createPersistentTrustScopeRegistry({ filePath: file, debounceMs: 0 })
      await reg.hydrate()
      reg.grant("/repo", { tool: "bash", scope: "project", actionKey: "bash|git status" })

      const registry = new ToolRegistry([bashShell])
      let onConfirmCalls = 0
      const cfg = mkCfg(registry, { registry: reg, projectKey: "/repo" }, async () => {
        onConfirmCalls += 1
        return false
      })
      // Granted command → ask-skipped.
      const r1 = await runAdmissibilityGate(
        call("git status"),
        cfg,
        { mode: "default" },
        action("git status"),
      )
      expect(onConfirmCalls).toBe(0)
      expect(r1).toBeNull()

      // Different command → onConfirm fires, returns false ⇒ deny.
      const r2 = await runAdmissibilityGate(
        call("rm -rf /tmp", "c2"),
        cfg,
        { mode: "default" },
        action("rm -rf /tmp"),
      )
      expect(onConfirmCalls).toBe(1)
      expect(r2?.preview).toBe("declined")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
