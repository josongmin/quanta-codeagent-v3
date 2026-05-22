/**
 * Mode-preset runner — IDE (ADR-0092, C1).
 *
 * The `mode === "ide"` cell: editor-embedded (VS Code / Tauri). The HOST (the
 * IDE extension) drives the conversation — it seeds `req.base.messages`, owns
 * the `req.base.stream` (a structured event channel the editor UI consumes),
 * and supplies the reviewer modal via `req.base.onConfirm`. This server-side
 * runner only ASSEMBLES the ide-mode config (validating the matrix +
 * branch_search default-on) and runs the loop; the actual editor adapter lives
 * outside this repo (it injects stream/onConfirm/messages).
 *
 * Levers (see `agent/run-mode/presets.ts#IDE`): reviewer-backed permission,
 * user-stop, user-cwd, STRUCTURED output, host deps (IDE context provider +
 * full LSP tools), persistent memory, full-trajectory observation.
 *
 * branch_search default-on (ADR-0084): N=3, tsc+lint, worktree isolation —
 * IDE users get speculative N-best on hard edits unless the caller overrides.
 *
 * Slice boundary: imports `@/agent`, `@/llm`, `@/permission`, `@/shared`,
 * `@/tool`, `@/stream`, and sibling assemble.ts. NO mode-preset sibling import.
 */

import type { AgentConfig, BranchSearchConfig } from "@/agent"
import { buildSystemPrompt } from "@/agent"
import type { PermissionContext } from "@/permission"
import { StdoutStream, type StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  type AssembleRequest,
  assembleAgentConfig,
  type RunOutcome,
  resolveRunAgent,
} from "../assemble"
import { exitCodeForOutcome } from "../run"

/** IDE default branch_search: interactive budget (N=3, fast verifiers). */
const IDE_BRANCH_SEARCH: BranchSearchConfig = {
  defaultN: 3,
  defaultVerifierKinds: ["tsc", "lint"],
  timeoutPerBranchMs: 60_000,
  isolation: "worktree",
}

const buildIdeBase = (req: AssembleRequest): Omit<AgentConfig, "modePolicy" | "budgetMeter"> => {
  const cwd = req.base.cwd ?? process.cwd()
  // The IDE host normally injects a structured StreamPort; StdoutStream is a
  // safe fallback for a headless smoke of the ide assembly.
  const stream: StreamPort = req.base.stream ?? new StdoutStream()
  const permission: PermissionContext = req.base.permission ?? { mode: "default" }
  const registry =
    req.base.registry instanceof ToolRegistry ? req.base.registry : new ToolRegistry(defaultTools)
  return {
    ...req.base,
    llm: req.base.llm,
    registry,
    stream,
    permission,
    messages: req.base.messages ?? [],
    system: req.base.system ?? buildSystemPrompt(cwd),
    cwd,
    maxTurns: req.base.maxTurns ?? 200,
    signal: req.base.signal ?? new AbortController().signal,
    // branch_search default-on unless the caller already chose.
    branchSearch: req.base.branchSearch ?? IDE_BRANCH_SEARCH,
  }
}

export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "ide") {
    throw new Error(`ide.runMode: req.mode must be "ide", got "${req.mode}"`)
  }
  const base = buildIdeBase(req)
  const cfg = assembleAgentConfig({ ...req, base })
  const runner = resolveRunAgent(req.seams)
  const outcome = await runner(cfg)
  return { exitCode: exitCodeForOutcome(outcome), outcome }
}
