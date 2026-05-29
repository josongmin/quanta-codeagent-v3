/**
 * R4 audit-M — subagent 6-tool `exec_command.env` overlay caps.
 *
 * Pre-fix: `env: z.record(z.string(), z.string()).optional()` had no key
 * length cap, no value length cap, and no entry-count cap. A hostile or
 * mis-prompted LLM could ship a multi-megabyte env block that survives zod
 * parse and triggers `E2BIG` deep inside the kernel after the dispatcher
 * has paid the allocation cost — a DoS surface mirroring the `command`/
 * `data`/`prompt` caps already pinned in `subagent-tools6-input-cap-
 * hellgate.test.ts`.
 *
 * Post-fix the env overlay is:
 *   - key   : z.string().min(1).max(256)
 *   - value : z.string().max(8192)        // 8 KB — mirrors send_input cap
 *   - count : .refine(env => Object.keys(env).length <= 64)
 *
 * Each axis is exercised at the canonical boundaries:
 *   (1) absent (.optional) still accepted
 *   (2) 64 entries PASSES; 65 REJECTS
 *   (3) key length 256 PASSES; 257 REJECTS
 *   (4) value length 8192 PASSES; 8193 REJECTS
 *   (5) empty key REJECTS (min 1) — prevents `{"":""}` synthetic spray
 *   (6) under-cap mixed env (size 3) PASSES — happy path / regression net
 *
 * Replaying against a pre-fix tree (record without refine + caps) MUST flip
 * (2) (3) (4) (5) RED — that's the revert proof.
 */

import { describe, expect, test } from "bun:test"
import { ExecCommandInputSchema } from "@/subagent/tools-6"

const baseValid = { command: "echo hi", cwd: "/tmp", timeoutMs: 1000 } as const
const fill = (n: number, c = "x"): string => c.repeat(n)

describe("R4 audit-M — exec_command.env overlay caps", () => {
  test("(1) env absent — accepted (overlay is optional)", () => {
    expect(ExecCommandInputSchema.safeParse({ ...baseValid }).success).toBe(true)
  })

  test("(2) 64 entries PASSES; 65 REJECTS", () => {
    const env64: Record<string, string> = {}
    for (let i = 0; i < 64; i++) env64[`KEY_${i}`] = "v"
    expect(ExecCommandInputSchema.safeParse({ ...baseValid, env: env64 }).success).toBe(true)

    const env65: Record<string, string> = { ...env64, KEY_64: "v" }
    expect(ExecCommandInputSchema.safeParse({ ...baseValid, env: env65 }).success).toBe(false)
  })

  test("(3) key length 256 PASSES; 257 REJECTS", () => {
    expect(
      ExecCommandInputSchema.safeParse({ ...baseValid, env: { [fill(256, "K")]: "v" } }).success,
    ).toBe(true)
    expect(
      ExecCommandInputSchema.safeParse({ ...baseValid, env: { [fill(257, "K")]: "v" } }).success,
    ).toBe(false)
  })

  test("(4) value length 8192 PASSES; 8193 REJECTS", () => {
    expect(ExecCommandInputSchema.safeParse({ ...baseValid, env: { K: fill(8192) } }).success).toBe(
      true,
    )
    expect(ExecCommandInputSchema.safeParse({ ...baseValid, env: { K: fill(8193) } }).success).toBe(
      false,
    )
  })

  test('(5) empty key REJECTS (min(1) blocks `{"":"v"}` synthetic spray)', () => {
    expect(ExecCommandInputSchema.safeParse({ ...baseValid, env: { "": "v" } }).success).toBe(false)
  })

  test("(6) realistic under-cap overlay (3 entries, normal sizes) PASSES", () => {
    expect(
      ExecCommandInputSchema.safeParse({
        ...baseValid,
        env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", DEBUG: "agent:*" },
      }).success,
    ).toBe(true)
  })
})
