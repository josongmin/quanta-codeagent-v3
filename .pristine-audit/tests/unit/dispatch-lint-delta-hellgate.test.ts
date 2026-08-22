/**
 * ★ CONTRACT — ADR-0472 edit lint-delta wired into dispatch.
 *
 * After a path-bearing edit (`edit`/`write`), dispatch brackets the tool with a
 * pre/post diagnostics snapshot (via the wired `DiagnosticsProvider`) and
 * appends the INTRODUCED-lint delta (post − pre) to the model-facing output, so
 * the model sees exactly what its edit broke.
 *   - Gate OFF (default) ⇒ byte-identical: no delta, no provider call.
 *   - Gate ON + an introduced diagnostic ⇒ delta appended.
 *   - Gate ON + no introduced diagnostic ⇒ output unchanged (no noise).
 *   - A non-edit tool ⇒ never bracketed.
 *   - A provider that returns null (unsupported file) ⇒ graceful, no delta.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { LLMPort, StreamEvent, StreamInput, ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  type Tool,
  type ToolEvent,
  ToolRegistry,
} from "@/tool"

const editTool = (name: string): Tool => ({
  name,
  description: "edit test tool",
  inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "applied" } }
  },
})

const errItem = (msg: string): DiagnosticItem => ({
  severity: "error",
  message: msg,
  range: { start: { line: 3, character: 5 } },
  code: "TS2322",
})

/** Stateful provider: successive `diagnostics()` calls return `snapshots[i]`, so
 *  the pre-snapshot and post-snapshot differ. `open` returns null when configured. */
const provider = (snapshots: DiagnosticItem[][], openNull = false): DiagnosticsProvider => {
  let i = 0
  const session: DiagnosticsSession = {
    diagnostics: async () => snapshots[Math.min(i++, snapshots.length - 1)] ?? [],
    stop: async () => {},
  }
  return {
    unavailableReason: () => "n/a",
    open: async () => (openNull ? null : session),
  }
}

/** Minimal LLMPort whose stream yields a fixed reply — enough to prove dispatch
 *  ROUTES to the active repair loop (the loop mechanics are exhaustively tested
 *  in edit-repair-wire-hellgate). */
const fakeLlm = (reply: string): LLMPort => ({
  model: "fast-test",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: reply }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

const cfg = (tool: Tool, diag?: DiagnosticsProvider, llm?: LLMPort): AgentConfig =>
  ({
    registry: new ToolRegistry([tool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...(diag !== undefined ? { diagnosticsProvider: diag } : {}),
    ...(llm !== undefined ? { llm } : {}),
  }) as AgentConfig

const call = (name: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input: { path: "src/x.ts" },
})
const perm: PermissionContext = { mode: "acceptEdits" }

let root: string | null = null
const origPerm = process.env.QUANTA_PERMISSION_STATE
const origGate = process.env.QUANTA_EDIT_REPAIR_LOOP

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-lint-"))
  process.env.QUANTA_PERMISSION_STATE = join(root, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
  if (origPerm === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = origPerm
  if (origGate === undefined) delete process.env.QUANTA_EDIT_REPAIR_LOOP
  else process.env.QUANTA_EDIT_REPAIR_LOOP = origGate
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const enable = () => {
  process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
  __resetRuntimeConfig()
}

describe("A. gate OFF — byte-identical", () => {
  test("A1 — no delta even with a provider when gate unset", async () => {
    const res = await dispatchTool(
      call("edit"),
      cfg(editTool("edit"), provider([[], [errItem("x")]])),
      perm,
    )
    expect(res.preview).toBe("applied")
    expect(res.preview).not.toContain("Lint delta")
  })
})

describe("B. gate ON — introduced-lint delta", () => {
  test("B1 — an introduced diagnostic is appended", async () => {
    enable()
    const res = await dispatchTool(
      call("edit"),
      cfg(editTool("edit"), provider([[], [errItem("Type mismatch")]])),
      perm,
    )
    expect(res.preview).toContain("applied")
    expect(res.preview).toContain("Lint delta")
    expect(res.preview).toContain("Type mismatch")
  })

  test("B2 — no NEW diagnostic ⇒ output unchanged (pre==post)", async () => {
    enable()
    const pre = [errItem("pre-existing")]
    const res = await dispatchTool(call("edit"), cfg(editTool("edit"), provider([pre, pre])), perm)
    expect(res.preview).toBe("applied")
    expect(res.preview).not.toContain("Lint delta")
  })

  test("B3 — a non-edit tool is never bracketed", async () => {
    enable()
    const res = await dispatchTool(
      call("grep"),
      cfg(editTool("grep"), provider([[], [errItem("x")]])),
      perm,
    )
    expect(res.preview).toBe("applied")
    expect(res.preview).not.toContain("Lint delta")
  })

  test("B4 — provider open()==null (unsupported file) ⇒ graceful, no delta", async () => {
    enable()
    const res = await dispatchTool(
      call("edit"),
      cfg(editTool("edit"), provider([[], [errItem("x")]], true)),
      perm,
    )
    expect(res.preview).toBe("applied")
    expect(res.preview).not.toContain("Lint delta")
  })

  test("B5 — no provider wired ⇒ no delta (byte-identical)", async () => {
    enable()
    const res = await dispatchTool(call("edit"), cfg(editTool("edit")), perm)
    expect(res.preview).toBe("applied")
    expect(res.preview).not.toContain("Lint delta")
  })

  test("B6 — llm wired + introduced lint ⇒ dispatch ROUTES to the active repair loop", async () => {
    enable()
    // Provider yields enough snapshots for the bracket (pre/post) + the loop's
    // checks. A non-edit reply ⇒ reactor can't clear ⇒ loop ends "not green",
    // which still proves the ACTIVE branch ran (the "[edit-repair]" marker is
    // emitted ONLY by the active path, never the passive lint-delta).
    const res = await dispatchTool(
      call("edit"),
      cfg(
        editTool("edit"),
        provider([[], [errItem("x")], [errItem("x")], [errItem("x")]]),
        fakeLlm("no edit"),
      ),
      perm,
    )
    expect(res.preview).toContain("[edit-repair]")
  })
})
