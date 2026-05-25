import { Database } from "bun:sqlite"
import * as fsp from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runMemoryPhase2AutoTrigger } from "@/agent/memory-consolidator-hook"
import { distillSession, finalAssistantText } from "@/agent/memory-distill"
import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
import type {
  MemoryWriter,
  Phase1Port,
  Phase2Port,
  Phase2Summarizer,
  Stage1StorePort,
} from "@/memory"
import { MemoryWriter as FileMemoryWriter, Stage1Store as SqliteStage1Store } from "@/memory"
import { assembleMemoryAuto } from "@/memory/auto-trigger"
import { LlmPhase2Port } from "@/memory/consolidate"
import { ChildProcessGitPort } from "@/memory/consolidate/git"
import { resolveMemoryDirPaths } from "@/memory/consolidate/paths"
import type { NodeFsLike } from "@/memory/consolidate/writer"
import {
  DEFAULT_INJECT_MAX_BYTES,
  DefaultCrossSessionInjector,
  renderMemorySection,
} from "@/memory/cross-session"
import { JsonlFileStage1Store, type Stage1OutputsStore } from "@/memory/stage1-store"

const noopWarn = (_msg: string): void => {}

const nodeFsPort: NodeFsLike = {
  mkdir: (p, opts) => fsp.mkdir(p, opts),
  chmod: (p, mode) => fsp.chmod(p, mode),
  readFile: (p, enc) => fsp.readFile(p, enc),
  writeFile: (p, content, enc) => fsp.writeFile(p, content, enc),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (p) => fsp.unlink(p),
  access: (p) => fsp.access(p),
}

const asPhase1Messages = (
  rolloutMessages: ReadonlyArray<{ role: string; content: unknown }>,
): Message[] => rolloutMessages as Message[]

/** Wrap the existing L3 distiller into the Phase-1 consolidator port shape.
 *  The port stays deterministic and no-throw because `distillSession`
 *  already degrades to a heuristic fallback on model/parse failures. */
export const buildPhase1PortFromLlm = (llm: LLMPort): Phase1Port => ({
  async distill(args) {
    const messages = asPhase1Messages(args.rolloutMessages)
    const distilled = await distillSession(llm, messages, {
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })
    const summaryLines = distilled
      .map((entry) => entry.text.trim())
      .filter((line) => line.length > 0)
    const rawLines = distilled
      .map((entry) => `- [${entry.kind}] ${entry.text.trim()}`)
      .filter((line) => !line.endsWith("] "))
    const fallback = finalAssistantText(messages).trim()
    return {
      rolloutSummary: summaryLines.join("\n"),
      rawMemory: rawLines.join("\n") || fallback || "- no durable memory extracted",
      preferenceSignals: distilled
        .filter((entry) => entry.kind === "preference")
        .map((entry) => entry.text.trim())
        .filter((line) => line.length > 0),
    }
  },
})

/** Wrap an `LLMPort` into the Phase-2 summarizer callback shape documented on
 *  `Phase2Summarizer`. */
export const buildPhase2SummarizerFromLlm = (llm: LLMPort): Phase2Summarizer => {
  return async ({ system, userText, signal }) => {
    const events: StreamEvent[] = []
    let tokensUsed: number | undefined
    for await (const ev of llm.stream({
      system,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      tools: [],
      ...(signal !== undefined ? { signal } : {}),
    })) {
      events.push(ev)
      if (ev.type === "usage") {
        tokensUsed = ev.inputTokens + ev.outputTokens + (ev.cacheReadTokens ?? 0)
      }
    }
    const { message } = assembleFromEvents(events)
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim()
    return tokensUsed !== undefined ? { text, tokensUsed } : { text }
  }
}

export interface SessionStartMemoryInput {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stage1OutputsStore?: Stage1OutputsStore
  readonly phase2?: {
    readonly store: Stage1StorePort
    readonly writer: MemoryWriter
    readonly port: Phase2Port
  }
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly logWarn?: (msg: string) => void
}

export interface SessionStartMemoryResult {
  readonly sessionCtx?: string
}

export interface SessionMemoryAutoWires {
  readonly sessionCtx?: string
  readonly stage1OutputsStore: Stage1OutputsStore
  readonly memoryConsolidator: NonNullable<AgentConfig["memoryConsolidator"]>
}

