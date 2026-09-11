/* Codex HITL 4-tier gate — dispatch half of `hitl-tier.test.ts`.
 * Covers `dispatchTool`'s HITL behaviour:
 *   - HARD_DENY routes through dispatch as "Action requires human handoff…".
 *   - always-confirm cannot be skipped by `acceptEdits`/`bypass` mode.
 *   - hand-off-required denies even in bypass.
 *   - none / pre-approval-ok tiers defer to existing mode policy.
 *   - hitl.enabled absent ⇒ legacy behaviour preserved (byte-identical).
 * Classifier-level coverage of `inferToolTier` and bash hitlTier() lives in
 * `hitl-tier-classifier.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import { bashTool } from "@/tool/bash"
import { readTool } from "@/tool/read"
import { REPO_ROOT } from "../_helpers/repo-root"

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    run: () => AsyncIterable<ToolEvent>
    hitlTier?: (
      input: unknown,
    ) => "hand-off-required" | "always-confirm" | "pre-approval-ok" | "none"
  },
): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
  isReadOnly: () => opts.readOnly ?? false,
  isConcurrencySafe: () => opts.readOnly ?? false,
  execute: () => opts.run(),
  ...(opts.hitlTier ? { hitlTier: opts.hitlTier } : {}),
})

const call = (name: string, input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const baseConfig = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

describe("dispatchTool HITL gate (config.hitl.enabled=true)", () => {
  const mutate = makeTool("mutate", {
    readOnly: false,
    // CR3 follow-up: the inferToolTier fallback for a mutating tool is now
    // `always-confirm` (secure-by-default). A test fixture that wants to
    // exercise the `pre-approval-ok` path must declare it explicitly — same
    // contract every real tool (write/edit/test_runner/scripted_replace)
    // satisfies.
    hitlTier: () => "pre-approval-ok",
    run: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  })

  test("bash HARD_DENY command → handoff deny (mentions 'human handoff')", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "should not run" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "rm -rf /" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
      }),
      { mode: "bypass" },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("handoff")
    expect(res.block.content).toContain("human handoff")
    expect(res.block.content).toContain("Agent cannot proceed without explicit human takeover")
  })

  test("HARD_DENY beats `bypass` mode even with HITL enabled", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "should not run" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "rm -rf /" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
      }),
      { mode: "bypass" },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("handoff")
  })

  test("always-confirm bash (`git push`) under `bypass` STILL calls onConfirm", async () => {
    let confirmed = 0
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      hitlTier: bashTool.hitlTier as (i: unknown) => "always-confirm" | "pre-approval-ok",
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "pushed" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "git push origin main" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
        onConfirm: async () => {
          confirmed++
          return true
        },
      }),
      { mode: "bypass" },
    )
    expect(confirmed).toBe(1)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("pushed")
  })

  test("always-confirm under `acceptEdits` STILL calls onConfirm", async () => {
    let confirmed = 0
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      hitlTier: bashTool.hitlTier as (i: unknown) => "always-confirm" | "pre-approval-ok",
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "fetched" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "git fetch origin main" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "acceptEdits" } as PermissionContext,
        onConfirm: async () => {
          confirmed++
          return true
        },
      }),
      { mode: "acceptEdits" },
    )
    expect(confirmed).toBe(1)
    expect(res.ok).toBe(true)
  })

  test("always-confirm declined → declined result, tool not executed", async () => {
    let executed = false
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      hitlTier: bashTool.hitlTier as (i: unknown) => "always-confirm" | "pre-approval-ok",
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "pushed" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "git push origin main" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
        onConfirm: async () => false,
      }),
      { mode: "bypass" },
    )
    expect(executed).toBe(false)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("declined")
    expect(res.block.content).toContain("always-confirm")
  })

  test("always-confirm with NO onConfirm wired → denied", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      hitlTier: bashTool.hitlTier as (i: unknown) => "always-confirm" | "pre-approval-ok",
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "git push origin main" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
      }),
      { mode: "bypass" },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("denied")
    expect(res.block.content).toContain("always-confirm")
  })

  test("hand-off-required tier (explicit on tool) denies even in bypass", async () => {
    let executed = false
    const sensitive = makeTool("sensitive", {
      readOnly: false,
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "ran" } }
      },
      hitlTier: () => "hand-off-required",
    })
    const res = await dispatchTool(
      call("sensitive", {}),
      baseConfig({
        registry: new ToolRegistry([sensitive]),
        hitl: { enabled: true },
        permission: { mode: "bypass" } as PermissionContext,
        onConfirm: async () => true,
      }),
      { mode: "bypass" },
    )
    expect(executed).toBe(false)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("handoff")
    expect(res.block.content).toContain("human handoff")
  })

  test("none tier (read-only) allows without invoking onConfirm", async () => {
    let confirmed = 0
    const res = await dispatchTool(
      call("read", { path: "package.json" }),
      baseConfig({
        registry: new ToolRegistry([readTool as Tool]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
        // A REAL cwd: this case drives the production `readTool` against
        // `package.json`, so the path is resolved and read. Measured: with a
        // foreign prefix here the case goes RED (`res.ok` false), so the
        // previous hard-coded checkout path made this test pass on exactly one
        // machine. Resolved from this file's location instead.
        cwd: REPO_ROOT,
        onConfirm: async () => {
          confirmed++
          return true
        },
      }),
      { mode: "default" },
    )
    expect(confirmed).toBe(0)
    expect(res.ok).toBe(true)
  })

  test("pre-approval-ok defers to existing mode policy (acceptEdits allows)", async () => {
    const res = await dispatchTool(
      call("mutate", {}),
      baseConfig({
        registry: new ToolRegistry([mutate]),
        hitl: { enabled: true },
        permission: { mode: "acceptEdits" } as PermissionContext,
      }),
      { mode: "acceptEdits" },
    )
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("ran")
  })

  test("pre-approval-ok defers to existing mode policy (default asks)", async () => {
    let asked = 0
    const res = await dispatchTool(
      call("mutate", {}),
      baseConfig({
        registry: new ToolRegistry([mutate]),
        hitl: { enabled: true },
        permission: { mode: "default" } as PermissionContext,
        onConfirm: async () => {
          asked++
          return true
        },
      }),
      { mode: "default" },
    )
    expect(asked).toBe(1)
    expect(res.ok).toBe(true)
  })
})

describe("dispatchTool legacy behavior (hitl absent)", () => {
  test("hitl undefined ⇒ HARD_DENY uses legacy 'Permission denied' wording (NOT 'human handoff')", async () => {
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "should not run" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "rm -rf /" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        permission: { mode: "acceptEdits" } as PermissionContext,
        // hitl intentionally absent
      }),
      { mode: "acceptEdits" },
    )
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("denied")
    expect(res.block.content).toContain("Permission denied")
    expect(res.block.content).not.toContain("human handoff")
  })

  test("hitl undefined ⇒ `git push` in bypass mode runs WITHOUT confirm (legacy)", async () => {
    let confirmed = 0
    let executed = false
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      hitlTier: bashTool.hitlTier as (i: unknown) => "always-confirm" | "pre-approval-ok",
      run: async function* () {
        executed = true
        yield { type: "result", result: { ok: true, output: "pushed" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "git push origin main" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        permission: { mode: "bypass" } as PermissionContext,
        onConfirm: async () => {
          confirmed++
          return true
        },
        // hitl intentionally absent ⇒ legacy single-tier
      }),
      { mode: "bypass" },
    )
    expect(confirmed).toBe(0)
    expect(executed).toBe(true)
    expect(res.ok).toBe(true)
  })

  test("hitl.enabled=false ⇒ legacy behavior (same as absent)", async () => {
    let confirmed = 0
    const bash = makeTool("bash", {
      readOnly: false,
      schema: z.object({ command: z.string() }),
      hitlTier: bashTool.hitlTier as (i: unknown) => "always-confirm" | "pre-approval-ok",
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "pushed" } }
      },
    })
    const res = await dispatchTool(
      call("bash", { command: "git push origin main" }),
      baseConfig({
        registry: new ToolRegistry([bash]),
        permission: { mode: "bypass" } as PermissionContext,
        hitl: { enabled: false },
        onConfirm: async () => {
          confirmed++
          return true
        },
      }),
      { mode: "bypass" },
    )
    expect(confirmed).toBe(0)
    expect(res.ok).toBe(true)
  })
})
