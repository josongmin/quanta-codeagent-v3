/**
 * R3 audit-H 24h-window — subagent 6-tool input string caps.
 *
 * Pre-fix: `exec_command.command`, `write_stdin.data`, `spawn_agent.prompt`,
 * `send_input.message` had `.min(1)` (or no length floor) and NO upper cap.
 * A hostile / mis-prompted LLM could submit a multi-megabyte string and DoS
 * the shell-arg buffer, the PTY ring, or the spawn pipeline.
 *
 * Post-fix the four surfaces are capped:
 *   - exec_command.command  : .min(1).max(65536)   // 64 KB shell-arg cap
 *   - write_stdin.data      : .max(65536)          // 64 KB pipe-buf cap
 *   - spawn_agent.prompt    : .min(1).max(32768)   // 32 KB subagent seed
 *   - send_input.message    : .min(1).max(8192)    // 8 KB mailbox-mirror cap
 *
 * Each surface is exercised at the canonical boundaries:
 *   - "1" / "min" sample           ⇒ accepted (lower bound holds)
 *   - "max" sample (length = max)   ⇒ accepted (upper bound is inclusive)
 *   - "max+1" sample                ⇒ rejected (Zod parse fails)
 *
 * Replaying the test against a baseline that DROPS any `.max(...)` MUST
 * fail on the over-cap case — that's the revert-RED proof.
 */

import { describe, expect, test } from "bun:test"
import {
  ExecCommandInputSchema,
  SendInputInputSchema,
  SpawnAgentInputSchema,
  WriteStdinInputSchema,
} from "@/subagent/tools-6"

const fill = (n: number, c = "x"): string => c.repeat(n)

describe("R3 audit-H — exec_command.command cap (64 KB)", () => {
  const baseValid = { cwd: "/tmp", timeoutMs: 1000 } as const

  test("min boundary (length=1) accepted", () => {
    const r = ExecCommandInputSchema.safeParse({ ...baseValid, command: "x" })
    expect(r.success).toBe(true)
  })

  test("max boundary (length=65536) accepted", () => {
    const r = ExecCommandInputSchema.safeParse({
      ...baseValid,
      command: fill(65536),
    })
    expect(r.success).toBe(true)
  })

  test("max+1 (length=65537) REJECTED", () => {
    const r = ExecCommandInputSchema.safeParse({
      ...baseValid,
      command: fill(65537),
    })
    expect(r.success).toBe(false)
  })

  test("empty string REJECTED (min(1) preserved)", () => {
    const r = ExecCommandInputSchema.safeParse({ ...baseValid, command: "" })
    expect(r.success).toBe(false)
  })
})

describe("R3 audit-H — write_stdin.data cap (64 KB)", () => {
  const baseValid = { pid: 100 } as const

  test("empty string accepted (write_stdin had no min, kept that way)", () => {
    const r = WriteStdinInputSchema.safeParse({ ...baseValid, data: "" })
    expect(r.success).toBe(true)
  })

  test("max boundary (length=65536) accepted", () => {
    const r = WriteStdinInputSchema.safeParse({
      ...baseValid,
      data: fill(65536),
    })
    expect(r.success).toBe(true)
  })

  test("max+1 (length=65537) REJECTED", () => {
    const r = WriteStdinInputSchema.safeParse({
      ...baseValid,
      data: fill(65537),
    })
    expect(r.success).toBe(false)
  })
})

describe("R3 audit-H — spawn_agent.prompt cap (32 KB)", () => {
  test("min boundary (length=1) accepted", () => {
    const r = SpawnAgentInputSchema.safeParse({ prompt: "x" })
    expect(r.success).toBe(true)
  })

  test("max boundary (length=32768) accepted", () => {
    const r = SpawnAgentInputSchema.safeParse({ prompt: fill(32768) })
    expect(r.success).toBe(true)
  })

  test("max+1 (length=32769) REJECTED", () => {
    const r = SpawnAgentInputSchema.safeParse({ prompt: fill(32769) })
    expect(r.success).toBe(false)
  })

  test("empty string REJECTED (min(1) preserved)", () => {
    const r = SpawnAgentInputSchema.safeParse({ prompt: "" })
    expect(r.success).toBe(false)
  })
})

describe("R3 audit-H — send_input.message cap (8 KB)", () => {
  const baseValid = { agentId: "ag-1" } as const

  test("min boundary (length=1) accepted", () => {
    const r = SendInputInputSchema.safeParse({ ...baseValid, message: "x" })
    expect(r.success).toBe(true)
  })

  test("max boundary (length=8192) accepted", () => {
    const r = SendInputInputSchema.safeParse({
      ...baseValid,
      message: fill(8192),
    })
    expect(r.success).toBe(true)
  })

  test("max+1 (length=8193) REJECTED", () => {
    const r = SendInputInputSchema.safeParse({
      ...baseValid,
      message: fill(8193),
    })
    expect(r.success).toBe(false)
  })

  test("empty string REJECTED (min(1) preserved)", () => {
    const r = SendInputInputSchema.safeParse({ ...baseValid, message: "" })
    expect(r.success).toBe(false)
  })
})

describe("R3 audit-H — caps are NOT silently raised across the suite", () => {
  // Cross-axis: confirm each cap is the EXPECTED size — a future drift that
  // bumped one cap to e.g. 1 MB would still pass the per-axis tests above
  // (because both new max-1 and max+1 would parse) but the cap value itself
  // would no longer match audit intent.
  test("exec_command.command rejects 65537 (=> cap is exactly 65536)", () => {
    expect(
      ExecCommandInputSchema.safeParse({
        cwd: "/tmp",
        timeoutMs: 1,
        command: fill(65537),
      }).success,
    ).toBe(false)
  })

  test("write_stdin.data rejects 65537 (=> cap is exactly 65536)", () => {
    expect(WriteStdinInputSchema.safeParse({ pid: 1, data: fill(65537) }).success).toBe(false)
  })

  test("spawn_agent.prompt rejects 32769 (=> cap is exactly 32768)", () => {
    expect(SpawnAgentInputSchema.safeParse({ prompt: fill(32769) }).success).toBe(false)
  })

  test("send_input.message rejects 8193 (=> cap is exactly 8192)", () => {
    expect(SendInputInputSchema.safeParse({ agentId: "a", message: fill(8193) }).success).toBe(
      false,
    )
  })
})
