/**
 * Mode-preset runner — DAEMON (ADR-0092, C1).
 *
 * The `mode === "daemon"` cell: a long-running scheduled service (nightly PR
 * review, webhook responder). The scheduler/host seeds the task on
 * `req.base.messages` and owns the persistent-state store; this runner
 * assembles the daemon-mode config (per-instance worktree sandbox, allowlist
 * network, branch-only git, persistent memory, structured output) and runs ONE
 * task to completion. Persistent cron-to-cron state is the host's concern
 * (it reuses `req.base.store` + `req.base.sessionId`); this runner is the
 * single-task executor.
 *
 * branch_search default-on (ADR-0084): N=3, tsc+lint+lsp_diag, worktree.
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

/** Daemon default branch_search: diagnostic-rich verifiers (next-day review). */
const DAEMON_BRANCH_SEARCH: BranchSearchConfig = {
  defaultN: 3,
  defaultVerifierKinds: ["tsc", "lint", "lsp_diag"],
  timeoutPerBranchMs: 90_000,
  isolation: "worktree",
}

const buildDaemonBase = (req: AssembleRequest): Omit<AgentConfig, "modePolicy" | "budgetMeter"> => {
  const cwd = req.base.cwd ?? process.cwd()
  const stream: StreamPort = req.base.stream ?? new StdoutStream()
  // No human ⇒ auto/acceptEdits within the allowlist (network/gitWrite levers
  // enforce the boundary; permission just clears in-scope edits).
  const permission: PermissionContext = req.base.permission ?? { mode: "acceptEdits" }
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
    maxTurns: req.base.maxTurns ?? 40,
    signal: req.base.signal ?? new AbortController().signal,
    branchSearch: req.base.branchSearch ?? DAEMON_BRANCH_SEARCH,
  }
}

export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "daemon") {
    throw new Error(`daemon.runMode: req.mode must be "daemon", got "${req.mode}"`)
  }
  const base = buildDaemonBase(req)
  const cfg = assembleAgentConfig({ ...req, base })
  const runner = resolveRunAgent(req.seams)
  const outcome = await runner(cfg)
  return { exitCode: exitCodeForOutcome(outcome), outcome }
}
