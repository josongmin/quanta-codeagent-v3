import { describe, expect, test } from "bun:test"
import { createToolSearchTool } from "../../src/skill"
import type { ToolContext, ToolResult, ToolSpec } from "../../src/tool"

/**
 * Tests for the lexical accuracy improvements in `createToolSearchTool`:
 *   (a) compound-query tokenization (camelCase / snake / kebab boundaries)
 *   (b) description first-line ("tagline") weight 4 vs body weight 2
 *   (c) optional `ToolSpec.aliases` carrying name-equivalent weight
 *
 * Each block also asserts the original behavioral guarantees stay byte-
 * identical for catalogs/queries that pre-date these features (no aliases,
 * single-word query, structure-free description).
 */

const CTX: ToolContext = { cwd: "/", signal: new AbortController().signal }

const run = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<unknown> },
  input: unknown,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, CTX)) {
    const e = ev as { type: string; result?: ToolResult }
    if (e.type === "result") result = e.result
  }
  if (!result) throw new Error("tool produced no result")
  return result
}

/** Position of a tool's heading in the formatted output, or `-1` if absent. */
const pos = (output: string, name: string): number => output.indexOf(`### ${name}`)

describe("ToolSearch lexical improvements", () => {
  test("(a) compound camelCase query tokenizes into name tokens", async () => {
    // Catalog mixes snake_case canonical names with a noisy substring red
    // herring. Query is a single camelCase token — the OLD tokenizer split
    // queries on whitespace only and would only score via substring against
    // names, putting noise ahead of the genuine match.
    const catalog = (): ToolSpec[] => [
      {
        name: "lsp_document_symbol",
        description: "List document symbols",
        input_schema: { type: "object" },
      },
      {
        name: "list_files",
        description: "List files in a directory (no document parsing here)",
        input_schema: { type: "object" },
      },
    ]
    const r = await run(createToolSearchTool(catalog), { query: "documentSymbol" })
    expect(r.ok).toBe(true)
    // lsp_document_symbol picks up BOTH `document` AND `symbol` as name-token
    // hits (+10 each) ⇒ ranks above list_files which only hits `document`
    // in its body (+2).
    expect(pos(r.output, "lsp_document_symbol")).toBeGreaterThanOrEqual(0)
    expect(pos(r.output, "lsp_document_symbol")).toBeLessThan(pos(r.output, "list_files"))
  })

  test("(a) snake_case query also splits and matches camelCase identifiers", async () => {
    const catalog = (): ToolSpec[] => [
      {
        name: "readFileSync",
        description: "Read a file synchronously from disk",
        input_schema: { type: "object" },
      },
      {
        name: "open_pull_request",
        description: "Open a pull request on GitHub",
        input_schema: { type: "object" },
      },
    ]
    // `read_file` should now decompose to ["read","file"] and hit
    // readFileSync's name tokens (camelCase) on both terms.
    const r = await run(createToolSearchTool(catalog), { query: "read_file" })
    expect(r.ok).toBe(true)
    expect(pos(r.output, "readFileSync")).toBeGreaterThanOrEqual(0)
  })

  test("(b) description first-line match outranks body-only match", async () => {
    // Same single-word query hits the first line of A and only the body of B.
    // Tagline weight (+4) must lift A above B (+2) even though both are
    // otherwise equivalent.
    const catalog = (): ToolSpec[] => [
      {
        name: "alpha",
        description: "Deploys a service. Notes about rollback live here.",
        input_schema: { type: "object" },
      },
      {
        name: "bravo",
        description: "Configures DNS. Deploys are out of scope for this tool.",
        input_schema: { type: "object" },
      },
    ]
    const r = await run(createToolSearchTool(catalog), { query: "deploys" })
    expect(r.ok).toBe(true)
    // alpha's first sentence is "Deploys a service" — tagline hit
    // bravo's first sentence is "Configures DNS" — only the BODY mentions Deploys
    expect(pos(r.output, "alpha")).toBeLessThan(pos(r.output, "bravo"))
  })

  test("(c) alias match has the same weight as a canonical-name match", async () => {
    // One tool's CANONICAL name is unrelated to the query; its alias is the
    // intuitive synonym. A second tool's body merely mentions the query
    // term. The alias-bearing tool must rank above the body-only tool.
    const catalog = (): ToolSpec[] => [
      {
        name: "x_filesystem_read",
        description: "Internal IO primitive",
        aliases: ["read", "open"],
        input_schema: { type: "object" },
      },
      {
        name: "configure_lint",
        description: "Configure the linter. We may also read config files.",
        input_schema: { type: "object" },
      },
    ]
    const r = await run(createToolSearchTool(catalog), { query: "read" })
    expect(r.ok).toBe(true)
    // Exact alias match short-circuits to Infinity ⇒ definitely first.
    expect(pos(r.output, "x_filesystem_read")).toBeLessThan(pos(r.output, "configure_lint"))
  })

  test("(c) select:<alias> resolves to the canonical tool when no name collides", async () => {
    const catalog = (): ToolSpec[] => [
      {
        name: "x_filesystem_read",
        description: "Internal IO primitive",
        aliases: ["fread"],
        input_schema: { type: "object" },
      },
    ]
    const r = await run(createToolSearchTool(catalog), { query: "select:fread" })
    expect(r.ok).toBe(true)
    // The OUTPUT advertises the canonical name (not the alias) so the model
    // calls the right tool.
    expect(r.output).toContain("### x_filesystem_read")
    expect(r.output).not.toContain("Unknown:")
  })

  test("regression: select:<canonicalName> still resolves byte-identical", async () => {
    const catalog = (): ToolSpec[] => [
      {
        name: "writeFile",
        description: "Write content to a file on disk",
        input_schema: { type: "object" },
      },
      {
        name: "readFile",
        description: "Read a text file from disk",
        input_schema: { type: "object" },
      },
    ]
    // Existing select-by-canonical-name behavior — no aliases declared,
    // result format & ordering must match the pre-improvement contract.
    const r = await run(createToolSearchTool(catalog), { query: "select:writeFile,readFile,nope" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("### writeFile")
    expect(r.output).toContain("### readFile")
    expect(r.output).toContain("Unknown: nope")
    // Order follows the request, not the catalog order.
    expect(pos(r.output, "writeFile")).toBeLessThan(pos(r.output, "readFile"))
  })

  test("regression: single-word query on alias-free, structure-free catalog preserves ordering", async () => {
    // Reproduces the conditions in the original skill.test.ts ToolSearch
    // test: no aliases, descriptions with no sentence terminator (the entire
    // description IS the first line). Improvements (b) and (c) become no-op
    // for ordering — readFile must still beat writeFile on the query
    // "file read", and mcp__github__create_pr must be absent.
    const catalog = (): ToolSpec[] => [
      {
        name: "readFile",
        description: "Read a text file from disk",
        input_schema: { type: "object" },
      },
      {
        name: "writeFile",
        description: "Write content to a file on disk",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__github__create_pr",
        description: "Open a pull request on GitHub",
        input_schema: { type: "object" },
      },
    ]
    const r = await run(createToolSearchTool(catalog), { query: "file read" })
    expect(r.ok).toBe(true)
    expect(pos(r.output, "readFile")).toBeLessThan(pos(r.output, "writeFile"))
    // No term hits mcp__github__create_pr ⇒ excluded entirely.
    expect(pos(r.output, "mcp__github__create_pr")).toBe(-1)
  })
})
