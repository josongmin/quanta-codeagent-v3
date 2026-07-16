import { Database } from "bun:sqlite"
import { readFileSync, writeFileSync } from "node:fs"
import * as fsp from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runMemoryPhase2AutoTrigger } from "@/agent/memory-consolidator-hook"
import { distillSession, finalAssistantText } from "@/agent/memory-distill"
import { InMemoryLock } from "@/auth/lock-in-memory"
import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
import {
  assembleDreamPolicy,
  CrossSessionDreamTrigger,
  type DreamConfigView,
  type DreamConsolidatePort,
  type DreamState,
  type DreamStatePort,
  FileDreamWriteTarget,
  MemoryWriter as FileMemoryWriter,
  type MemoryWriter,
  type Phase1Port,
  type Phase2Port,
  type Phase2Summarizer,
  Stage1Store as SqliteStage1Store,
  type Stage1StorePort,
} from "@/memory"
import { assembleMemoryAuto } from "@/memory/auto-trigger"
import { ChildProcessGitPort } from "@/memory/consolidate/git"
import { resolveMemoryDirPaths } from "@/memory/consolidate/paths"
import { LlmPhase2Port } from "@/memory/consolidate/phase2-llm"
import { loadMemorySummary } from "@/memory/consolidate/reader"
import type { NodeFsLike } from "@/memory/consolidate/writer"
import {
  DEFAULT_INJECT_MAX_BYTES,
  DefaultCrossSessionInjector,
  renderMemorySection,
} from "@/memory/cross-session"
import { type DreamOutcomeKind, INITIAL_DREAM_STATE } from "@/memory/dream/types"
import { JsonlFileStage1Store, type Stage1OutputsStore } from "@/memory/stage1-store"
import { redactSecrets } from "@/security"
import { errMessage, gateOn, throwIfAborted } from "@/shared"

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

// ── H16 — cross-session "auto-dream" composition (default-OFF) ──────────────

/** System prompt for the dream consolidation pass — synthesize the accumulated
 *  cross-session memory entries into ONE durable, deduplicated team-knowledge
 *  note. No new facts; only consolidate + dedupe what is already promoted. */
const DREAM_CONSOLIDATE_SYSTEM =
  "You are consolidating cross-session memory. Given a list of durable memory " +
  "entries accumulated across prior sessions, produce ONE concise, deduplicated " +
  "markdown note capturing the stable, reusable knowledge. Merge duplicates, drop " +
  "ephemera, keep only what stays true across sessions. Output markdown only — no " +
  "preamble. Invent nothing beyond the provided entries."

/** Parse a strict-positive integer env value; undefined when absent/invalid so
 *  {@link assembleDreamPolicy} falls back to the documented default. */
