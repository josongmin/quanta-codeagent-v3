/**
 * ADR-0336 — `parsePluginManifest` hellgate.
 *
 *   A. Malformed / empty JSON                      (3)
 *   B. Required field absence                      (2)
 *   C. id↔name fallback                            (2)
 *   D. Capabilities — enum closure + emptiness     (3)
 *   E. mcpServers — Record shape + sanitization    (2)   [ADR-0341]
 *   F. skills — array shape                        (1)
 *   G. Forward-compat: unknown fields dropped      (1)
 *
 * Total = 14 cases (>= the required 10).
 *
 * Per ADR-0341, `mcpServers` is `Record<string, MCPServerSpec>` where
 * `MCPServerSpec = { command, args, env? }` — same canonical shape as
 * ADR-0039 `@/skill/plugin-manifest`. Pre-ADR-0341 array-of-`{name,
 * command?}` shape is no longer accepted.
 */

import { describe, expect, test } from "bun:test"
import { parsePluginManifest } from "../parser"

describe("parsePluginManifest — ADR-0336 hellgate", () => {
  // -------- A. malformed / empty JSON -----------------------------

  test("A1 — empty string ⇒ null (JSON.parse throws)", () => {
    expect(parsePluginManifest("")).toBeNull()
  })

  test("A2 — non-object root (array) ⇒ null", () => {
    expect(parsePluginManifest('["a", "b"]')).toBeNull()
  })

  test("A3 — non-object root (string) ⇒ null", () => {
    expect(parsePluginManifest('"just a string"')).toBeNull()
  })

  // -------- B. required field absence -----------------------------

  test("B1 — both id and name missing ⇒ null", () => {
    expect(parsePluginManifest('{"description": "x"}')).toBeNull()
  })

  test("B2 — id and name both whitespace ⇒ null", () => {
    expect(parsePluginManifest('{"id": "  ", "name": " "}')).toBeNull()
  })

  // -------- C. id↔name fallback -----------------------------------

  test("C1 — only id present ⇒ name falls back to id", () => {
    const m = parsePluginManifest('{"id": "github-pr"}')
    expect(m).not.toBeNull()
    expect(m?.id).toBe("github-pr")
    expect(m?.name).toBe("github-pr")
    expect(m?.capabilities).toEqual([])
  })

  test("C2 — only name present ⇒ id falls back to name", () => {
    const m = parsePluginManifest('{"name": "Codex Reviewer"}')
    expect(m).not.toBeNull()
    expect(m?.id).toBe("Codex Reviewer")
    expect(m?.name).toBe("Codex Reviewer")
  })

  // -------- D. capabilities ---------------------------------------

  test("D1 — full enum set parses ⇒ all three preserved in order", () => {
    const m = parsePluginManifest('{"id": "p", "capabilities": ["Interactive", "Read", "Write"]}')
    expect(m?.capabilities).toEqual(["Interactive", "Read", "Write"])
  })

  test("D2 — unknown capability strings silently dropped", () => {
    const m = parsePluginManifest(
      '{"id": "p", "capabilities": ["Read", "Execute", "Write", "FuturePerm"]}',
    )
    expect(m?.capabilities).toEqual(["Read", "Write"])
  })

  test("D3 — empty capabilities array preserved as []", () => {
    const m = parsePluginManifest('{"id": "p", "capabilities": []}')
    expect(m?.capabilities).toEqual([])
  })

  // -------- E. mcpServers (ADR-0341 Record shape) -----------------

  test("E1 — well-formed mcpServers Record preserved (command/args/env)", () => {
    const m = parsePluginManifest(
      '{"id": "p", "mcpServers": {"gh": {"command": "gh-mcp", "args": ["serve"], "env": {"K": "v"}}, "fs": {"command": "fs-mcp", "args": []}}}',
    )
    expect(m?.mcpServers).toEqual({
      gh: { command: "gh-mcp", args: ["serve"], env: { K: "v" } },
      fs: { command: "fs-mcp", args: [] },
    })
  })

  test("E2 — mcpServers entries lacking command are dropped", () => {
    const m = parsePluginManifest(
      '{"id": "p", "mcpServers": {"orphan": {"args": ["x"]}, "ok": {"command": "ok-mcp", "args": []}}}',
    )
    expect(m?.mcpServers).toEqual({
      ok: { command: "ok-mcp", args: [] },
    })
  })

  // -------- F. skills ---------------------------------------------

  test("F1 — skills array of strings preserved; non-strings dropped", () => {
    const m = parsePluginManifest('{"id": "p", "skills": ["a", 42, "b", null, "c"]}')
    expect(m?.skills).toEqual(["a", "b", "c"])
  })

  // -------- G. forward-compat -------------------------------------

  test("G1 — unknown top-level field dropped silently (still parses)", () => {
    const m = parsePluginManifest(
      '{"id": "p", "name": "P", "futureField": {"x": 1}, "description": "tagline"}',
    )
    expect(m).not.toBeNull()
    expect(m?.id).toBe("p")
    expect(m?.description).toBe("tagline")
    // No leak of unknown field into the parsed object.
    expect((m as unknown as { futureField?: unknown }).futureField).toBeUndefined()
  })
})
