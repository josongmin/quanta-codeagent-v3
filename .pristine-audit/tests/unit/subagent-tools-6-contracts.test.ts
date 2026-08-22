/**
 * Subagent 6-tool contract tests (Cluster E / F15, ADR-0041).
 *
 * Per-tool: ≥ 4 schema round-trip cases (1 positive + 3 negative).
 * Cross-tool: name uniqueness; every output schema is a `success|error`
 * discriminated union.
 */
import { describe, expect, test } from "bun:test"
import {
  CloseAgentInputSchema,
  CloseAgentOutputSchema,
  ExecCommandInputSchema,
  ExecCommandOutputSchema,
  SendInputInputSchema,
  SendInputOutputSchema,
  SpawnAgentInputSchema,
  SpawnAgentOutputSchema,
  SUBAGENT_6_TOOL_CONTRACTS,
  SUBAGENT_6_TOOL_NAMES,
  WaitAgentInputSchema,
  WaitAgentOutputSchema,
  WriteStdinInputSchema,
  WriteStdinOutputSchema,
} from "../../src/subagent/tools-6"

describe("SUBAGENT_6_TOOL_NAMES — closed set", () => {
  test("contains exactly 6 unique tool names", () => {
    expect(SUBAGENT_6_TOOL_NAMES.length).toBe(6)
    expect(new Set(SUBAGENT_6_TOOL_NAMES).size).toBe(6)
  })

  test("contract table is keyed identically to the names list", () => {
    expect(Object.keys(SUBAGENT_6_TOOL_CONTRACTS).sort()).toEqual([...SUBAGENT_6_TOOL_NAMES].sort())
  })

  test("each contract has a non-empty semantics blurb", () => {
    for (const c of Object.values(SUBAGENT_6_TOOL_CONTRACTS)) {
      expect(c.semantics.length).toBeGreaterThan(0)
    }
  })

  test("each output schema accepts both success AND error shapes", () => {
    // Round-trip a generic error through every output schema.
    const err = { kind: "error", message: "x", cause: "timeout" }
    for (const c of Object.values(SUBAGENT_6_TOOL_CONTRACTS)) {
      expect(c.outputSchema.safeParse(err).success).toBe(true)
    }
  })
})

