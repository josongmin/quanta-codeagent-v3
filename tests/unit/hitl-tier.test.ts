/* Codex HITL 4-tier gate (hitl-audit.md absorption). Covers:
 *   - inferToolTier defaults from isReadOnly() when hitlTier() absent.
 *   - bash hitlTier(): network egress + mutating-git ⇒ always-confirm;
 *     other commands ⇒ pre-approval-ok.
 *   - HARD_DENY routes through dispatch as "Action requires human handoff…".
 *   - always-confirm cannot be skipped by `acceptEdits`/`bypass` mode.
 *   - hitl.enabled absent ⇒ legacy behaviour preserved (byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import { inferToolTier, type PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import { bashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { readTool } from "@/tool/read"
import { writeTool } from "@/tool/write"

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

describe("inferToolTier", () => {
  test("read tool (read-only, no explicit hitlTier) ⇒ none", () => {
    expect(inferToolTier(readTool, { path: "x.ts" })).toBe("none")
  })

  test("write tool (mutating, no explicit hitlTier) ⇒ pre-approval-ok", () => {
    expect(inferToolTier(writeTool, { path: "x.ts", content: "y" })).toBe("pre-approval-ok")
  })

  test("edit tool (mutating, no explicit hitlTier) ⇒ pre-approval-ok", () => {
    expect(inferToolTier(editTool, { path: "x.ts", old_string: "a", new_string: "b" })).toBe(
      "pre-approval-ok",
    )
  })

  test("bash with `git push origin main` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git push origin main" })).toBe("always-confirm")
  })

  test("bash with `git push` (no remote) ⇒ always-confirm (mutating git egress)", () => {
    expect(inferToolTier(bashTool, { command: "git push" })).toBe("always-confirm")
  })

  test("bash with `curl https://x` ⇒ always-confirm (network egress)", () => {
    expect(inferToolTier(bashTool, { command: "curl https://example.com" })).toBe("always-confirm")
  })

  test("bash with `wget https://x` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "wget https://example.com/file" })).toBe(
      "always-confirm",
    )
  })

  test("bash with `gh api repos/foo/bar` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "gh api repos/foo/bar" })).toBe("always-confirm")
  })

  test("bash with `git commit --amend` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git commit --amend -m fix" })).toBe("always-confirm")
  })

  test("bash with `git reset --hard HEAD~1` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git reset --hard HEAD~1" })).toBe("always-confirm")
  })

  test("bash with `git fetch origin` ⇒ always-confirm", () => {
    expect(inferToolTier(bashTool, { command: "git fetch origin main" })).toBe("always-confirm")
  })

  test("bash with `ls -la` ⇒ pre-approval-ok (default)", () => {
    expect(inferToolTier(bashTool, { command: "ls -la" })).toBe("pre-approval-ok")
  })

  test("bash with `git status` ⇒ pre-approval-ok (read-only git)", () => {
    expect(inferToolTier(bashTool, { command: "git status" })).toBe("pre-approval-ok")
  })

  test("bash with `bun test` ⇒ pre-approval-ok", () => {
    expect(inferToolTier(bashTool, { command: "bun test" })).toBe("pre-approval-ok")
  })

  test("explicit hitlTier() wins over isReadOnly() inference", () => {
    const t = makeTool("custom", {
      readOnly: true,
      run: async function* () {
        yield { type: "result", result: { ok: true, output: "" } }
      },
      hitlTier: () => "always-confirm",
    })
    expect(inferToolTier(t, {})).toBe("always-confirm")
  })
})

describe("dispatchTool HITL gate (config.hitl.enabled=true)", () => {
  const mutate = makeTool("mutate", {
    readOnly: false,
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
        cwd: "/Users/songmin/quanta-codeagent-v3",
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
