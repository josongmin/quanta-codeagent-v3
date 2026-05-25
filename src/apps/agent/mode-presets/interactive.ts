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

const buildInteractiveOptionalDeps = (
  base: Omit<AgentConfig, "modePolicy" | "budgetMeter">,
): Partial<Parameters<typeof runInteractive>[0]["deps"]> => {
  const optional: Partial<Parameters<typeof runInteractive>[0]["deps"]> = {}
  const assignIfDefined = <K extends keyof Parameters<typeof runInteractive>[0]["deps"]>(
    key: K,
    value: Parameters<typeof runInteractive>[0]["deps"][K] | undefined,
  ): void => {
    if (value !== undefined) optional[key] = value
  }
  assignIfDefined("followUpQueue", base.followUpQueue)
  assignIfDefined("planStore", base.planStore)
  assignIfDefined("retrievalStack", base.retrievalStack)
  assignIfDefined("searchPipeline", base.searchPipeline)
  assignIfDefined("memoryConsolidator", base.memoryConsolidator)
  assignIfDefined("delegation", base.delegation)
  assignIfDefined("subagentBackground", base.subagentBackground)
  assignIfDefined("autoBackground", base.autoBackground)
  assignIfDefined("fork", base.fork)
  assignIfDefined("forkSession", base.forkSession)
  assignIfDefined("conversationCheckpoint", base.conversationCheckpoint)
  assignIfDefined("automationEngine", base.automationEngine)
  assignIfDefined("admissibility", base.admissibility)
  assignIfDefined("planExitPort", base.planExitPort)
  assignIfDefined("userInputPort", base.userInputPort)
  assignIfDefined("shellSnapshot", base.shellSnapshot)
  assignIfDefined("sessionEffort", base.sessionEffort)
  assignIfDefined("decisionEmitter", base.decisionEmitter)
  return optional
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
  onConfirm: async (action) => {
    const result = await (base.onConfirm?.(action) ?? false)
    return typeof result === "boolean" ? result : result.decision === "allow"
  },
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
  ...buildInteractiveOptionalDeps(base),
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
