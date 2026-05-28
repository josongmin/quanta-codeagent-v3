/**
 * Mode-preset runner — INTERACTIVE.
 *
 * Unified-agent interactive now owns its own terminal host adapter and reuses
 * the runner loop directly instead of delegating across app surfaces.
 */

import * as readline from "node:readline/promises"
import type { AgentConfig } from "@/agent"
import { buildSystemPrompt } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import type { PermissionContext } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream, type StreamPort, TeeStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import {
  type AssembleRequest,
  assembleAgentConfig,
  type RunOutcome,
  resolveRunAgent,
} from "../assemble"
import { buildInteractiveTurnAssembler } from "../interactive-turn-assembler"
import { exitCodeForOutcome } from "../run"

interface PromptSourceLike {
  next(signal?: AbortSignal): Promise<string | null>
}

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

const makeAbortError = (): Error & { code?: string } => {
  const error = new Error("interactive session aborted") as Error & { code?: string }
  error.name = "AbortError"
  error.code = "ABORT_ERR"
  return error
}

const runInteractiveTerminal = async (req: AssembleRequest): Promise<void> => {
  const abort = new AbortController()
  const base = buildInteractiveBase(req, abort.signal)
  const { base: _base, mode: _mode, ...assemblerReq } = req
  const { runtime: runtimeFacade } = await createRuntimeFromAgentConfigBase({
    base,
    turnAssembler: buildInteractiveTurnAssembler(assemblerReq),
    history: [...base.messages],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  const session = await runtimeFacade.createSession({
    cwd: base.cwd,
    ...((req.base.llm as { model?: string }).model !== undefined
      ? { model: (req.base.llm as { model?: string }).model }
      : {}),
    permissionMode: base.permission.mode,
  })
  const reader = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  const onSigint = (): void => {
    abort.abort()
  }
  const promptSource: PromptSourceLike = {
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
    while (!abort.signal.aborted) {
      const next = await promptSource.next(abort.signal)
      if (next === null || abort.signal.aborted) break
      if (next === "") continue
      await session.input.append(next, undefined, { signal: abort.signal })
      await session.turn.run(undefined, { signal: abort.signal })
    }
  } finally {
    process.off("SIGINT", onSigint)
    reader.close()
    await session.close().catch(() => undefined)
    await runtimeFacade.close().catch(() => undefined)
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
  // ADR-0334 — interactive surface explicitly tags the cfg as ADR-0327-
  // family wired. `assembleAgentConfig` already attempted the install;
  // this redundant pass is documentary (idempotent — ADR-0332 §I).
  installCodexR2Wires(cfg, cfg.sessionId !== undefined ? { sessionId: cfg.sessionId } : {})

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