describe("exec_command", () => {
  test("accepts a valid input (one-shot)", () => {
    const r = ExecCommandInputSchema.safeParse({
      command: "ls -la",
      cwd: "/tmp",
      timeoutMs: 5000,
    })
    expect(r.success).toBe(true)
  })

  test("accepts a valid input (with pty)", () => {
    const r = ExecCommandInputSchema.safeParse({
      command: "python",
      cwd: "/tmp",
      timeoutMs: 60000,
      pty: true,
      env: { PYTHONUNBUFFERED: "1" },
    })
    expect(r.success).toBe(true)
  })

  test("rejects timeoutMs = 0", () => {
    expect(
      ExecCommandInputSchema.safeParse({ command: "x", cwd: "/tmp", timeoutMs: 0 }).success,
    ).toBe(false)
  })

  test("rejects missing cwd", () => {
    expect(
      ExecCommandInputSchema.safeParse({
        command: "x",
        timeoutMs: 5,
      } as unknown as { command: string; cwd: string; timeoutMs: number }).success,
    ).toBe(false)
  })

  test("rejects extra key (strict)", () => {
    expect(
      ExecCommandInputSchema.safeParse({
        command: "x",
        cwd: "/tmp",
        timeoutMs: 5,
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test("success output round-trips", () => {
    const r = ExecCommandOutputSchema.safeParse({
      kind: "success",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    })
    expect(r.success).toBe(true)
  })

  test("success output rejects negative exit code? — int OK; non-int rejected", () => {
    expect(
      ExecCommandOutputSchema.safeParse({
        kind: "success",
        exitCode: 1.5,
        stdout: "",
        stderr: "",
      }).success,
    ).toBe(false)
  })
})

describe("write_stdin", () => {
  test("accepts minimal input", () => {
    const r = WriteStdinInputSchema.safeParse({ pid: 1234, data: "hello\n" })
    expect(r.success).toBe(true)
  })
  test("rejects pid = 0", () => {
    expect(WriteStdinInputSchema.safeParse({ pid: 0, data: "x" }).success).toBe(false)
  })
  test("rejects negative pid", () => {
    expect(WriteStdinInputSchema.safeParse({ pid: -1, data: "x" }).success).toBe(false)
  })
  test("rejects extra key", () => {
    expect(WriteStdinInputSchema.safeParse({ pid: 1, data: "x", other: true }).success).toBe(false)
  })
  test("success output round-trip", () => {
    const r = WriteStdinOutputSchema.safeParse({ kind: "success", bytesWritten: 5 })
    expect(r.success).toBe(true)
  })
})

describe("spawn_agent", () => {
  test("accepts a minimal valid input", () => {
    const r = SpawnAgentInputSchema.safeParse({ prompt: "do x" })
    expect(r.success).toBe(true)
  })
  test("accepts with explicit tool_filter (snake_case parity with the agent tool)", () => {
    const r = SpawnAgentInputSchema.safeParse({
      prompt: "do x",
      agent_type: "Explore",
      tool_filter: ["Read", "Grep"],
      max_depth: 3,
      isolation: "worktree",
      owned_surfaces: ["src/core/"],
      task_kind: "edit",
    })
    expect(r.success).toBe(true)
  })
  test("rejects camelCase field (strict: must use snake_case)", () => {
    expect(SpawnAgentInputSchema.safeParse({ prompt: "x", toolFilter: ["Read"] }).success).toBe(
      false,
    )
  })
  test("rejects empty prompt", () => {
    expect(SpawnAgentInputSchema.safeParse({ prompt: "" }).success).toBe(false)
  })
  test("rejects empty tool_filter element", () => {
    expect(SpawnAgentInputSchema.safeParse({ prompt: "x", tool_filter: [""] }).success).toBe(false)
  })
  test("success output requires non-empty agentId", () => {
    expect(SpawnAgentOutputSchema.safeParse({ kind: "success", agentId: "" }).success).toBe(false)
  })
  test("success output accepts agent_<uuid>", () => {
    expect(
      SpawnAgentOutputSchema.safeParse({ kind: "success", agentId: "agent_abc" }).success,
    ).toBe(true)
  })
})

describe("wait_agent", () => {
  test("accepts minimal input", () => {
    expect(WaitAgentInputSchema.safeParse({ agentId: "agent_1" }).success).toBe(true)
  })
  test("accepts with optional timeoutMs", () => {
    expect(WaitAgentInputSchema.safeParse({ agentId: "agent_1", timeoutMs: 1000 }).success).toBe(
      true,
    )
  })
  test("rejects timeoutMs <= 0", () => {
    expect(WaitAgentInputSchema.safeParse({ agentId: "agent_1", timeoutMs: 0 }).success).toBe(false)
  })
  test("rejects extra key", () => {
    expect(WaitAgentInputSchema.safeParse({ agentId: "x", extra: 1 }).success).toBe(false)
  })
  test("success output accepts each terminal status", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const r = WaitAgentOutputSchema.safeParse({
        kind: "success",
        status,
        finalText: "ok",
        turns: 2,
      })
      expect(r.success).toBe(true)
    }
  })
})

describe("close_agent", () => {
  test("accepts a valid input", () => {
    expect(CloseAgentInputSchema.safeParse({ agentId: "agent_1" }).success).toBe(true)
  })
  test("rejects empty agentId", () => {
    expect(CloseAgentInputSchema.safeParse({ agentId: "" }).success).toBe(false)
  })
  test("rejects extra key", () => {
    expect(CloseAgentInputSchema.safeParse({ agentId: "x", y: 1 }).success).toBe(false)
  })
  test("success output round-trip", () => {
    expect(CloseAgentOutputSchema.safeParse({ kind: "success", wasRunning: true }).success).toBe(
      true,
    )
  })
})

describe("send_input", () => {
  test("accepts a valid input", () => {
    expect(SendInputInputSchema.safeParse({ agentId: "agent_1", message: "go" }).success).toBe(true)
  })
  test("rejects empty message", () => {
    expect(SendInputInputSchema.safeParse({ agentId: "agent_1", message: "" }).success).toBe(false)
  })
  test("rejects extra key", () => {
    expect(SendInputInputSchema.safeParse({ agentId: "x", message: "go", z: 1 }).success).toBe(
      false,
    )
  })
  test("success output requires delivered:true literal", () => {
    expect(SendInputOutputSchema.safeParse({ kind: "success", delivered: false }).success).toBe(
      false,
    )
    expect(SendInputOutputSchema.safeParse({ kind: "success", delivered: true }).success).toBe(true)
  })
})