const parsePositiveIntOrUndefined = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(n) && n > 0 ? n : undefined
}
const parsePositiveNumberOrUndefined = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number.parseFloat(raw.trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Valid `lastOutcome` enum values — anything else degrades to `null`. */
const DREAM_OUTCOME_KINDS: ReadonlySet<string> = new Set<DreamOutcomeKind>([
  "below_threshold",
  "locked",
  "completed",
  "no_op",
  "error",
])

/** Clamp a persisted session counter to a finite, non-negative integer. A
 *  NaN/Infinity/negative/fractional value would poison the cadence, so it
 *  degrades to 0 (negative) or its floor (fractional); non-finite ⇒ 0. */
const sanitizeCounter = (n: number): number => {
  if (!Number.isFinite(n)) return 0
  const floored = Math.floor(n)
  return floored > 0 ? floored : 0
}

/** Degrade an out-of-enum persisted `lastOutcome` to `null` (never surface a
 *  poisoned string verbatim). */
const sanitizeOutcome = (raw: unknown): DreamOutcomeKind | null =>
  typeof raw === "string" && DREAM_OUTCOME_KINDS.has(raw) ? (raw as DreamOutcomeKind) : null

/** JSON-file {@link DreamStatePort} — persists the tiny dream counter/clock at
 *  `<memoryRoot>/dream-state.json` so the sessions/hours cadence survives across
 *  CLI runs. Sync (the port contract); NO-THROW — a missing or corrupt file
 *  degrades to {@link INITIAL_DREAM_STATE} rather than crashing the dream pass. */
class JsonFileDreamState implements DreamStatePort {
  private readonly filePath: string
  constructor(filePath: string) {
    this.filePath = filePath
  }
  read(): DreamState {
    try {
      const obj = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<DreamState>
      if (typeof obj.sessionsSinceLastDream === "number") {
        // SANITIZE every persisted field — a corrupt counter must NOT pass
        // through. A NaN/Infinity/negative counter poisons the cadence
        // (`NaN + 1 >= threshold` is forever false; `-1000 + 1` takes 1000+
        // sessions to fire), so clamp to a finite, non-negative integer. A
        // non-finite clock degrades to `null`; an out-of-enum outcome to `null`.
        return {
          sessionsSinceLastDream: sanitizeCounter(obj.sessionsSinceLastDream),
          lastDreamAtMs:
            typeof obj.lastDreamAtMs === "number" && Number.isFinite(obj.lastDreamAtMs)
              ? obj.lastDreamAtMs
              : null,
          lastOutcome: sanitizeOutcome(obj.lastOutcome),
        }
      }
    } catch {
      // absent / unreadable / corrupt ⇒ initial state (never throw)
    }
    return INITIAL_DREAM_STATE
  }
  write(state: DreamState): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(state), "utf8")
    } catch {
      // best-effort: a disk hiccup must not crash session teardown
    }
  }
}

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
  readonly memorySummaryMd?: string
  readonly stage1OutputsStore: Stage1OutputsStore
  readonly memoryConsolidator: NonNullable<AgentConfig["memoryConsolidator"]>
  /** Release the per-session resources this wire bundle owns — namely the
   *  `bun:sqlite` WAL handle backing the Phase-1 Stage1Store (audit U7-10).
   *  Without this the file descriptor + WAL leak across every session that
   *  builds a fresh bundle. MUST be called on the session/runtime teardown
   *  path. Idempotent: closing an already-closed handle is swallowed so a
   *  double-dispose never throws. */
  dispose(): void
  /** Await the deferred Phase-1 consolidation lane (in-flight run PLUS any
   *  coalesced pending rerun). The consolidator block this bundle mints
   *  carries `defer`, so `runAgent` hands the distill off instead of
   *  blocking the turn-completion path on a full-rollout LLM call. MUST be
   *  awaited BEFORE {@link dispose} — the distill writes to the sqlite
   *  store dispose closes. Resolves immediately when nothing is in flight. */
  drain(): Promise<void>
  /** H16 — the cross-session auto-dream trigger, present ONLY when
   *  `QUANTA_AUTO_DREAM=1` (and memory-auto produced a cross-session store to
   *  dream over). The session host calls `onSessionEnd()` once at teardown;
   *  absent ⇒ no dream pass (byte-identical default-OFF). */
  dreamTrigger?: CrossSessionDreamTrigger
}

/** Single-flight + latest-pending lane for the deferred session-end Phase-1
 *  distill. `defer` never blocks the caller: when a run is already in flight
 *  the NEWEST closure replaces any queued one — each run distills a full
 *  rollout snapshot for the same threadId row, so the latest supersedes
 *  intermediates (last-write-wins, identical to the prior serialized
 *  behavior's final state, minus the redundant LLM spend). `drain` loops
 *  until the lane is empty so a coalesced rerun kicked during the await is
 *  also covered. */
