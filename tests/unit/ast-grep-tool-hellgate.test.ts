/**
 * Hellgate tests for the ast_grep tool.
 *
 * Structural / static — no binary execution in CI (ast-grep need not be on
 * PATH for these tests to pass). Covers:
 *
 *   HELL-1  tool.name === "ast_grep"
 *   HELL-2  schema requires "pattern"
 *   HELL-3  schema has optional "path" and "language"
 *   HELL-4  MAX_MATCHES constant is in range [10, 100]
 *   HELL-5  "ast_grep" NOT in BASE_TOOL_NAMES (default-OFF)
 *   HELL-6  "ast_grep" IS in GATED_TOOLS
 *   HELL-7  GATED entry for ast_grep has a gate field with an env var
 *   HELL-8  tool implements the Tool interface shape
 */

import { describe, expect, test } from "bun:test"
import type { z } from "zod"
import { astGrepTool } from "@/tool/ast-grep"
import { BASE_TOOL_NAMES, GATED_TOOLS } from "@/tool/surface/manifest"
import { nth, present } from "../_helpers/expect-present"

// ─── HELL-1: tool name ───────────────────────────────────────────────────────

describe("HELL-1: tool name", () => {
  test('tool.name === "ast_grep"', () => {
    // Red-on-injection: rename the tool => manifest entry name breaks and
    // HELL-6/HELL-7 catch it; this test seals the tool identity itself.
    expect(astGrepTool.name).toBe("ast_grep")
  })
})

// ─── HELL-2: schema requires "pattern" ───────────────────────────────────────

describe("HELL-2: schema requires pattern", () => {
  test("inputSchema rejects input missing pattern", () => {
    const schema = astGrepTool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>
    const result = schema.safeParse({})
    expect(result.success).toBe(false)
  })

  test("inputSchema accepts input with only pattern", () => {
    const schema = astGrepTool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>
    const result = schema.safeParse({ pattern: "console.log($A)" })
    expect(result.success).toBe(true)
  })

  test("pattern field is present in schema shape", () => {
    const schema = astGrepTool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>
    expect(schema.shape).toHaveProperty("pattern")
  })
})

// ─── HELL-3: optional fields "path" and "language" ───────────────────────────

describe("HELL-3: optional path and language fields", () => {
  const schema = astGrepTool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>

  test("path field is present in schema shape", () => {
    expect(schema.shape).toHaveProperty("path")
  })

  test("language field is present in schema shape", () => {
    expect(schema.shape).toHaveProperty("language")
  })

  test("path is optional — schema accepts input without path", () => {
    const result = schema.safeParse({ pattern: "foo($A)" })
    expect(result.success).toBe(true)
  })

  test("language is optional — schema accepts input without language", () => {
    const result = schema.safeParse({ pattern: "foo($A)" })
    expect(result.success).toBe(true)
  })

  test("schema accepts input with both path and language supplied", () => {
    const result = schema.safeParse({
      pattern: "foo($A)",
      path: "./src",
      language: "typescript",
    })
    expect(result.success).toBe(true)
  })
})

// ─── HELL-4: MAX_MATCHES constant range [10, 100] ────────────────────────────

describe("HELL-4: MAX_MATCHES constant range", () => {
  test("tool description mentions the match cap (50 by default)", () => {
    // The constant is module-private; we verify it via its visible effect:
    // the note in the manifest says "Capped at 50 matches per call."
    const entry = GATED_TOOLS.find((e) => e.name === "ast_grep")
    expect(entry?.note).toMatch(/50/)
  })

  test("MAX_MATCHES is reflected in the GATED_TOOLS note as a number in [10,100]", () => {
    // Extract the numeric cap from the note and assert range.
    const entry = GATED_TOOLS.find((e) => e.name === "ast_grep")
    const match = entry?.note?.match(/Capped at (\d+) matches/)
    expect(match).not.toBeNull()
    const cap = Number(nth(present(match, "Capped-at note match"), 1, "match groups"))
    expect(cap).toBeGreaterThanOrEqual(10)
    expect(cap).toBeLessThanOrEqual(100)
  })
})

// ─── HELL-5: "ast_grep" NOT in BASE_TOOL_NAMES (default-OFF) ─────────────────

describe("HELL-5: ast_grep absent from BASE_TOOL_NAMES", () => {
  test("ast_grep is NOT in the BASE_TOOL_NAMES array", () => {
    // Red-on-injection: moving ast_grep to BASE_TOOL_NAMES would make it
    // default-ON (unexpected auto-seeding) — this test catches that.
    expect(BASE_TOOL_NAMES).not.toContain("ast_grep")
  })
})

// ─── HELL-6: "ast_grep" IS in GATED_TOOLS ────────────────────────────────────

describe("HELL-6: ast_grep present in GATED_TOOLS", () => {
  test("GATED_TOOLS contains an entry with name ast_grep", () => {
    // Red-on-injection: removing the entry ⇒ the tool is never registered for
    // any gated surface — it silently disappears.
    const entry = GATED_TOOLS.find((e) => e.name === "ast_grep")
    expect(entry).toBeDefined()
  })
})

// ─── HELL-7: GATED entry has a gate field with an env var ────────────────────

describe("HELL-7: GATED entry has gate with env var", () => {
  const entry = GATED_TOOLS.find((e) => e.name === "ast_grep")

  test("entry.gate exists", () => {
    expect(entry?.gate).toBeDefined()
  })

  test("entry.gate has kind env-flag", () => {
    expect(entry?.gate.kind).toBe("env-flag")
  })

  test("entry.gate has a non-empty env string", () => {
    const gate = entry?.gate as { kind: string; env?: string } | undefined
    expect(typeof gate?.env).toBe("string")
    expect((gate?.env ?? "").length).toBeGreaterThan(0)
  })

  test("gate env var starts with QUANTA_", () => {
    const gate = entry?.gate as { kind: string; env?: string } | undefined
    expect(gate?.env).toMatch(/^QUANTA_/)
  })
})

// ─── HELL-8: tool implements Tool interface shape ─────────────────────────────

describe("HELL-8: tool implements Tool interface shape", () => {
  test("tool.name is a string", () => {
    expect(typeof astGrepTool.name).toBe("string")
  })

  test("tool.description is a non-empty string", () => {
    expect(typeof astGrepTool.description).toBe("string")
    expect(astGrepTool.description.length).toBeGreaterThan(0)
  })

  test("tool.execute is a function", () => {
    expect(typeof astGrepTool.execute).toBe("function")
  })

  test("tool.inputSchema is defined (zod schema object)", () => {
    expect(astGrepTool.inputSchema).toBeDefined()
  })

  test("tool declares itself read-only", () => {
    expect(astGrepTool.isReadOnly()).toBe(true)
  })

  test("tool declares itself concurrency-safe", () => {
    expect(astGrepTool.isConcurrencySafe({} as never)).toBe(true)
  })
})
