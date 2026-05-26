/**
 * Unit tests for the `session_config` self-inspection tool.
 *
 * Coverage:
 *   - `op:get` renders effort + optional fields (mode / profile / model / provider).
 *   - `op:get` skips absent optional readers gracefully.
 *   - `op:set_effort` mutates the seam and reports the prev → next transition.
 *   - `op:set_effort` no-op message when prev === next.
 *   - Unwired seam (ctx.sessionConfig undefined) ⇒ typed `not_wired` failure
 *     for BOTH ops (read AND write must remain visible to the model).
 *   - Pre-call abort returns `aborted` failure (mirrors prompt_cache_status).
 *   - Reader throws → `error` failure with message.
 *   - Writer throws → `error` failure (and the seam read is unchanged
 *     since we re-read post-write).
 *   - Effort-tier parity with `@/agent/effort#EFFORT_LEVELS` (so the closed
 *     enum here stays in sync if the agent slice extends it).
 *   - The tool's MUTATING_TOOL_TABLE classification stays `null`
 *     (read-only-permissive) so plan-mode dispatch keeps allowing it.
 */

import { describe, expect, test } from "bun:test"
import { EFFORT_LEVELS } from "@/agent/effort"
import { planModeMutatingTable } from "@/agent/mode"
import {
  SESSION_CONFIG_EFFORT_LEVELS,
  type SessionConfigEffortLevel,
  type SessionConfigInput,
  type SessionConfigSeam,
  sessionConfigTool,
  type ToolContext,
  type ToolEvent,
  type ToolResult,
} from "@/tool"

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
  ...overrides,
})

const run = async (input: SessionConfigInput, context: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of sessionConfigTool.execute(input, context) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("tool produced no result")
  return result
}

/** Mutable in-memory seam — mirrors the production EffortStore-backed wire. */
const makeSeam = (
  initial: SessionConfigEffortLevel,
  extras: Partial<Omit<SessionConfigSeam, "readEffort" | "writeEffort">> = {},
): { seam: SessionConfigSeam; writes: SessionConfigEffortLevel[] } => {
  let current = initial
  const writes: SessionConfigEffortLevel[] = []
  const seam: SessionConfigSeam = {
    readEffort: () => current,
    writeEffort: (next) => {
      writes.push(next)
      current = next
    },
    ...extras,
  }
  return { seam, writes }
}

