/**
 * Mode-preset runner — INTERACTIVE.
 *
 * Unified-agent interactive now owns its own terminal host adapter and reuses
 * the runner loop directly instead of delegating across app surfaces.
 */

import * as readline from "node:readline/promises"
import type { AgentConfig } from "@/agent"
import { buildSystemPrompt } from "@/agent"
import type { PermissionContext } from "@/permission"
import { runInteractive } from "@/runner"
import { StdoutStream, type StreamPort, TeeStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import {
  type AssembleRequest,
  assembleAgentConfig,
  type RunOutcome,
  resolveRunAgent,
} from "../assemble"
import { exitCodeForOutcome } from "../run"

const buildInteractiveBase = (
  req: AssembleRequest,
  signal: AbortSignal,
): Omit<AgentConfig, "modePolicy" | "budgetMeter"> => {
  const cwd = req.base.cwd ?? process.cwd()
  const surfaceStream = new StdoutStream()
  const stream: StreamPort = new TeeStream([req.base.stream, surfaceStream])
  const permission: PermissionContext = req.base.permission ?? { mode: "default" }
  const registry =
    req.base.registry !== undefined && req.base.registry instanceof ToolRegistry
      ? req.base.registry
      : new ToolRegistry(buildDefaultTools())
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
    signal,
  }
}

const buildInteractiveDeps = (
  base: Omit<AgentConfig, "modePolicy" | "budgetMeter">,
): Parameters<typeof runInteractive>[0]["deps"] => ({
  llm: base.llm,
  registry: base.registry,
  stream: base.stream,
  permission: base.permission,
  system: base.system,
  cwd: base.cwd,
  maxTurns: base.maxTurns,
  signal: base.signal,
  onConfirm: base.onConfirm ?? (async () => false),
  store: base.store,
  sessionId: base.sessionId ?? crypto.randomUUID(),
  embedder: base.embedder,
  memoryConfig: base.memory,
  planMode: base.planMode === true,
  metrics: base.metrics,
  run: base.run,
  subagentConfig: base.subagent,
  skillsConfig: base.skills,
  compactionBreakerConfig: base.compactionBreaker,
  verifyGuardConfig: base.verifyGuard,
  summarizerLlm: base.compaction?.summarizerLlm,
  onShellEvent: base.onShellEvent,
  workMetricsSink: base.workMetricsSink,
  ...(base.followUpQueue !== undefined ? { followUpQueue: base.followUpQueue } : {}),
  ...(base.planStore !== undefined ? { planStore: base.planStore } : {}),
  ...(base.retrievalStack !== undefined ? { retrievalStack: base.retrievalStack } : {}),
  ...(base.searchPipeline !== undefined ? { searchPipeline: base.searchPipeline } : {}),
  ...(base.memoryConsolidator !== undefined ? { memoryConsolidator: base.memoryConsolidator } : {}),
  ...(base.delegation !== undefined ? { delegation: base.delegation } : {}),
  ...(base.subagentBackground !== undefined ? { subagentBackground: base.subagentBackground } : {}),
  ...(base.autoBackground !== undefined ? { autoBackground: base.autoBackground } : {}),
  ...(base.fork !== undefined ? { fork: base.fork } : {}),
  ...(base.forkSession !== undefined ? { forkSession: base.forkSession } : {}),
  ...(base.conversationCheckpoint !== undefined
    ? { conversationCheckpoint: base.conversationCheckpoint }
    : {}),
  ...(base.automationEngine !== undefined ? { automationEngine: base.automationEngine } : {}),
  ...(base.admissibility !== undefined ? { admissibility: base.admissibility } : {}),
  ...(base.planExitPort !== undefined ? { planExitPort: base.planExitPort } : {}),
  ...(base.userInputPort !== undefined ? { userInputPort: base.userInputPort } : {}),
  ...(base.shellSnapshot !== undefined ? { shellSnapshot: base.shellSnapshot } : {}),
  ...(base.sessionEffort !== undefined ? { sessionEffort: base.sessionEffort } : {}),
  ...(base.decisionEmitter !== undefined ? { decisionEmitter: base.decisionEmitter } : {}),
})

const makeAbortError = (): Error & { code?: string } => {
  const error = new Error("interactive session aborted") as Error & { code?: string }
  error.name = "AbortError"
  error.code = "ABORT_ERR"
  return error
}

const runInteractiveTerminal = async (req: AssembleRequest): Promise<void> => {
  const abort = new AbortController()
  const base = buildInteractiveBase(req, abort.signal)
  const deps = buildInteractiveDeps(base)
  const reader = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  const onSigint = (): void => {
    abort.abort()
  }
  const promptSource: Parameters<typeof runInteractive>[0]["promptSource"] = {
    next: async (signal) => {
      try {
        const line = await reader.question("> ", { signal })
        const trimmed = line.trim()
        if (trimmed === "/exit" || trimmed === "/quit") return null
        return trimmed
      } catch (error) {
        const err = error as Error & { code?: string }
        if (signal?.aborted || err.name === "AbortError" || err.code === "ABORT_ERR") return null
        throw error
      }
    },
  }
  try {
    process.on("SIGINT", onSigint)
    await runInteractive({
      deps,
      assembleConfig: (messages, turnDeps) =>
        assembleAgentConfig({
          ...req,
          base: {
            ...base,
            messages,
            signal: turnDeps.signal,
          },
        }),
      promptSource,
      history: [...base.messages],
      state: undefined,
      idMeta: undefined,
      signal: abort.signal,
    })
  } finally {
    process.off("SIGINT", onSigint)
    reader.close()
  }
  if (abort.signal.aborted) throw makeAbortError()
}

const stubBase = (req: AssembleRequest): Omit<AgentConfig, "modePolicy" | "budgetMeter"> =>
  buildInteractiveBase(req, req.base.signal ?? new AbortController().signal)

export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "interactive") {
    throw new Error(`interactive.runMode: req.mode must be "interactive", got "${req.mode}"`)
  }
  const cfg = assembleAgentConfig({ ...req, base: stubBase(req) })

  if (req.seams?.runAgent) {
    const runner = resolveRunAgent(req.seams)
    const outcome = await runner(cfg)
    return { exitCode: exitCodeForOutcome(outcome), outcome }
  }

  const replOverride = req.seams?.runRepl
  try {
    if (replOverride !== undefined) await replOverride()
    else await runInteractiveTerminal(req)
    return { exitCode: 0 }
  } catch (error) {
    const err = error as Error & { code?: string }
    if (err.name === "AbortError" || err.code === "ABORT_ERR") return { exitCode: 130 }
    throw error
  }
}