export interface SessionMemoryAutoWireInput {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly llm: LLMPort
  readonly summarizerLlm?: LLMPort
  readonly sessionId: string
  readonly signal?: AbortSignal
  readonly homeDir?: string
  readonly now?: () => number
  readonly logWarn?: (msg: string) => void
}

const resolveStage1SqlitePath = (root: string): string => join(root, "stage1.sqlite")
const resolveStage1JsonlPath = (root: string): string => join(root, "stage1.jsonl")

/** Build the live CLI memory-auto wires around the existing ADR-0068 / ADR-0281
 *  primitives. Default-OFF: `QUANTA_MEMORY_AUTO !== "on"` ⇒ undefined. */
export const buildSessionMemoryAutoWires = async (
  input: SessionMemoryAutoWireInput,
): Promise<SessionMemoryAutoWires | undefined> => {
  const auto = assembleMemoryAuto(input.env)
  if (auto === null) return undefined

  const now = input.now ?? Date.now
  const logWarn = input.logWarn ?? noopWarn
  const paths = resolveMemoryDirPaths(input.homeDir ?? homedir())
  const stage1Db = new Database(resolveStage1SqlitePath(paths.root))
  stage1Db.exec("PRAGMA journal_mode = WAL")
  const phase1Store: Stage1StorePort = new SqliteStage1Store(stage1Db)
  const stage1OutputsStore = new JsonlFileStage1Store({
    filePath: resolveStage1JsonlPath(paths.root),
    now,
    onWarn: logWarn,
  })
  const writer = new FileMemoryWriter(paths, nodeFsPort, new ChildProcessGitPort(), { now })
  await writer.ensureDir()
  const phase2Port: Phase2Port = new LlmPhase2Port(
    buildPhase2SummarizerFromLlm(input.summarizerLlm ?? input.llm),
  )

  const start = await prepareSessionStartMemory({
    env: input.env,
    stage1OutputsStore,
    phase2: {
      store: phase1Store,
      writer,
      port: phase2Port,
    },
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    now,
    logWarn,
  })

  return {
    ...(start.sessionCtx !== undefined ? { sessionCtx: start.sessionCtx } : {}),
    stage1OutputsStore,
    memoryConsolidator: {
      enabled: true,
      port: buildPhase1PortFromLlm(input.llm),
      store: phase1Store,
      threadId: input.sessionId,
    },
  }
}

/** Session-start memory wire: render the stable cross-session block from the
 *  stage1 outputs store, then schedule the non-blocking Phase-2 auto-trigger
 *  when the host supplied the store/writer/port trio. */
export const prepareSessionStartMemory = async (
  input: SessionStartMemoryInput,
): Promise<SessionStartMemoryResult> => {
  const auto = assembleMemoryAuto(input.env)
  if (auto === null) return {}

  const logWarn = input.logWarn ?? noopWarn

  let sessionCtx: string | undefined
  if (input.stage1OutputsStore !== undefined) {
    const selected = new DefaultCrossSessionInjector({
      stage1Store: input.stage1OutputsStore,
    }).selectForInject({ maxBytes: DEFAULT_INJECT_MAX_BYTES })
    const rendered = renderMemorySection(selected).text.trim()
    sessionCtx = rendered.length > 0 ? rendered : undefined
  }

  if (input.phase2 !== undefined) {
    try {
      const existingContent = await input.phase2.writer.readExisting()
      const outcome = await runMemoryPhase2AutoTrigger(
        {
          phase2: {
            enabled: true,
            port: input.phase2.port,
            store: input.phase2.store,
            writer: input.phase2.writer,
            existingContent,
          },
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          now: input.now ?? Date.now,
        },
        (event) => {
          if (event.kind === "error") {
            logWarn(`session-start memory phase2 auto-trigger failed: ${event.message}`)
          }
        },
      )
      if (outcome.kind === "error") {
        logWarn(`session-start memory phase2 auto-trigger failed: ${outcome.message}`)
      }
    } catch (e) {
      logWarn(
        `session-start memory phase2 bootstrap failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  return sessionCtx !== undefined ? { sessionCtx } : {}
}
