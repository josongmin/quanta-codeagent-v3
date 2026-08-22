/**
 * ★ TICKET-19 reverse-MCP — `buildMcpServer` whitelist (the SECURITY boundary).
 *
 * This tiny pure function IS the RCE fence: the set of tools an EXTERNAL MCP
 * client can reach = (read-only tools) ∪ (explicit per-tool opt-in). Every case
 * here is adversarial about widening:
 *   A. default build EXCLUDES a mutating tool (red-on-injection)
 *   B. whitelist = read-only ∪ explicitOptIn
 *   C. a mutating tool ONLY appears when explicitly opted in
 *   D. empty inputs ⇒ empty whitelist (fail-closed, never "everything")
 *
 * Pure + injected `ToolListSource` ⇒ no @/agent, no process, no FS.
 */

import { describe, expect, test } from "bun:test"
import { buildMcpServer, type ToolListSource } from "../server-builder"

/** Fake registry: `bash`/`write` MUTATE, `read`/`grep` are read-only. */
const fakeToolList = (): ToolListSource => ({
  specs: () => [
    { name: "read", description: "read a file", input_schema: { type: "object" } },
    { name: "grep", description: "search", input_schema: { type: "object" } },
    { name: "bash", description: "run a shell command", input_schema: { type: "object" } },
    { name: "write", description: "write a file", input_schema: { type: "object" } },
  ],
  readOnly: (name) => name === "read" || name === "grep",
})

describe("buildMcpServer whitelist (RCE fence)", () => {
  test("default build EXPOSES read-only tools only — bash/write ABSENT", () => {
    const server = buildMcpServer({ toolList: fakeToolList(), write: () => {} })
    const exposed = server.exposedToolNames()
    expect(exposed).toContain("read")
    expect(exposed).toContain("grep")
    // red-on-injection: if the whitelist regressed to "all tools", these flip.
    expect(exposed).not.toContain("bash")
    expect(exposed).not.toContain("write")
  })

  test("whitelist = read-only ∪ explicitOptIn", () => {
    const server = buildMcpServer({
      toolList: fakeToolList(),
      write: () => {},
      explicitOptIn: ["write"],
    })
    const exposed = server.exposedToolNames()
    expect(new Set(exposed)).toEqual(new Set(["read", "grep", "write"]))
    // `bash` was NOT opted in ⇒ still denied.
    expect(exposed).not.toContain("bash")
  })

  test("a mutating tool in explicitOptIn appears; the same tool by default does NOT", () => {
    const withOptIn = buildMcpServer({
      toolList: fakeToolList(),
      write: () => {},
      explicitOptIn: ["bash"],
    })
    const byDefault = buildMcpServer({ toolList: fakeToolList(), write: () => {} })
    expect(withOptIn.exposedToolNames()).toContain("bash")
    expect(byDefault.exposedToolNames()).not.toContain("bash")
  })

  test("explicitOptIn naming an UNKNOWN tool never widens (only registry tools count)", () => {
    const server = buildMcpServer({
      toolList: fakeToolList(),
      write: () => {},
      explicitOptIn: ["does_not_exist"],
    })
    expect(server.exposedToolNames()).not.toContain("does_not_exist")
  })

  test("empty registry ⇒ empty whitelist (fail-closed, not 'everything')", () => {
    const empty: ToolListSource = { specs: () => [], readOnly: () => false }
    const server = buildMcpServer({ toolList: empty, write: () => {} })
    expect(server.exposedToolNames()).toEqual([])
  })
})
