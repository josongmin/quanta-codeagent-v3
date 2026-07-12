/**
 * Mode-preset runner — INTERACTIVE.
 *
 * Unified-agent interactive now owns its own terminal host adapter and reuses
 * the runner loop directly instead of delegating across app surfaces.
 */

import * as readline from "node:readline/promises"
import type { AgentConfig } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { loadRepoRules } from "@/agent/repo-rules"
import type { PermissionContext } from "@/permission"
import { type ApprovalResolver, driveSessionTurn } from "@/runner/orchestrate"
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
import { resolveModePresetPromptSurfaceProfile, resolveModePresetSystemPrompt } from "./system"

interface PromptSourceLike {
  next(signal?: AbortSignal): Promise<string | null>
}

/** The minimal line-question surface the approval resolver needs (the live
 *  `readline` interface satisfies it; tests inject a scripted fake). */
export interface ApprovalQuestionIO {
  question(prompt: string, opts?: { signal?: AbortSignal }): Promise<string>
}

/**
 * WS-A (jul-10, UUX-1-04) — the interactive preset's operator approval
 * resolver. The prior loop ran bare `session.turn.run` with NO approval
 * resolution: a tool that requested approval left the session parked at
 * `awaiting_approval` forever (an interactive surface that could never answer).
 *
 * Reuses the ONE readline the prompt loop already owns (never a second stdin
 * consumer) and speaks the standard 3-verb CLI dialect: [y]es / [a]lways
 * session / [N]o (fail-closed default deny — mirrors the REPL's deferred
 * prompt in `runtime-context-compose.ts`).
 */
export const buildInteractiveApprovalResolver =
  (io: ApprovalQuestionIO, signal: AbortSignal): ApprovalResolver =>
  async (approval) => {
    process.stderr.write(`Approval required: ${approval.reason}\n`)
    const ans = (
      await io.question("Approve pending action? [y]es / [a]lways session / [N]o ", { signal })
    )
      .trim()
      .toLowerCase()
    if (ans === "y" || ans === "yes") return "approve"
    if (ans === "a" || ans === "always") return { decision: "approve", scope: "session" }
    return "deny"
  }

const buildInteractiveBase = async (
  req: AssembleRequest,
  signal: AbortSignal,
): Promise<Omit<AgentConfig, "modePolicy" | "budgetMeter">> => {
  const cwd = req.base.cwd ?? process.cwd()
  const promptSurfaceProfile = resolveModePresetPromptSurfaceProfile(req.mode, req.base.system)
  const surfaceStream = new StdoutStream()
  const stream: StreamPort = new TeeStream([req.base.stream, surfaceStream])
  const permission: PermissionContext = req.base.permission ?? { mode: "default" }
  const registry =
    req.base.registry !== undefined && req.base.registry instanceof ToolRegistry
      ? req.base.registry
      : new ToolRegistry(buildDefaultTools())
  // WS4 (jul-12 OmO absorption, self-audit 04 §4) — the interactive surface is a
  // human driving a real repo, so it MUST honor repo-local rules (AGENTS.md /
  // CLAUDE.md). The whole downstream render already exists (context-assembler →
  // prompt.ts renderRepoRulesBlock → four-section project_md); only this seam was
  // missing, so a repo's rules reached bench prompts but never the interactive
  // model. A caller override on `req.base.repoRules` wins; else load from cwd.
  // Fail-open: a broken/absent rule file must never break the session start.
  // Bench sandboxes / agent forks intentionally do NOT go through this preset, so
  // their byte-identical rule-less posture (AgentConfig.repoRules doc) is unchanged.
  const repoRules = req.base.repoRules ?? (await loadRepoRules(cwd).catch(() => undefined))
  return {
    ...req.base,
    llm: req.base.llm,
    registry,
    stream,
    permission,
    messages: req.base.messages ?? [],
    system: resolveModePresetSystemPrompt(req.mode, req.base.system, cwd),
    ...(promptSurfaceProfile !== undefined ? { promptSurfaceProfile } : {}),
    ...(repoRules !== undefined ? { repoRules } : {}),
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
  // T01 (audit L5 M-6): one cancel point per mode. The interactive surface owns
  // a local controller for its own SIGINT handler, but it MUST also honor the
  // composition-root signal (an upstream abort / parent cancel) — previously it
  // ignored `req.base.signal` entirely. Compose the two so EITHER source stops
  // the REPL loop. `AbortSignal.any` propagates the first to fire.
  const abort = new AbortController()
  const signal: AbortSignal = AbortSignal.any([req.base.signal, abort.signal])
  const base = await buildInteractiveBase(req, signal)
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
  // WS-A (jul-10, UUX-1-04) — approvals are resolvable: the turn runs through
  // the SSOT driver (`driveSessionTurn`), which drains the approval loop via
  // the operator resolver above. The prior bare `session.turn.run` parked the
  // session at `awaiting_approval` with no way to answer.
  const resolveApproval = buildInteractiveApprovalResolver(reader, signal)
  try {
    process.on("SIGINT", onSigint)
    // Loop on the COMPOSED signal so an upstream composition-root abort ends the
    // REPL just like a local SIGINT does (audit L5 M-6).
    while (!signal.aborted) {
      const next = await promptSource.next(signal)
      if (next === null || signal.aborted) break
      if (next === "") continue
      try {
        await driveSessionTurn({
          session,
          resolveApproval,
          text: next,
          turnSignal: signal,
          env: process.env,
        })
      } catch (error) {
        // A NORMAL approval deny aborts THE TURN (driver contract), not the
        // whole interactive session — report and keep prompting. Anything else
        // (incl. an upstream abort) propagates as before.
        if (!signal.aborted && error instanceof Error && /approval denied/.test(error.message)) {
          process.stderr.write(`${error.message} — turn aborted, session continues.\n`)
          continue
        }
        throw error
      }
    }
  } finally {
    process.off("SIGINT", onSigint)
    reader.close()
    await session.close().catch(() => undefined)
    await runtimeFacade.close().catch(() => undefined)
  }
  if (signal.aborted) throw makeAbortError()
}

const stubBase = (req: AssembleRequest): Promise<Omit<AgentConfig, "modePolicy" | "budgetMeter">> =>
  // T01 (audit L5 M-6): the seam path (stubbed runner) reuses the composition-
  // root signal directly; the dead throwaway controller is removed.
  buildInteractiveBase(req, req.base.signal)

export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "interactive") {
    throw new Error(`interactive.runMode: req.mode must be "interactive", got "${req.mode}"`)
  }
  const cfg = assembleAgentConfig({ ...req, base: await stubBase(req) })
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
