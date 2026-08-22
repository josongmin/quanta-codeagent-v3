/**
 * ★ CONTRACT — ADR-0471 untrusted-source envelope wired into dispatch.
 *
 * Proves the seam (dispatch wraps a tool's result text in an
 * `<untrusted-source name="...">` envelope so the model treats EXTERNAL output
 * as DATA, never instructions):
 *   - Gate OFF (default) ⇒ byte-identical: NO envelope, output unchanged.
 *   - Gate ON + untrusted origin (mcp/web_fetch/file/plugin/bash) ⇒ wrapped,
 *     `name=` = the provenance DERIVED FROM THE CALL SITE (registry origin +
 *     tool name), never name-guessing.
 *   - Gate ON + trusted/internal origin (a builtin like `read`/`edit`) ⇒ NOT
 *     wrapped (internal output is trusted).
 *   - Redact-then-wrap order preserved: a secret in the result is still redacted
 *     INSIDE the envelope (the envelope is orthogonal to redaction).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, type ToolEvent, type ToolOrigin, ToolRegistry } from "@/tool"

const echoTool = (name: string, text: string): Tool => ({
  name,
  description: "echo test tool",
  inputSchema: z.object({}) as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: text } }
  },
})

const configWith = (tool: Tool, origin: ToolOrigin | undefined): AgentConfig =>
  ({
    registry: new ToolRegistry(
      [tool],
      origin !== undefined ? new Map([[tool.name, origin]]) : undefined,
    ),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
  }) as AgentConfig

const call = (name: string): ToolUseBlock => ({ type: "tool_use", id: "c1", name, input: {} })
const perm: PermissionContext = { mode: "acceptEdits" }

let permRoot: string | null = null
const orig = process.env.QUANTA_PERMISSION_STATE
const origGate = process.env.QUANTA_UNTRUSTED_ENVELOPE

beforeEach(() => {
  permRoot = mkdtempSync(join(tmpdir(), "dispatch-envelope-"))
  process.env.QUANTA_PERMISSION_STATE = join(permRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (permRoot !== null) rmSync(permRoot, { recursive: true, force: true })
  permRoot = null
  if (orig === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = orig
  if (origGate === undefined) delete process.env.QUANTA_UNTRUSTED_ENVELOPE
  else process.env.QUANTA_UNTRUSTED_ENVELOPE = origGate
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const enable = () => {
  process.env.QUANTA_UNTRUSTED_ENVELOPE = "1"
  __resetRuntimeConfig()
}

describe("A. gate OFF — byte-identical", () => {
  test("A1 — no envelope when gate unset, even for an mcp tool", async () => {
    const res = await dispatchTool(call("ext"), configWith(echoTool("ext", "hello"), "mcp"), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("hello")
    expect(res.preview).not.toContain("<untrusted-source")
  })
})

describe("B. gate ON — provenance from the call site", () => {
  test('B1 — mcp-origin tool result is wrapped with name="mcp"', async () => {
    enable()
    const res = await dispatchTool(call("ext"), configWith(echoTool("ext", "hi"), "mcp"), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toContain('<untrusted-source name="mcp">')
    expect(res.preview).toContain("hi")
  })

  test('B2 — a builtin web_fetch is wrapped name="web_fetch"', async () => {
    enable()
    const res = await dispatchTool(
      call("web_fetch"),
      configWith(echoTool("web_fetch", "page body"), "builtin"),
      perm,
    )
    expect(res.preview).toContain('<untrusted-source name="web_fetch">')
  })

  test("B3 — a builtin internal tool (edit) is NOT wrapped (trusted output)", async () => {
    enable()
    const res = await dispatchTool(
      call("edit"),
      configWith(echoTool("edit", "applied"), "builtin"),
      perm,
    )
    expect(res.preview).toBe("applied")
    expect(res.preview).not.toContain("<untrusted-source")
  })

  test('B4 — a file-content read is wrapped name="file" (file content is untrusted)', async () => {
    enable()
    const res = await dispatchTool(
      call("read"),
      configWith(echoTool("read", "file contents"), "builtin"),
      perm,
    )
    expect(res.preview).toContain('<untrusted-source name="file">')
  })
})

describe("C. redact-then-wrap order", () => {
  test("C1 — a secret in an mcp result is redacted INSIDE the envelope", async () => {
    enable()
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    const res = await dispatchTool(
      call("ext"),
      configWith(echoTool("ext", `key=${secret}`), "mcp"),
      perm,
    )
    expect(res.preview).toContain("<untrusted-source")
    expect(res.preview).not.toContain(secret)
  })
})