const createDeferredConsolidationLane = (
  opts: {
    /** Fired ONCE per drain call that actually has to wait (an in-flight run
     *  exists) — the session-close path uses it to tell the operator WHY exit
     *  is pausing instead of waiting silently. Idle drains never fire it. */
    readonly onDrainWait?: () => void
  } = {},
): {
  defer: (run: () => Promise<unknown>) => void
  drain: () => Promise<void>
} => {
  let inflight: Promise<void> | null = null
  let pending: (() => Promise<unknown>) | null = null
  const kick = (run: () => Promise<unknown>): void => {
    if (inflight !== null) {
      pending = run
      return
    }
    inflight = run()
      // The hook is NO-THROW by contract; this belt keeps a hostile port from
      // wedging the lane (a rejected inflight would make drain loop forever).
      .catch(() => undefined)
      .then(() => {
        inflight = null
        const next = pending
        pending = null
        if (next !== null) kick(next)
      })
  }
  return {
    defer: kick,
    drain: async (): Promise<void> => {
      if (inflight === null) return
      try {
        opts.onDrainWait?.()
      } catch {
        // advisory observer — never wedge the drain
      }
      while (inflight !== null) await inflight
    },
  }
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

const selectSessionStartMemoryContext = (
  stage1OutputsStore: Stage1OutputsStore | undefined,
): string | undefined => {
  if (stage1OutputsStore === undefined) return undefined
  const selected = new DefaultCrossSessionInjector({
    stage1Store: stage1OutputsStore,
  }).selectForInject({ maxBytes: DEFAULT_INJECT_MAX_BYTES })
  const rendered = renderMemorySection(selected).text.trim()
  return rendered.length > 0 ? rendered : undefined
}

const warnPhase2Failure = (logWarn: (msg: string) => void, detail: string): void => {
  logWarn(`session-start memory phase2 auto-trigger failed: ${detail}`)
}

const runSessionStartPhase2AutoTrigger = async (
  input: NonNullable<SessionStartMemoryInput["phase2"]>,
  opts: {
    readonly signal?: AbortSignal
    readonly now?: () => number
    readonly logWarn: (msg: string) => void
  },
): Promise<void> => {
  try {
    const existingContent = await input.writer.readExisting()
    const outcome = await runMemoryPhase2AutoTrigger(
      {
        phase2: {
          enabled: true,
          port: input.port,
          store: input.store,
          writer: input.writer,
          existingContent,
        },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        now: opts.now ?? Date.now,
      },
      (event) => {
        if (event.kind === "error") warnPhase2Failure(opts.logWarn, event.message)
      },
    )
    if (outcome.kind === "error") warnPhase2Failure(opts.logWarn, outcome.message)
  } catch (e) {
    opts.logWarn(`session-start memory phase2 bootstrap failed: ${errMessage(e)}`)
  }
}

export const buildSessionMemoryAutoWires = async (
  input: SessionMemoryAutoWireInput,
): Promise<SessionMemoryAutoWires | undefined> => {
  const auto = assembleMemoryAuto(input.env)
  if (auto === null) return undefined

  const now = input.now ?? Date.now
  const logWarn = input.logWarn ?? noopWarn
  const paths = resolveMemoryDirPaths(input.homeDir ?? homedir())
  const writer = new FileMemoryWriter(paths, nodeFsPort, new ChildProcessGitPort(), { now })
  await writer.ensureDir()
  // T01 (audit L5 M-10): gate on the caller signal before opening the SQLite
  // store. `new Database(...)` (bun:sqlite) is a SYNCHRONOUS native open — once
  // it begins it cannot be interrupted, so the honest contract is a pre-flight
  // gate that fails fast when the session was already aborted, rather than
  // pretending the open itself is cancellable. Threaded after the (awaitable)
  // `ensureDir` so an abort during dir creation is caught here too.
  throwIfAborted(input.signal)
  const stage1Db = new Database(resolveStage1SqlitePath(paths.root))
  stage1Db.exec("PRAGMA journal_mode = WAL")
  const phase1Store: Stage1StorePort = new SqliteStage1Store(stage1Db)
  const stage1OutputsStore = new JsonlFileStage1Store({
    filePath: resolveStage1JsonlPath(paths.root),
    now,
    onWarn: logWarn,
  })
  const summarizer = buildPhase2SummarizerFromLlm(input.summarizerLlm ?? input.llm)
  const phase2Port: Phase2Port = new LlmPhase2Port(summarizer)

  // H16 — cross-session auto-dream trigger (default-OFF; reuses the stage1
  // store + summarizer + memory root just minted). The session host fires
  // `onSessionEnd()` once at teardown.
  const dreamTrigger = buildCrossSessionDreamTrigger({
    env: input.env,
    memoryRoot: paths.root,
    stage1OutputsStore,
    summarizer,
    now,
    logWarn,
  })

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
  const memorySummaryMd = await loadMemorySummary(paths, nodeFsPort)

  // U7-10: own the close of the WAL-mode SQLite handle opened above. The
  // handle is created HERE (not by Stage1Store), so the honest owner of its
  // teardown is this builder. `Database.close()` flushes + checkpoints the
  // WAL and releases the fd. We swallow a double-close (bun:sqlite throws on
  // a second `.close()`) so `dispose()` is idempotent.
  const dispose = (): void => {
    try {
      stage1Db.close()
    } catch {
      // Already closed (idempotent dispose) or a benign close error — never
      // surface from teardown.
    }
  }

  // Deferred consolidation lane — `runAgent` hands the session-end Phase-1
  // distill (a full-rollout LLM call) here instead of awaiting it inline, so
  // the surface's turn-completion path (spinner → turn summary → input) is
  // never blocked on memory bookkeeping. The host awaits `drain()` at session
  // close, BEFORE `dispose()` closes the sqlite store the distill writes to.
  // The wait notice fires only when close actually has to pause for an
  // in-flight distill (e.g. the operator quits right after a heavy turn) —
  // a silent multi-second exit hang reads as a wedge.
  const lane = createDeferredConsolidationLane({
    onDrainWait: () => logWarn("finishing in-flight memory consolidation before close…"),
  })

  return {
    ...(start.sessionCtx !== undefined ? { sessionCtx: start.sessionCtx } : {}),
    ...(memorySummaryMd !== undefined ? { memorySummaryMd } : {}),
    stage1OutputsStore,
    memoryConsolidator: {
      enabled: true,
      port: buildPhase1PortFromLlm(input.llm),
      store: phase1Store,
      redact: (content) => redactSecrets(content, { origin: "memory_distill" }).text,
      threadId: input.sessionId,
      defer: lane.defer,
    },
    dispose,
    drain: lane.drain,
    ...(dreamTrigger !== undefined ? { dreamTrigger } : {}),
  }
}

/**
 * H16 — build the cross-session `CrossSessionDreamTrigger` from the resolved
 * env view + the SAME memory substrate buildSessionMemoryAutoWires already
 * minted (the JSONL stage1 store + the LLM summarizer + the memory root). The
 * consolidate adapter REUSES the existing cross-session injector + Phase-2
 * summarizer (it does NOT reimplement consolidation); the team write target is
 * `<root>/team/cross-session.md` (NEVER the live MEMORY.md). Returns undefined
 * when `QUANTA_AUTO_DREAM` is off (byte-identical default-OFF).
 *
 * Lock: per-process `InMemoryLock` — sufficient for the session-end use (one
 * dream per process); cross-process exclusion (two CLIs ending at once) is an
 * accepted degradation (both dream, last write wins) pending a file-based lock.
 */
export const buildCrossSessionDreamTrigger = (deps: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly memoryRoot: string
  readonly stage1OutputsStore: Stage1OutputsStore
  readonly summarizer: Phase2Summarizer
  readonly now: () => number
  readonly logWarn: (msg: string) => void
}): CrossSessionDreamTrigger | undefined => {
  const view: DreamConfigView = {
    autoDream: gateOn(deps.env, "QUANTA_AUTO_DREAM"),
    autoDreamSessions: parsePositiveIntOrUndefined(deps.env.QUANTA_AUTO_DREAM_SESSIONS),
    autoDreamHours: parsePositiveNumberOrUndefined(deps.env.QUANTA_AUTO_DREAM_HOURS),
  }
  const slot = assembleDreamPolicy(view)
  if (slot === null) return undefined

  const consolidate: DreamConsolidatePort = {
    async consolidate({ signal }) {
      const entries = new DefaultCrossSessionInjector({
        stage1Store: deps.stage1OutputsStore,
      }).selectForInject({ maxBytes: DEFAULT_INJECT_MAX_BYTES })
      const section = renderMemorySection(entries).text.trim()
      if (section.length === 0) return { kind: "no_op" }
      const { text } = await deps.summarizer({
        system: DREAM_CONSOLIDATE_SYSTEM,
        userText: section,
        ...(signal !== undefined ? { signal } : {}),
      })
      const content = text.trim()
      return content.length > 0 ? { kind: "consolidated", content } : { kind: "no_op" }
    },
  }

  return new CrossSessionDreamTrigger({
    state: new JsonFileDreamState(join(deps.memoryRoot, "dream-state.json")),
    consolidate,
    writeTarget: new FileDreamWriteTarget({ memoryRoot: deps.memoryRoot, fs: nodeFsPort }),
    lock: new InMemoryLock({ now: deps.now }),
    now: deps.now,
    policy: slot.policy,
    holderId: `auto-dream-${process.pid}`,
    logWarn: deps.logWarn,
  })
}

export const prepareSessionStartMemory = async (
  input: SessionStartMemoryInput,
): Promise<SessionStartMemoryResult> => {
  const auto = assembleMemoryAuto(input.env)
  if (auto === null) return {}

  const logWarn = input.logWarn ?? noopWarn
  const sessionCtx = selectSessionStartMemoryContext(input.stage1OutputsStore)

  if (input.phase2 !== undefined) {
    await runSessionStartPhase2AutoTrigger(input.phase2, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
      logWarn,
    })
  }

  return sessionCtx !== undefined ? { sessionCtx } : {}
}
