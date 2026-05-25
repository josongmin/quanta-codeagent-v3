/**
 * `fork_session` tool hellgate (ADR-0201).
 *
 * Seals:
 *   FT-01 input { checkpointId } → ok output mentions sessionId / parentSessionId / forkedAt
 *   FT-02 unknown checkpointId → ok:false output starts with the typed code
 *   FT-03 tool is constructed with a forker port (no global state)
 *   FT-04 builder excludes `fork_session` when no forker is supplied
 *
 * Strategy: a tiny in-test SessionForker double — no agent slice, no real
 * conversation-checkpoint store — to prove the tool is pure DI.
 */

import { describe, expect, test } from "bun:test"
import {
  type ForkSessionInput,
  forkSessionInputSchema,
  forkSessionTool,
  forkSessionTools,
  type SessionForkerLike,
} from "@/tool/shadow"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/work/proj",
  signal: signal ?? new AbortController().signal,
})

interface ExecutableTool {
  execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  context: ToolContext = ctx(),
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, context)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

const okForker: SessionForkerLike = {
  fork(checkpointId) {
    if (checkpointId === "missing") {
      return {
        ok: false,
        error: { code: "checkpoint-not-found", message: `no snapshot under '${checkpointId}'` },
      }
    }
    return {
      ok: true,
      value: {
        sessionId: "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        parentSessionId: checkpointId,
        parentCheckpointId: checkpointId,
        forkedAt: 1234,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      },
    }
  },
}

describe("fork_session tool hellgate (ADR-0201)", () => {
  test("HELL-FT-01: ok path output names sessionId / parentSessionId / forkedAt", async () => {
    const tool = forkSessionTool(okForker)
    expect(tool.name).toBe("fork_session")
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe?.({ checkpointId: "parent-A" })).toBe(true)
    expect(tool.hitlTier?.({ checkpointId: "parent-A" })).toBe("none")
    // schema rejects empty.
    expect(forkSessionInputSchema.safeParse({ checkpointId: "" }).success).toBe(false)

    const input: ForkSessionInput = { checkpointId: "parent-A" }
    const r = await collect(tool, input)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    expect(r.output).toContain("parent-A")
    expect(r.output).toContain("1234")
  })

  test("HELL-FT-02: typed error → ok:false output BEGINS with the code", async () => {
    const tool = forkSessionTool(okForker)
    const r = await collect(tool, { checkpointId: "missing" })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("checkpoint-not-found:")).toBe(true)
  })

  test("HELL-FT-03: tool is pure DI — distinct forker instances yield distinct outputs", async () => {
    const a: SessionForkerLike = {
      fork: () => ({
        ok: true,
        value: {
          sessionId: "id-from-A",
          parentSessionId: "p",
          parentCheckpointId: "p",
          forkedAt: 1,
          messages: [],
        },
      }),
    }
    const b: SessionForkerLike = {
      fork: () => ({
        ok: true,
        value: {
          sessionId: "id-from-B",
          parentSessionId: "p",
          parentCheckpointId: "p",
          forkedAt: 2,
          messages: [],
        },
      }),
    }
    const ra = await collect(forkSessionTool(a), { checkpointId: "p" })
    const rb = await collect(forkSessionTool(b), { checkpointId: "p" })
    expect(ra.output).toContain("id-from-A")
    expect(rb.output).toContain("id-from-B")
    // Neither leaks the other's state.
    expect(ra.output).not.toContain("id-from-B")
    expect(rb.output).not.toContain("id-from-A")
  })

  test("HELL-FT-04: forkSessionTools(undefined) returns [] (default-OFF, tool not registered)", () => {
    expect(forkSessionTools(undefined)).toEqual([])
    const tools = forkSessionTools(okForker)
    expect(tools.length).toBe(1)
    expect(tools[0]?.name).toBe("fork_session")
  })
})
