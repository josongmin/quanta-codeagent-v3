/**
 * Workflow keyword nudge — CC "ultracode" parity (ADR-0417 sibling).
 *
 * A hard, deterministic keyword in the user's prompt opts THIS TURN into
 * multi-agent orchestration: the harness detects the word (regex, no model
 * judgment) and appends a `<system-reminder>` telling the model to reach for
 * the `run_workflow` tool. The MODEL still decides whether to actually call it
 * — the reminder is advice, not a forced call (mirrors CC's
 * `workflow_keyword_request`, which likewise injects a reminder rather than
 * invoking the tool itself).
 *
 * NUDGE-ONLY: this never flips the `run_workflow` gate. The reminder fires only
 * when the tool is ALREADY registered (QUANTA_WORKFLOW on + subagent enabled).
 * If workflow mode is off, the keyword is silently inert — no tool to nudge.
 *
 * Detection runs on the latest user TEXT, which `latestUserTextFromWm` only
 * surfaces on the turn right after a real prompt (tool_result turns return
 * `undefined`), so the nudge fires once per keyworded prompt, not every turn.
 * The reminder body deliberately omits the trigger word, so it can never
 * re-trigger detection when it becomes the latest user text on a no-tool-use
 * continuation turn.
 */

import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { latestUserTextFromWm } from "./loop/context-assembler"
import type { AgentConfig } from "./types"

/** Word-boundary anchored so `myUltracodeVar` / `ultracoder` / paths don't
 *  false-positive (same discipline as the effort-classifier keyword rules). */
export const WORKFLOW_KEYWORD_PATTERN = /\bultracode\b/i

/** Pure, no-throw keyword test on the user's prompt text. */
export const detectWorkflowKeyword = (text: string | undefined): boolean => {
  if (typeof text !== "string" || text.length === 0) return false
  try {
    WORKFLOW_KEYWORD_PATTERN.lastIndex = 0
    return WORKFLOW_KEYWORD_PATTERN.test(text)
  } catch {
    return false
  }
}

/** The reminder body. MUST NOT contain the trigger word (self-retrigger
 *  safety) and MUST name `run_workflow` so the model knows the target tool. */
export const WORKFLOW_NUDGE_MARKER =
  "The user's message opted this turn into multi-agent orchestration — use the " +
  "`run_workflow` tool (emit a declarative WorkflowSpec) to fulfill the request " +
  "by fanning out subagents, rather than handling it inline. If the task does " +
  "not actually benefit from orchestration, you may proceed normally."

const NUDGE_TEXT = `<system-reminder>\n${WORKFLOW_NUDGE_MARKER}\n</system-reminder>`

/** The registered name of the tool the nudge points at. Exported so a guard
 *  test can pin it against the REAL `createRunWorkflowTool().name` — a rename of
 *  either side would otherwise make the nudge silently inert. */
export const WORKFLOW_TOOL_NAME = "run_workflow"

/**
 * Append the workflow nudge when the latest user prompt carries the keyword AND
 * `run_workflow` is registered. No-op otherwise. Idempotent across the agentic
 * loop (tool_result turns surface no user text; the reminder body omits the
 * keyword so it never re-fires off its own text).
 */
export const injectWorkflowKeywordNudge = (cfg: AgentConfig, wm: WorkingMemory<Message>): void => {
  if (!detectWorkflowKeyword(latestUserTextFromWm(wm))) return
  // NUDGE-ONLY — never flip the gate; only nudge toward an available tool.
  if (cfg.registry?.has(WORKFLOW_TOOL_NAME) !== true) return
  wm.append({ role: "user", content: [{ type: "text", text: NUDGE_TEXT }] })
}
