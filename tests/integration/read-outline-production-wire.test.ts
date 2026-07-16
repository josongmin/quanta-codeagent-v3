import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StructuredLogger } from "@/observability"
import { buildToolingCore } from "@/runner/assemble"
import { __resetRuntimeConfig } from "@/shared"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { ToolContext } from "@/tool"

const dirs: string[] = []

const fixture = (): { readonly cwd: string; readonly path: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "read-outline-production-"))
  dirs.push(cwd)
  const path = "fixture.ts"
  writeFileSync(
    join(cwd, path),
    ["export function add(a: number, b: number): number {", "  return a + b", "}"].join("\n"),
  )
  return { cwd, path }
}

const tooling = () =>
  buildToolingCore({
    store: undefined,
    embedder: undefined,
    sessionId: "read-outline-production",
    memoryConfig: undefined,
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    mcpTools: [],
    lspTools: [],
    lspNavTools: [],
    gitToolList: [],
    slog: new StructuredLogger({ sink: () => undefined }),
  })

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.QUANTA_READ_OUTLINE
  delete process.env.QUANTA_SYNTAX_CHUNK
  __resetKnobOverrides()
  __resetRuntimeConfig()
})

describe("read outline production composition", () => {
  test("QUANTA_READ_OUTLINE wires the real parser through buildDefaultTools", async () => {
    process.env.QUANTA_READ_OUTLINE = "1"
    delete process.env.QUANTA_SYNTAX_CHUNK
    __resetRuntimeConfig()
    const { cwd, path } = fixture()
    const ctx: ToolContext = { cwd, signal: new AbortController().signal }

    const result = await tooling().registry.run("read", { path, outline: true }, ctx)

    expect(result.ok).toBe(true)
    expect(result.output).toContain("export function add(a: number, b: number): number {")
    expect(result.output).toContain("// …")
    expect(result.output).not.toContain("return a + b")
    expect(result.output).not.toContain("no outline")
    expect(process.env.QUANTA_SYNTAX_CHUNK).toBeUndefined()
  })

  test("QUANTA_SYNTAX_CHUNK alone does not activate read outline parsing", async () => {
    delete process.env.QUANTA_READ_OUTLINE
    process.env.QUANTA_SYNTAX_CHUNK = "1"
    __resetRuntimeConfig()
    const { cwd, path } = fixture()
    const ctx: ToolContext = { cwd, signal: new AbortController().signal }

    const result = await tooling().registry.run("read", { path, outline: true }, ctx)

    expect(result.ok).toBe(true)
    expect(result.output).toContain("no outline")
    expect(result.output).toContain("2\t  return a + b")
  })
})