describe("session_config — op:get", () => {
  test("renders effort + token budget for a full seam", async () => {
    const { seam } = makeSeam("high", {
      readIdentityMode: () => "code_agent",
      readToolProfile: () => "write",
      readModel: () => "gpt-5-mini",
      readProvider: () => "chatgpt-oauth",
    })
    const result = await run({ op: "get" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const out = result.output
    // Section header rule + title.
    expect(out).toMatch(/^── session_config ─+$/m)
    // Effort + budget line — uses thousands separator and explicit "thinking budget".
    expect(out).toContain("effort         high  ·  thinking budget: 16,384 tokens")
    expect(out).toContain("identity mode  code_agent")
    expect(out).toContain("tool profile   write")
    expect(out).toContain("model          gpt-5-mini")
    expect(out).toContain("provider       chatgpt-oauth")
  })

  test("default tier shows 'provider default' (no numeric budget)", async () => {
    const { seam } = makeSeam("default")
    const result = await run({ op: "get" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output).toContain("effort  default  ·  thinking budget: provider default")
  })

  test("skips absent optional readers — only effort line emitted", async () => {
    const { seam } = makeSeam("low")
    const result = await run({ op: "get" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lines = result.output.split("\n")
    // header + single effort line — no padding column appears because there
    // is only one row.
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^── session_config ─+$/)
    expect(lines[1]).toContain("effort  low")
    expect(lines[1]).toContain("thinking budget: 1,024 tokens")
    expect(result.output).not.toContain("identity mode")
    expect(result.output).not.toContain("tool profile")
    expect(result.output).not.toContain("model")
    expect(result.output).not.toContain("provider")
  })

  test("empty-string optional fields are skipped (treated as absent)", async () => {
    const { seam } = makeSeam("medium", {
      readIdentityMode: () => "",
      readToolProfile: () => "",
      readModel: () => "",
      readProvider: () => "",
    })
    const result = await run({ op: "get" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output).not.toContain("identity mode")
    expect(result.output).not.toContain("tool profile")
  })

  test("reader throw ⇒ ok:false with error mode (no crash, no partial render)", async () => {
    const seam: SessionConfigSeam = {
      readEffort: () => {
        throw new Error("store gone")
      },
      writeEffort: () => undefined,
    }
    const result = await run({ op: "get" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain("snapshot read failed")
    expect(result.output).toContain("store gone")
    expect(result.failure?.mode).toBe("error")
  })
})

describe("session_config — op:set_effort", () => {
  test("mutates seam, reports prev → next transition", async () => {
    const { seam, writes } = makeSeam("medium")
    const result = await run({ op: "set_effort", level: "high" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output).toMatch(/^── session_config · set_effort ─+$/m)
    expect(result.output).toContain("effort  medium  →  high")
    expect(result.output).toContain("thinking budget: 16,384 tokens")
    expect(result.output).toContain("applies from the next turn.")
    expect(writes).toEqual(["high"])
    expect(seam.readEffort()).toBe("high")
  })

  test("setting to same tier ⇒ explicit no-op message", async () => {
    const { seam, writes } = makeSeam("high")
    const result = await run({ op: "set_effort", level: "high" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.output).toContain("high  (unchanged)")
    expect(result.output).toContain("no-op: session was already at this tier.")
    // The writer is STILL called (idempotent contract; store sees the write)
    // — the message is the only signal that nothing changed semantically.
    expect(writes).toEqual(["high"])
  })

  test("writer throw ⇒ ok:false with error mode (post-read seam intact)", async () => {
    const seam: SessionConfigSeam = {
      readEffort: () => "low",
      writeEffort: () => {
        throw new Error("store locked")
      },
    }
    const result = await run({ op: "set_effort", level: "max" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain("write failed")
    expect(result.output).toContain("store locked")
    expect(result.failure?.mode).toBe("error")
  })

  test("pre-write read failure surfaces before writer is invoked", async () => {
    let writeCalled = false
    const seam: SessionConfigSeam = {
      readEffort: () => {
        throw new Error("pre-read boom")
      },
      writeEffort: () => {
        writeCalled = true
      },
    }
    const result = await run({ op: "set_effort", level: "high" }, ctx({ sessionConfig: seam }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain("pre-write read failed")
    expect(writeCalled).toBe(false)
  })
})

describe("session_config — unwired seam", () => {
  test("get returns typed not_wired failure when ctx.sessionConfig is absent", async () => {
    const result = await run({ op: "get" }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain("not wire")
    expect(result.failure?.mode).toBe("rejected")
    if (result.failure?.mode === "rejected") {
      expect(result.failure.reason).toBe("not_wired")
    }
  })

  test("set_effort returns typed not_wired failure when ctx.sessionConfig is absent", async () => {
    const result = await run({ op: "set_effort", level: "high" }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain("not wire")
    expect(result.failure?.mode).toBe("rejected")
  })
})

describe("session_config — abort", () => {
  test("pre-call aborted signal yields rejected/aborted before any seam read", async () => {
    const aborted = new AbortController()
    aborted.abort()
    let readCalled = false
    const seam: SessionConfigSeam = {
      readEffort: () => {
        readCalled = true
        return "medium"
      },
      writeEffort: () => undefined,
    }
    const result = await run({ op: "get" }, ctx({ signal: aborted.signal, sessionConfig: seam }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.output).toContain("aborted")
    expect(readCalled).toBe(false)
  })
})

describe("session_config — invariants", () => {
  test("effort-tier alphabet matches @/agent/effort.EFFORT_LEVELS (parity invariant)", () => {
    // Same SET (order is not part of the invariant — both are exhaustive).
    expect(new Set(SESSION_CONFIG_EFFORT_LEVELS)).toEqual(new Set(EFFORT_LEVELS))
  })

  test("MUTATING_TOOL_TABLE classifies session_config as null (read-only-permissive)", () => {
    // Plan-mode dispatch allows null-classified tools regardless of their
    // Tool#isReadOnly value. If a future change flips this entry to a
    // mutating kind, plan mode will silently start blocking session_config
    // — this test traps that regression.
    const table = planModeMutatingTable()
    expect("session_config" in table).toBe(true)
    expect(table.session_config).toBeNull()
  })

  test("tool name + isConcurrencySafe contract are stable", () => {
    expect(sessionConfigTool.name).toBe("session_config")
    // Both ops are pure in-memory reads / single seam call — concurrency-safe
    // for any well-formed input.
    expect(sessionConfigTool.isConcurrencySafe({ op: "get" })).toBe(true)
    expect(sessionConfigTool.isConcurrencySafe({ op: "set_effort", level: "high" })).toBe(true)
    // Read+write tool — declared mutating at the Tool level even though the
    // table classifies as null. The discrepancy is intentional and is what
    // the parity test above exists to defend.
    expect(sessionConfigTool.isReadOnly()).toBe(false)
  })

  test("input schema rejects set_effort without a level", () => {
    const parsed = sessionConfigTool.inputSchema.safeParse({ op: "set_effort" })
    expect(parsed.success).toBe(false)
  })

  test("input schema rejects unknown level", () => {
    const parsed = sessionConfigTool.inputSchema.safeParse({ op: "set_effort", level: "ultra" })
    expect(parsed.success).toBe(false)
  })

  test("input schema accepts { op: 'get' } and { op: 'set_effort', level: 'high' }", () => {
    expect(sessionConfigTool.inputSchema.safeParse({ op: "get" }).success).toBe(true)
    expect(
      sessionConfigTool.inputSchema.safeParse({ op: "set_effort", level: "high" }).success,
    ).toBe(true)
  })

  test("input schema rejects unknown op", () => {
    const parsed = sessionConfigTool.inputSchema.safeParse({ op: "delete_history" })
    expect(parsed.success).toBe(false)
  })
})
