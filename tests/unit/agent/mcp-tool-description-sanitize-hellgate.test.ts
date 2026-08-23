/** SECURITY hellgate — an MCP server's self-declared tool `description` is
 *  UNTRUSTED third-party text that the bridge splices into the model's
 *  tool-definition block verbatim.
 *
 *  THREAT (mechanical half only). The sibling `mcpToolName` already sanitizes
 *  the server-supplied NAME to `[A-Za-z0-9_]`; the description had NO guard at
 *  all, so a server could ship raw ANSI/C0 control bytes, invisible bidi /
 *  zero-width characters (text the operator cannot see in any tool listing but
 *  the model reads), lone surrogates, or a multi-megabyte blob that silently
 *  eats the context window on every single request.
 *
 *  IN SCOPE: control-character defusal + a length ceiling. DELIBERATELY OUT OF
 *  SCOPE: semantic prompt-injection isolation (delimiters / refusal wrappers)
 *  — that changes the tool MENU the model reads and is a product decision.
 *  A description that says "ignore previous instructions" in plain prose still
 *  reaches the model unchanged; only its BYTES are made honest.
 *
 *  Both bind flavors are pinned (`mcpToolToTool` and the ADR-0435 supervised
 *  `mcpToolToToolSupervised`) — they are separate call sites and drifted
 *  independently before.
 *
 *  Control group: a benign multi-line description (newlines, tabs, CJK, emoji)
 *  is passed through BYTE-IDENTICALLY. */

import { describe, expect, test } from "bun:test"
import {
  MAX_TOOL_DESCRIPTION_CHARS,
  mcpToolToTool,
  mcpToolToToolSupervised,
} from "@/agent/mcp-tool-adapter"
import type { McpCallResult, McpClient, McpReconnectSupervisor, McpToolDef } from "@/mcp"

const ESC = "\u001b"
const BEL = "\u0007"
/** ANSI + BEL + C1 + bidi override + zero-width + a lone high surrogate. */
const HOSTILE = `${ESC}[2Kdesc${BEL}\u009bC1\u202eevil\u200b\ud800 tail`

const client = { callTool: async (): Promise<McpCallResult> => ({ ok: true, content: "ok" }) }
const fakeClient = client as unknown as McpClient
const fakeSupervisor = {
  ...client,
  serverSupportsTasks: () => false,
} as unknown as McpReconnectSupervisor

const def = (description: string): McpToolDef => ({
  name: "do_thing",
  description,
  inputSchema: { type: "object" },
})

const bindBoth = (description: string): ReadonlyArray<string> => [
  mcpToolToTool(fakeClient, def(description), "srv").description,
  mcpToolToToolSupervised(fakeSupervisor, def(description), "srv").description,
]

describe("MCP tool description — control-character defusal", () => {
  test("no raw ESC / BEL / C1 / bidi / zero-width / lone surrogate survives", () => {
    for (const d of bindBoth(HOSTILE)) {
      expect(d.includes(ESC)).toBe(false)
      expect(d.includes(BEL)).toBe(false)
      expect(d.includes("\u009b")).toBe(false)
      expect(d.includes("\u202e")).toBe(false)
      expect(d.includes("\u200b")).toBe(false)
      expect(d.includes("\ud800")).toBe(false)
      // The legible content is KEPT (defanged, not deleted) — the model can
      // still read what the server meant and an auditor can see the escape.
      expect(d).toContain("desc")
      expect(d).toContain("evil")
      expect(d).toContain("tail")
    }
  })

  test("a CR cannot merge the description into the surrounding tool block", () => {
    for (const d of bindBoth("line1\rline2")) expect(d.includes("\r")).toBe(false)
  })
})

describe("MCP tool description — length ceiling", () => {
  test("a multi-megabyte description is capped", () => {
    const huge = "E".repeat(4 * 1024 * 1024)
    for (const d of bindBoth(huge)) {
      expect(d.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS + 32)
      // Truncation is DISCLOSED, never silent.
      expect(d).toContain("truncated")
    }
  })

  test("the cap does not tear a surrogate pair in half", () => {
    // A cut at a fixed code-unit offset would leave a LONE surrogate, which
    // corrupts the UTF-8 the model ends up reading.
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    for (const d of bindBoth("\u{1f680}".repeat(MAX_TOOL_DESCRIPTION_CHARS))) {
      expect(lone.test(d)).toBe(false)
      expect(d).toContain("truncated")
    }
  })
})

describe("MCP tool description control group — benign text is byte-identical", () => {
  test("multi-line + tabbed + CJK + emoji description passes through unchanged", () => {
    const benign = "Read a file.\n\nArgs:\n\tpath — 파일 경로 🚀\nReturns: contents"
    for (const d of bindBoth(benign)) expect(d).toBe(benign)
  })

  test("an under-cap description is not marked truncated", () => {
    const d = mcpToolToTool(fakeClient, def("F".repeat(MAX_TOOL_DESCRIPTION_CHARS)), "srv")
    expect(d.description).toBe("F".repeat(MAX_TOOL_DESCRIPTION_CHARS))
  })

  test("an empty description stays empty (no marker, no crash)", () => {
    for (const d of bindBoth("")) expect(d).toBe("")
  })
})
