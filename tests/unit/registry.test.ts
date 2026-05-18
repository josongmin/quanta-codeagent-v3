import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { ToolExecutionError, ToolInputError } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

describe("ToolRegistry", () => {
  const registry = new ToolRegistry(defaultTools)

  test("has() reflects registered tools", () => {
    expect(registry.has("write")).toBe(true)
    expect(registry.has("read")).toBe(true)
    expect(registry.has("nope")).toBe(false)
  })

  test("get() returns the tool or undefined", () => {
    expect(registry.get("read")?.name).toBe("read")
    expect(registry.get("nope")).toBeUndefined()
  })

  test("isReadOnly() reads the tool flag; unknown is false", () => {
    expect(registry.isReadOnly("read")).toBe(true)
    expect(registry.isReadOnly("write")).toBe(false)
    expect(registry.isReadOnly("nope")).toBe(false)
  })

  test("specs() returns one well-formed entry per default tool", () => {
    const specs = registry.specs()
    expect(specs).toHaveLength(defaultTools.length)
    const names = specs.map((s) => s.name).sort()
    expect(names).toEqual(defaultTools.map((t) => t.name).sort())
    for (const s of specs) {
      expect(typeof s.name).toBe("string")
      expect(typeof s.description).toBe("string")
      expect(s.input_schema.type).toBe("object")
    }
  })

  test("run() with valid input dispatches the tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-"))
    try {
      const file = join(dir, "hello.txt")
      const result = await registry.run("write", { path: file, content: "hi there" }, ctx(dir))
      expect(result.ok).toBe(true)
      expect(readFileSync(file, "utf8")).toBe("hi there")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("run() with schema-invalid input throws ToolInputError naming the field", async () => {
    let caught: unknown
    try {
      await registry.run("write", { path: 123 }, ctx(tmpdir()))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ToolInputError)
    expect((caught as ToolInputError).message).toContain("path")
    expect((caught as ToolInputError).code).toBe("tool_input")
  })

  test("run() with unknown tool throws ToolInputError", async () => {
    let caught: unknown
    try {
      await registry.run("ghost", {}, ctx(tmpdir()))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ToolInputError)
    expect((caught as ToolInputError).message).toContain("Unknown tool: ghost")
  })

  test("isConcurrencySafe(): reads are safe, mutations are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-"))
    try {
      const file = join(dir, "a.txt")
      expect(registry.isConcurrencySafe("read", { path: file })).toBe(true)
      expect(registry.isConcurrencySafe("grep", { pattern: "x" })).toBe(true)
      expect(registry.isConcurrencySafe("glob", { pattern: "*" })).toBe(true)
      expect(registry.isConcurrencySafe("write", { path: file, content: "x" })).toBe(false)
      expect(registry.isConcurrencySafe("edit", { path: file })).toBe(false)
      expect(registry.isConcurrencySafe("bash", { command: "ls" })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("isConcurrencySafe(): unknown tool or invalid input → false (safe default)", () => {
    expect(registry.isConcurrencySafe("ghost", {})).toBe(false)
    expect(registry.isConcurrencySafe("read", { path: 123 })).toBe(false)
  })

  test("run() forwards progress then returns the terminal result", async () => {
    const tool: Tool<{ x: string }> = {
      name: "progressive",
      description: "test",
      inputSchema: z.object({ x: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async *execute(): AsyncIterable<ToolEvent> {
        yield { type: "progress", message: "step 1" }
        yield { type: "progress", message: "step 2" }
        yield { type: "result", result: { ok: true, output: "final" } }
      },
    }
    const reg = new ToolRegistry([tool as Tool])
    const seen: string[] = []
    const result = await reg.run("progressive", { x: "y" }, ctx(tmpdir()), (m) => seen.push(m))
    expect(seen).toEqual(["step 1", "step 2"])
    expect(result).toEqual({ ok: true, output: "final" })
  })

  test("run() throws ToolExecutionError when the tool yields no result", async () => {
    const tool: Tool<Record<string, never>> = {
      name: "silent",
      description: "test",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute(): AsyncIterable<ToolEvent> {
        return (async function* () {})()
      },
    }
    const reg = new ToolRegistry([tool as Tool])
    let caught: unknown
    try {
      await reg.run("silent", {}, ctx(tmpdir()))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ToolExecutionError)
    expect((caught as ToolExecutionError).message).toContain("produced no result")
  })
})
