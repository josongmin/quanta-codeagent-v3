/**
 * Workflow keyword nudge (CC "ultracode" parity, nudge-only).
 *
 * Hard keyword in the user's prompt ⇒ inject a `<system-reminder>` opting that
 * turn into `run_workflow`. NUDGE-ONLY: we never flip the gate — the reminder
 * fires only when `run_workflow` is already registered (QUANTA_WORKFLOW on +
 * subagent). The harness does the deterministic keyword detection; the MODEL
 * decides whether to actually call the tool (the reminder is advice, not a
 * forced call) — mirroring CC's `workflow_keyword_request` system-reminder.
 *
 * PURE detector + wiring against a real WorkingMemory + ToolRegistry.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent/types"
import {
  detectWorkflowKeyword,
  injectWorkflowKeywordNudge,
  WORKFLOW_NUDGE_MARKER,
} from "@/agent/workflow-keyword"
import type { Message, Tool } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { ToolRegistry } from "@/tool"

// ── pure detector ────────────────────────────────────────────────────────────

describe("detectWorkflowKeyword — hard keyword match", () => {
  test("matches the bare keyword + case-insensitive + embedded in a sentence", () => {
    expect(detectWorkflowKeyword("ultracode")).toBe(true)
    expect(detectWorkflowKeyword("please Ultracode this audit")).toBe(true)
    expect(detectWorkflowKeyword("refactor the parser ULTRACODE")).toBe(true)
  })

  test("word-boundary anchored: no false positive inside concatenated identifiers", () => {
    expect(detectWorkflowKeyword("myUltracodeVar")).toBe(false) // no boundary before
    expect(detectWorkflowKeyword("ultracoder")).toBe(false) // no boundary after (suffix)
    expect(detectWorkflowKeyword("ultracodes")).toBe(false)
    // KNOWN limitation (same as effort-classifier's \b rules): a hyphen IS a
    // word boundary, so `ultracode-dir` matches the bare token. Tolerated — the
    // nudge is advisory and the reminder tells the model to proceed normally if
    // orchestration doesn't fit.
    expect(detectWorkflowKeyword("/path/ultracode-dir/x")).toBe(true)
  })

  test("undefined / empty ⇒ false (no-throw)", () => {
    expect(detectWorkflowKeyword(undefined)).toBe(false)
    expect(detectWorkflowKeyword("")).toBe(false)
  })

  test("the nudge reminder itself does NOT contain the trigger word (self-retrigger safe)", () => {
    // The injected reminder must never re-trigger detection when it becomes the
    // latest user text on a no-tool-use continuation turn.
    expect(detectWorkflowKeyword(WORKFLOW_NUDGE_MARKER)).toBe(false)
  })
})

// ── wiring (nudge-only) ──────────────────────────────────────────────────────

const fakeRunWorkflowTool = (): Tool =>
  ({
    name: "run_workflow",
    description: "x",
    inputSchema: { safeParse: () => ({ success: true, data: {} }) },
    isReadOnly: () => false,
    run: async () => ({ ok: true, output: "" }),
  }) as unknown as Tool

const cfgWith = (tools: Tool[]): AgentConfig =>
  ({ registry: new ToolRegistry(tools) }) as unknown as AgentConfig

const userText = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] })

const lastText = (wm: ReturnType<typeof createWorkingMemory<Message>>): string | undefined => {
  const snap = wm.snapshot()
  const last = snap[snap.length - 1]
  return last?.content[0]?.type === "text" ? last.content[0].text : undefined
}

describe("injectWorkflowKeywordNudge — nudge-only wiring", () => {
  test("keyword + run_workflow registered ⇒ appends a system-reminder pointing at run_workflow", () => {
    const cfg = cfgWith([fakeRunWorkflowTool()])
    const wm = createWorkingMemory<Message>([userText("do the audit ultracode")])
    injectWorkflowKeywordNudge(cfg, wm)

    expect(wm.snapshot().length).toBe(2)
    const txt = lastText(wm) ?? ""
    expect(txt.startsWith("<system-reminder>")).toBe(true)
    expect(txt).toContain("run_workflow")
  })

  test("keyword present but run_workflow NOT registered ⇒ no-op (nudge-only, gate untouched)", () => {
    const cfg = cfgWith([]) // workflow off ⇒ tool absent
    const wm = createWorkingMemory<Message>([userText("do the audit ultracode")])
    injectWorkflowKeywordNudge(cfg, wm)
    expect(wm.snapshot().length).toBe(1)
  })

  test("no keyword ⇒ no-op even with the tool registered", () => {
    const cfg = cfgWith([fakeRunWorkflowTool()])
    const wm = createWorkingMemory<Message>([userText("just fix the bug")])
    injectWorkflowKeywordNudge(cfg, wm)
    expect(wm.snapshot().length).toBe(1)
  })

  test("idempotent: latest message is a tool_result (turn 2+) ⇒ no re-inject", () => {
    const cfg = cfgWith([fakeRunWorkflowTool()])
    const wm = createWorkingMemory<Message>([
      userText("do it ultracode"),
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
    ])
    injectWorkflowKeywordNudge(cfg, wm)
    expect(wm.snapshot().length).toBe(3) // unchanged
  })

  test("self-retrigger guard: latest user text IS the nudge ⇒ no re-inject", () => {
    const cfg = cfgWith([fakeRunWorkflowTool()])
    const wm = createWorkingMemory<Message>([userText("do it ultracode")])
    injectWorkflowKeywordNudge(cfg, wm) // first inject
    injectWorkflowKeywordNudge(cfg, wm) // second call must NOT stack a duplicate
    expect(wm.snapshot().length).toBe(2)
  })
})
