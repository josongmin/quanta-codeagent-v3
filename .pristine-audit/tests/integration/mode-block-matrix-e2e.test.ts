/**
 * Mode-dispatch matrix e2e — feature-catalog L3-F "review/audit mode notice"
 * promotion to L4 (ADR-0018 / Codex `mode-and-plan-process-audit.md` mirror).
 *
 * Sibling file `mode-block-e2e.test.ts` already closes the mutating-tool gate
 * with the `write` tool name as the witness across plan/review/audit and the
 * default control. That covers the gate code path but leaves two gaps the
 * catalog promotion requires:
 *
 *   1. TOOL-NAME COVERAGE — the gate keys off `isReadOnly()`, but a future
 *      cosmetic refactor (e.g. accidentally hard-coding `name === "write"`)
 *      would not trip the existing suite. We exercise the matrix
 *        { default | plan | review | audit } × { edit | write |
 *          scripted_replace | bash }
 *      so every mutating built-in name is a witness; 12 cells block, 4 cells
 *      pass (the default-row control prevents an over-block regression).
 *
 *   2. PER-TURN MODE NOTICE — the prompt-side companion of the gate. Phase 3
 *      adds REVIEW_NOTICE / AUDIT_NOTICE (and revises PLAN_NOTICE) into the
 *      trailing `<system-reminder>` built by `buildTurnContext`. The notice
 *      is what TELLS the model the posture; the gate is what ENFORCES it. We
 *      assert each notice rides on the first turn for its mode, and that
 *      `default` carries NO notice (byte-identical with the legacy path).
 *
 * Hermetic: real `runAgent` + ScriptedLLM. No filesystem writes — every
 * mutating tool is overridden by a same-named stub via the registry's
 * last-write-wins semantics (Map.set in `ToolRegistry`), so the gate decides
 * solely on `isReadOnly()` and the stub records whether `execute()` was
 * reached. A reached execute() in a blocking mode is the bug we are catching.
 *
 * Mode notices live in a USER message (the trailing `<system-reminder>`), not
 * in `StreamInput.system` — `buildTurnContext` keeps the system prompt
 * byte-stable for the provider cache (ADR-0003). The assertions scan the LAST
 * user message of the first scripted call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentMode } from "@/agent"
import { runAgent } from "@/agent"
import type { Message } from "@/llm"
import type { AgentEvent } from "@/stream"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/** Build a mutating-tool stub that shadows a built-in by name. The registry
 *  is a Map keyed by tool name, so the last entry wins — passing
 *  `[...defaultTools, mutatingStub("edit", counter)]` replaces the real
 *  `edit` tool with a stub that NEVER touches disk and records every
 *  invocation. If the gate is correct, `executions.count` stays 0 in the
 *  three blocking modes. */
const mutatingStub = (name: string, executions: { count: number }): Tool => ({
  name,
  description: `${name} stub — records every execute() reach.`,
  // A permissive schema so the same stub can stand in for tools with very
  // different input shapes (edit/write/scripted_replace/bash). The gate runs
  // BEFORE input validation, so even a malformed input would not trip it; we
  // accept any object so the happy-path control still completes.
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute() {
    executions.count += 1
    yield { type: "result", result: { ok: true, output: `${name}-stub-ok` } }
  },
})

const TOOLS: readonly string[] = ["edit", "write", "scripted_replace", "bash"] as const

type BlockingMode = Extract<AgentMode, "plan" | "review" | "audit">
const BLOCKING_MODES: readonly BlockingMode[] = ["plan", "review", "audit"] as const

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mode-block-matrix-e2e-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** One matrix cell: scripted LLM tries `toolName` once, then closes the turn
 *  with a text message. Returns the stream events, tool execution counter,
 *  and outcome so the per-mode assertion picks what it cares about. */
const runCell = async (
  mode: AgentMode,
  toolName: string,
): Promise<{
  outcome: { reason: string }
  events: AgentEvent[]
  executions: number
  inputs: ScriptedLLM["inputs"]
}> => {
  const executions = { count: 0 }
  const stub = mutatingStub(toolName, executions)
  const llm = new ScriptedLLM([
    // Input shape is intentionally permissive — the schema accepts anything,
    // so the same scripted call exercises every mutating tool name.
    ev(toolUse(`m-${toolName}-1`, toolName, { path: "/tmp/x", content: "data" })),
    ev(text(`acknowledged ${mode}/${toolName}`)),
  ])
  const stream = new RecordingStream()
  const config = cfg({
    llm,
    // Override the real built-in (same name) with the stub — Map.set wins.
    registry: new ToolRegistry([...defaultTools, stub]),
    stream,
    cwd: dir,
    mode,
  })
  const outcome = await withTimeout(runAgent(config), 15_000, `mode-matrix:${mode}/${toolName}`)
  return { outcome, events: stream.events, executions: executions.count, inputs: llm.inputs }
}

