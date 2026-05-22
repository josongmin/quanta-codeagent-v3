/**
 * Mode dispatch e2e — closes the L3 gap for `review` / `audit` mode notices
 * (catalog row 6.3 / ADR-0018). Existing coverage:
 *   - `tests/unit/mode.test.ts`: pure helpers (`resolveAgentMode`,
 *     `isMutatingToolBlockedInMode`, `modeBlockReason`).
 *   - `tests/unit/admissibility-gate.test.ts:330-356`: gate-level block with
 *     preview tag (`review-blocked` / `audit-blocked`).
 *
 * The runAgent layer was unverified. THIS test closes it by exercising the
 * complete admissibility chain THROUGH the real loop — ScriptedLLM tries to
 * call a mutating tool, dispatch denies it, the loop converts the deny into a
 * `tool_result.ok=false` event whose preview text carries the mode-specific
 * reason, the LLM gets a second turn, and the run completes (mode is a
 * posture, not an abort signal).
 *
 * Five scenarios — one per blocking mode + one happy-path control:
 *   1. `mode:"plan"`   blocks a `write` call (preview contains "plan-blocked")
 *   2. `mode:"review"` blocks a `write` call (preview contains "review-blocked")
 *   3. `mode:"audit"`  blocks a `write` call (preview contains "audit-blocked")
 *   4. `mode:"default"` ALLOWS the same `write` call (control, prevents
 *      future regressions that over-block).
 *   5. Read-only tool in `audit` mode → NOT blocked (read-only passes any mode).
 *
 * Each blocking case includes a follow-up text turn so the loop actually
 * reaches `completed` — a regression that crashed the loop on dispatch deny
 * would surface here, not just in the gate-level unit test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentMode } from "@/agent"
import { runAgent } from "@/agent"
import type { AgentEvent } from "@/stream"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/** Mutating tool stub — never actually writes, just records that execute
 *  was reached. If it WAS reached in plan/review/audit mode, the test fails:
 *  the gate is the only thing keeping it from running. */
const captureWriteTool = (executions: { count: number }): Tool => ({
  name: "captured_write",
  description: "Mutating tool that records every successful invocation.",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute() {
    executions.count += 1
    yield { type: "result", result: { ok: true, output: "WROTE (would-be-leak)" } }
  },
})

const captureReadTool = (executions: { count: number }): Tool => ({
  name: "captured_read",
  description: "Read-only tool that records every invocation.",
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute() {
    executions.count += 1
    yield { type: "result", result: { ok: true, output: "READ-OK" } }
  },
})

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mode-block-e2e-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

type BlockingMode = Extract<AgentMode, "plan" | "review" | "audit">

const runBlocked = async (
  mode: BlockingMode,
): Promise<{
  outcome: { reason: string }
  events: AgentEvent[]
  executions: number
}> => {
  const executions = { count: 0 }
  const writeStub = captureWriteTool(executions)
  const llm = new ScriptedLLM([
    ev(toolUse("w-1", "captured_write", { path: "/tmp/x", content: "data" })),
    ev(text(`acknowledged ${mode}-block`)),
  ])
  const stream = new RecordingStream()
  const config = cfg({
    llm,
    registry: new ToolRegistry([...defaultTools, writeStub]),
    stream,
    cwd: dir,
    mode,
  })
  const outcome = await withTimeout(runAgent(config), 10_000, `mode-block:${mode}`)
  return { outcome, events: stream.events, executions: executions.count }
}

describe("Mode dispatch e2e — runAgent honours plan/review/audit gating", () => {
  test("plan mode blocks a write tool; loop completes; preview carries 'plan'/'mode' reason", async () => {
    // ADR-0036 L4 (plan-mode-dispatch-block): the dispatch-seam guard
    // now pre-empts the admissibility-gate's `plan-blocked` arm for
    // dispatchTool callers. Custom `captured_write` is absent from
    // MUTATING_TOOL_TABLE → guard returns deny with preview "mode-blocked"
    // and the typed UnknownToolError message that names the table.
    // The CONTRACT this test pins: the deny carries SOMETHING about the
    // mode block — match either the legacy preview or the new one.
    const { outcome, events, executions } = await runBlocked("plan")
    expect(outcome.reason).toBe("completed")
    expect(executions).toBe(0) // tool execute() must NEVER have been reached

    const result = events.find((e) => e.type === "tool_result" && e.name === "captured_write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      const lower = result.preview.toLowerCase()
      expect(lower === "mode-blocked" || lower.includes("plan")).toBe(true)
    }
  }, 15_000)

  test("review mode blocks a write tool; loop completes; preview carries 'review' reason", async () => {
    const { outcome, events, executions } = await runBlocked("review")
    expect(outcome.reason).toBe("completed")
    expect(executions).toBe(0)

    const result = events.find((e) => e.type === "tool_result" && e.name === "captured_write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      expect(result.preview.toLowerCase()).toContain("review")
    }
  }, 15_000)

  test("audit mode blocks a write tool; loop completes; preview carries 'audit' reason", async () => {
    const { outcome, events, executions } = await runBlocked("audit")
    expect(outcome.reason).toBe("completed")
    expect(executions).toBe(0)

    const result = events.find((e) => e.type === "tool_result" && e.name === "captured_write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      expect(result.preview.toLowerCase()).toContain("audit")
    }
  }, 15_000)

  test("default mode ALLOWS the same write tool (control: no over-blocking regression)", async () => {
    const executions = { count: 0 }
    const writeStub = captureWriteTool(executions)
    const llm = new ScriptedLLM([
      ev(toolUse("w-2", "captured_write", { path: "/tmp/y", content: "data" })),
      ev(text("done")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([...defaultTools, writeStub]),
      stream,
      cwd: dir,
      mode: "default",
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "mode-control:default")
    expect(outcome.reason).toBe("completed")
    expect(executions.count).toBe(1) // execute() WAS reached in default mode

    const result = stream.events.find(
      (e) => e.type === "tool_result" && e.name === "captured_write",
    )
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(true)
      expect(result.preview).toContain("WROTE")
    }
  }, 15_000)

  test("audit mode does NOT block a read-only tool (read-only passes every mode)", async () => {
    const executions = { count: 0 }
    const readStub = captureReadTool(executions)
    const llm = new ScriptedLLM([
      ev(toolUse("r-1", "captured_read", { path: "/tmp/z" })),
      ev(text("read in audit ok")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([...defaultTools, readStub]),
      stream,
      cwd: dir,
      mode: "audit",
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "mode-readonly-audit")
    expect(outcome.reason).toBe("completed")
    expect(executions.count).toBe(1) // read-only tool DID run under audit

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "captured_read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(true)
    }
  }, 15_000)
})
