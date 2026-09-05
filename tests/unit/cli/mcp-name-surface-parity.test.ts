import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { disambiguateMcpToolNames } from "@/agent"
import { sanitizeServerKey as sanitizeCliServerKey } from "@/apps/cli/repl/mcp-surface-wire"
import { sanitizeServerKey as sanitizeHealthKey } from "@/host/mcp-health"
import { mcpToolName, sanitizeMcpNameSegment } from "@/mcp"
import type { Tool, ToolEvent } from "@/tool"

const NAMES = [
  "clean",
  "has space",
  "a/b",
  "a:b",
  "a.b",
  "a-b",
  "a--b",
  "!!!",
  "한글",
  "",
  "_keep_",
  "MiXeD",
] as const

const fake = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: name } }
  },
})

describe("mcp name surface parity", () => {
  test("name table floor is 12; surfaces are 3", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(12)
  })

  for (const name of NAMES) {
    test(`segment parity for ${JSON.stringify(name)}`, () => {
      const canonical = sanitizeMcpNameSegment(name)
      expect(sanitizeHealthKey(name)).toBe(canonical)
      expect(sanitizeCliServerKey(name)).toBe(canonical)
      expect(mcpToolName(name, "t")).toBe(`mcp__${canonical}__${sanitizeMcpNameSegment("t")}`)
    })
  }

  test("collision groups are reported by disambiguateMcpToolNames", () => {
    const groups = [
      ["a-b", "a/b"],
      ["a--b", "a!!b"],
      ["한", "???"],
    ] as const
    expect(groups.length).toBeGreaterThanOrEqual(3)
    for (const [x, y] of groups) {
      const left = mcpToolName("s", x)
      const right = mcpToolName("s", y)
      expect(left).toBe(right)
      const out = disambiguateMcpToolNames([fake(left), fake(right)])
      expect(out.collisions.length).toBe(1)
    }
  })

  test("mutation: restoring the old per-char regex in one consumer diverges on runs", () => {
    const old = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, "_")
    const live = sanitizeMcpNameSegment("a--b")
    const drifted = old("a--b")
    expect(live).toBe("a_b")
    expect(drifted).toBe("a__b")
    expect(sanitizeHealthKey("a--b")).toBe(live)
    expect(sanitizeCliServerKey("a--b")).toBe(live)
  })
})