/** Pull the trailing `<system-reminder>` user message that `buildTurnContext`
 *  appends — that is where the mode notice rides per ADR-0003 (cache prefix
 *  stays byte-stable; per-turn dynamic context rides as a user reminder). */
const lastUserReminderText = (messages: Message[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== "user") continue
    if (!Array.isArray(m.content)) continue
    const block = m.content.find((c) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined
    if (block?.text.includes("<system-reminder>")) return block.text
  }
  return undefined
}

describe("Mode-dispatch matrix e2e — every mutating built-in name × every mode", () => {
  for (const tool of TOOLS) {
    for (const mode of BLOCKING_MODES) {
      test(`${mode} mode blocks ${tool}; loop completes; preview names the mode`, async () => {
        const { outcome, events, executions } = await runCell(mode, tool)
        expect(outcome.reason).toBe("completed")
        // The single most important assertion: a blocked mutating tool MUST
        // NOT have reached execute(). If this flips, the gate has regressed
        // and a write tool ran under a read-only mode posture.
        expect(executions).toBe(0)

        const result = events.find((e) => e.type === "tool_result" && e.name === tool)
        expect(result).toBeDefined()
        if (result && result.type === "tool_result") {
          expect(result.ok).toBe(false)
          // ADR-0036 L4 (plan-mode-dispatch-block): for `mode==='plan'`
          // the dispatch-seam guard now pre-empts the admissibility-gate's
          // `plan-blocked` arm and returns preview "mode-blocked" (plus
          // the typed PlanModeMutatingBlockedError message in the body).
          // For `review`/`audit` the seam projects to "default" so the
          // legacy admissibility-gate still drives the block with the
          // mode-named preview. Accept either form.
          const lower = result.preview.toLowerCase()
          expect(lower === "mode-blocked" || lower.includes(mode)).toBe(true)
        }
      }, 15_000)
    }

    test(`default mode ALLOWS ${tool} (control: no over-block regression)`, async () => {
      const { outcome, events, executions } = await runCell("default", tool)
      expect(outcome.reason).toBe("completed")
      // In the default posture mutating tools MUST run — the gate is
      // mode-keyed, not name-keyed. A 0 here would mean a regression that
      // started blocking by name.
      expect(executions).toBe(1)
      const result = events.find((e) => e.type === "tool_result" && e.name === tool)
      expect(result).toBeDefined()
      if (result && result.type === "tool_result") {
        expect(result.ok).toBe(true)
        expect(result.preview).toContain(`${tool}-stub-ok`)
      }
    }, 15_000)
  }
})

describe("Mode notice e2e — REVIEW/AUDIT/PLAN injection into the per-turn reminder", () => {
  // Per-mode signature phrases lifted from the canonical notice strings in
  // `src/agent/prompt.ts` (PLAN_NOTICE / REVIEW_NOTICE / AUDIT_NOTICE). We
  // match a distinctive uppercased header so a future cosmetic body edit
  // (e.g. tightening the wording) does not cascade into this test, but a
  // wholesale removal / mis-routing of the notice still trips it.
  const NOTICE_SIGNATURE: Record<BlockingMode, string> = {
    plan: "PLAN MODE is active",
    review: "REVIEW MODE is active",
    audit: "AUDIT MODE is active",
  }

  for (const mode of BLOCKING_MODES) {
    test(`${mode} mode injects its notice into the trailing system-reminder`, async () => {
      const { inputs } = await runCell(mode, "write")
      const first = inputs[0]
      expect(first).toBeDefined()
      if (!first) return
      const reminder = lastUserReminderText(first.messages)
      expect(reminder).toBeDefined()
      // The notice rides INSIDE the `<system-reminder>...</system-reminder>`
      // wrapper that `buildTurnContext` builds. Asserting on the wrapper +
      // signature together catches both regressions: missing notice AND
      // notice that escaped the wrapper.
      expect(reminder).toContain("<system-reminder>")
      expect(reminder).toContain(NOTICE_SIGNATURE[mode])

      // Cross-mode isolation: the OTHER blocking modes' notices must NOT
      // leak into this turn. A regression that emitted all notices at once
      // (e.g. removed the `if/return` in `modeNotice`) would slip past a
      // single positive assertion.
      for (const other of BLOCKING_MODES) {
        if (other === mode) continue
        expect(reminder).not.toContain(NOTICE_SIGNATURE[other])
      }
    }, 15_000)
  }

  test("default mode injects NO mode notice (byte-identical with the legacy path)", async () => {
    const { inputs } = await runCell("default", "write")
    const first = inputs[0]
    expect(first).toBeDefined()
    if (!first) return
    const reminder = lastUserReminderText(first.messages)
    // The reminder block may still exist (date / cwd live there), but it
    // MUST NOT carry any mode-notice signature. A regression that emitted a
    // notice in default mode would shift the prefix and break the cache.
    for (const m of BLOCKING_MODES) {
      if (reminder) expect(reminder).not.toContain(NOTICE_SIGNATURE[m])
    }
  }, 15_000)
})
