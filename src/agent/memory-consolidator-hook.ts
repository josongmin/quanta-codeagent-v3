/**
 * ADR-0068 Wave D — session-end consolidator hook (L4 wire).
 *
 * Pure wiring around `runPhase1`: turns the agent's session-end signal +
 * the host-injected `Phase1Port` / `Stage1StorePort` + the final outcome
 * into a Phase1Input, calls `runPhase1`, and converts the result into
 * either a no-op (skip) OR a non-fatal logged side effect (success / error).
 *
 * Contract:
 *   - NO-THROW: every internal failure (port throw, store throw, missing
 *     port) is caught and surfaced via the injected `log` callback so the
 *     session-finishing path is never derailed by a consolidator bug.
 *   - DEFAULT-OFF: the caller decides whether to invoke this hook at all
 *     (it lives outside `runAgent` so an absent `memoryConsolidator` is
 *     zero allocation).
 *   - FORCE_SUMMARIZATION: SOTA Cursor mirror — when the host sets
 *     `forceSummarization: true`, the consolidator's `memoryMode` is
 *     forced to `"enabled"` regardless of host opt-in, so the per-thread
 *     turn-count cap is the only remaining skip condition.
 */
import type { Message } from "@/llm"
import type { MemoryWriter } from "@/memory"
import {
  PHASE2_AUTO_TRIGGER_MAX_AGE_MS,
  PHASE2_AUTO_TRIGGER_PENDING,
  Phase1DistillError,
  type Phase1Input,
  type Phase1Outcome,
  type Phase1Port,
  type Phase2Input,
  type Phase2Outcome,
  type Phase2Port,
  runPhase1,
  runPhase2,
  type Stage1StorePort,
  type WatermarkState,
} from "@/memory"
import { errMessage } from "@/shared"

/** Outcome of a session-end consolidator attempt. Mirrors `Phase1Outcome`
 *  shape but adds the structured-skip arms the hook itself can produce
 *  (no port / no store / no thread id / consolidator-disabled). */
export type ConsolidatorHookOutcome =
  | { kind: "distilled"; durationMs: number; threadId: string }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "error"; message: string }

/** Skip reasons surfaced by the hook layer (distinct from Phase1's own
 *  skip reasons which are surfaced verbatim in the same enum). The two
 *  sets are merged at the hook boundary so a consumer sees ONE skip
 *  taxonomy regardless of where the skip fired. */
export type SkipReason =
  | "consolidator_disabled"
  | "session_errored"
  | "port_missing"
  | "store_missing"
  | "thread_id_missing"
  | "memory_mode_disabled"
  | "turns_below_threshold"
  | "no_messages"
  | "thread_id_empty"

/** Optional redactor port (Slice S9 Part C). Applied to each rollout
 *  message's text-content BEFORE it is handed to {@link Phase1Port.distill}.
 *
 *  CRITICAL: this is the abstracted seam — callers MUST wire a real
 *  redactor (e.g. `src/security/redaction.ts#redactSecrets`) here; the
 *  pattern internals NEVER leak into this module.
 *
 *  Default (omitted) ⇒ identity (`s ⇒ s`) so existing callers stay
 *  byte-identical. */
export type DistillRedactor = (s: string) => string

/** Inputs the hook reads from the loop. Narrow shape so callers can
 *  unit-test the hook against scripted values without standing up a full
 *  `AgentConfig`. */
export interface ConsolidatorHookInput {
  /** Was the session successful? Hook is no-op when false. */
  readonly sessionOk: boolean
  /** ADR-0068 consolidator opt-in surface (from `AgentConfig.memoryConsolidator`). */
  readonly consolidator:
    | {
        enabled?: boolean
        forceSummarization?: boolean
        port?: Phase1Port
        store?: Stage1StorePort
        threadId?: string
        /** Optional redactor — see {@link DistillRedactor}. */
        redact?: DistillRedactor
      }
    | undefined
  /** Session id — fallback for `threadId` when consolidator.threadId is unset. */
  readonly sessionId: string | undefined
  /** Final rollout (the loop's `wm.snapshot()` cast to the structural
   *  shape Phase1 expects). */
  readonly rolloutMessages: ReadonlyArray<Message>
  /** Real (non-meta) turn count from the session — drives the
   *  MIN_TURN_THRESHOLD skip arm. */
  readonly turnCount: number
  /** Optional caller cancellation propagated to the Phase 1 port. */
  readonly signal?: AbortSignal
  /** Injected clock — defaults to `Date.now`. */
  readonly now?: () => number
}

/** Apply the optional redactor to a single rollout message. We only walk
 *  string-leaf content here — structured arrays (tool_use/tool_result
 *  blocks) are JSON-serialized into a string and re-parsed by Phase1's
 *  prompt-builder, so applying redaction at the JSON-string level catches
 *  every text payload uniformly without the consolidator needing to know
 *  the block taxonomy. Identity redactor returns the original (default-OFF
 *  bytes-identical). */
const applyRedactor = (
  msg: { role: string; content: unknown },
  redact: DistillRedactor | undefined,
): { role: string; content: unknown } => {
  if (redact === undefined) return msg
  if (typeof msg.content === "string") {
    return { role: msg.role, content: redact(msg.content) }
  }
  // Structured content: redact each text block; preserve shape otherwise.
  if (Array.isArray(msg.content)) {
    const next = msg.content.map((b): unknown => {
      if (b !== null && typeof b === "object" && "type" in b && b.type === "text" && "text" in b) {
        const t = (b as { text: unknown }).text
        if (typeof t === "string") return { ...b, text: redact(t) }
      }
      return b
    })
    return { role: msg.role, content: next }
  }
  return msg
}

/** Non-fatal logger — emit a structured event so the session finishes
 *  cleanly while the operator can still see what happened. The session
 *  is already wrapping up; we MUST NOT throw. */
export type ConsolidatorHookLogger = (event: ConsolidatorHookOutcome) => void

/** Run the consolidator hook. ALL failure paths return an outcome — the
 *  function never throws (its no-throw contract is what lets `runAgent`'s
 *  finally call it without a defensive try/catch). */
export const runMemoryConsolidatorHook = async (
  input: ConsolidatorHookInput,
  log?: ConsolidatorHookLogger,
): Promise<ConsolidatorHookOutcome> => {
  const result = await runMemoryConsolidatorHookInner(input)
  log?.(result)
  return result
}

const runMemoryConsolidatorHookInner = async (
  input: ConsolidatorHookInput,
): Promise<ConsolidatorHookOutcome> => {
  const cfg = input.consolidator
  // Opt-in: consolidator must be configured AND either `enabled` true OR
  // `forceSummarization` true (SOTA Cursor — explicit manual trigger).
  if (cfg === undefined) {
    return { kind: "skipped", reason: "consolidator_disabled" }
  }
  if (cfg.enabled !== true && cfg.forceSummarization !== true) {
    return { kind: "skipped", reason: "consolidator_disabled" }
  }
  // Session-error skip: a session that ended in error should not have
  // its tainted rollout fed to the distill (RolloutTaintedError semantics
  // at the consolidator layer would still catch a malicious payload, but
  // we skip earlier to save the LLM call). `forceSummarization` does NOT
  // override this — a force is intent-to-distill on success, not on a
  // failed run.
  if (!input.sessionOk) {
    return { kind: "skipped", reason: "session_errored" }
  }
  // Required ports/store: absent ⇒ structured skip (no throw). A host
  // that sets `enabled: true` but forgets the port/store learns via the
  // log, the session still finishes cleanly.
  if (cfg.port === undefined) {
    return { kind: "skipped", reason: "port_missing" }
  }
  if (cfg.store === undefined) {
    return { kind: "skipped", reason: "store_missing" }
  }
  const threadId = cfg.threadId ?? input.sessionId
  if (threadId === undefined || threadId.length === 0) {
    return { kind: "skipped", reason: "thread_id_missing" }
  }
  const phase1Input: Phase1Input = {
    threadId,
    sessionId: input.sessionId ?? threadId,
    rolloutMessages: input.rolloutMessages.map((m) =>
      applyRedactor({ role: m.role, content: m.content }, cfg.redact),
    ),
    turnCount: input.turnCount,
    // SOTA Cursor `force_summarization` — bypass the host's opt-in by
    // forcing memoryMode=enabled. The MIN_TURN_THRESHOLD cap still
    // applies in the consolidator itself (force does not over-ride the
    // "no signal in tiny conversations" floor).
    memoryMode: cfg.forceSummarization === true || cfg.enabled === true ? "enabled" : "disabled",
    ...(input.signal ? { signal: input.signal } : {}),
    now: input.now ?? Date.now,
  }
  let outcome: Phase1Outcome
  try {
    outcome = await runPhase1(phase1Input, cfg.port, cfg.store)
  } catch (e) {
    if (e instanceof Phase1DistillError) {
      return { kind: "error", message: `Phase1DistillError: ${e.message}` }
    }
    const message = errMessage(e)
    return { kind: "error", message }
  }
  if (outcome.kind === "skipped") {
    return { kind: "skipped", reason: outcome.reason }
  }
  return { kind: "distilled", durationMs: outcome.durationMs, threadId }
}

// ─── Phase 2 session-start auto-trigger hook (Slice S9 Part B) ────────────
//
// Mirror of the session-end Phase 1 hook: pure orchestration around
// `runPhase2` that fires NON-BLOCKING when ADR-0068 trigger thresholds are
// met. Lives outside `runAgent` so an absent `phase2` block is zero
// allocation (default-OFF / RFC §1.2). Errors are swallowed by the
// non-blocking scheduler — they MUST NOT crash the session-start path.

/** Outcome of the session-start Phase 2 auto-trigger check. The hook
 *  ALWAYS returns synchronously with an outcome describing whether it
 *  scheduled a Phase 2 run; the actual `runPhase2` call (if scheduled)
 *  runs in the background and surfaces via the `log` callback when it
 *  resolves or rejects. */
export type Phase2AutoTriggerOutcome =
  | { kind: "scheduled"; reason: Phase2TriggerReason }
  | { kind: "skipped"; reason: Phase2SkipReason }
  | { kind: "error"; message: string }

export type Phase2TriggerReason = "pending_count" | "age_exceeded"
export type Phase2SkipReason =
  | "phase2_disabled"
  | "port_missing"
  | "store_missing"
  | "writer_missing"
  | "summarizer_missing"
  | "below_thresholds"
  | "already_running"

/** Inputs to the Phase 2 auto-trigger hook. Each port is REQUIRED for an
 *  actual run; an absent port surfaces as a structured skip (no throw). */
export interface Phase2AutoTriggerInput {
  /** Opt-in surface (defaults absent ⇒ no-op).
   *
   *  When set, the hook reads:
   *   - `store` (Stage1StorePort)  — for countSince/getWatermark
   *   - `port`  (Phase2Port)       — wraps the LLM summarizer
   *   - `writer` (MemoryWriter)    — 3-file atomic writer
   *   - `existingContent`          — pre-read prior {memoryMd, rawMemoriesMd,
   *      memorySummaryMd} (caller fetches with writer.readExisting()) */
  readonly phase2:
    | {
        enabled?: boolean
        port?: Phase2Port
        store?: Stage1StorePort
        writer?: MemoryWriter
        /** Caller supplies the prior on-disk contents (null for missing
         *  files). Decouples the auto-trigger from filesystem reads. */
        existingContent?: {
          memoryMd: string | null
          rawMemoriesMd: string | null
          memorySummaryMd: string | null
        }
        /** Mode for the run. Default `"incremental"`. */
        mode?: "INIT" | "incremental"
      }
    | undefined
  /** Optional caller cancellation propagated to the Phase 2 port. */
  readonly signal?: AbortSignal
  /** Injected clock — defaults to `Date.now`. */
  readonly now?: () => number
}

/** Logger for the eventual background result. Same no-throw contract as
 *  the session-end hook's logger. */
export type Phase2AutoTriggerLogger = (
  event:
    | { kind: "scheduled"; reason: Phase2TriggerReason }
    | { kind: "skipped"; reason: Phase2SkipReason }
    | { kind: "completed"; outcome: Phase2Outcome }
    | { kind: "error"; message: string },
) => void

/** Process-local in-flight guard. Prevents two near-simultaneous
 *  session-starts (same process) from double-firing a Phase 2 run while
 *  the first is still in flight. The guard is keyed by the writer
 *  instance so distinct memory dirs (test isolation) do not collide. */
const _inflight = new WeakSet<MemoryWriter>()

/** Schedule a Phase 2 auto-trigger run if thresholds are met. The check
 *  itself runs synchronously (cheap SQLite count + watermark read); when
 *  it decides to fire, the actual `runPhase2` call is dispatched into the
 *  background (microtask) and its result/error is delivered to `log`.
 *
 *  The hook ITSELF is no-throw — every failure path returns an outcome.
 *  A rejected background `runPhase2` surfaces via the log callback (the
 *  `kind:"error"` variant) and is otherwise swallowed; a session-start
 *  that fires this hook MUST NOT be derailed by a Phase 2 bug. */
export const runMemoryPhase2AutoTrigger = async (
  input: Phase2AutoTriggerInput,
  log?: Phase2AutoTriggerLogger,
): Promise<Phase2AutoTriggerOutcome> => {
  const result = await runPhase2AutoTriggerInner(input, log)
  log?.(result)
  return result
}

/** Pre-flight: validate every required field. Returns either the resolved
 *  triple (port/store/writer) OR a structured skip outcome. Pulled out so
 *  the orchestrator's cyclomatic complexity stays under the lint cap. */
type Phase2ResolvedCfg = NonNullable<Phase2AutoTriggerInput["phase2"]> & {
  port: Phase2Port
  store: Stage1StorePort
  writer: MemoryWriter
}

const validatePhase2Cfg = (
  cfg: Phase2AutoTriggerInput["phase2"],
): Phase2ResolvedCfg | { kind: "skipped"; reason: Phase2SkipReason } => {
  if (cfg === undefined || cfg.enabled !== true) {
    return { kind: "skipped", reason: "phase2_disabled" }
  }
  if (cfg.port === undefined) return { kind: "skipped", reason: "port_missing" }
  if (cfg.store === undefined) return { kind: "skipped", reason: "store_missing" }
  if (cfg.writer === undefined) return { kind: "skipped", reason: "writer_missing" }
  if (_inflight.has(cfg.writer)) {
    return { kind: "skipped", reason: "already_running" }
  }
  return { ...cfg, port: cfg.port, store: cfg.store, writer: cfg.writer }
}

/** Map (pendingCount, ageMs) → trigger reason or null. Pending-count wins
 *  over age when both fire, so the reason stays deterministic. */
const pickTriggerReason = (pendingCount: number, ageMs: number): Phase2TriggerReason | null => {
  if (pendingCount >= PHASE2_AUTO_TRIGGER_PENDING) return "pending_count"
  if (ageMs >= PHASE2_AUTO_TRIGGER_MAX_AGE_MS && pendingCount > 0) return "age_exceeded"
  return null
}

/** Schedule the actual `runPhase2` call as a fire-and-forget microtask.
 *  Errors surface via the log callback only (never propagate). */
const dispatchPhase2Background = (
  phase2Input: Phase2Input,
  cfg: Phase2ResolvedCfg,
  log: Phase2AutoTriggerLogger | undefined,
): void => {
  _inflight.add(cfg.writer)
  queueMicrotask(() => {
    runPhase2(phase2Input, cfg.port, cfg.store, cfg.writer)
      .then((outcome) => {
        log?.({ kind: "completed", outcome })
      })
      .catch((e: unknown) => {
        log?.({ kind: "error", message: errMessage(e) })
      })
      .finally(() => {
        _inflight.delete(cfg.writer)
      })
  })
}

const runPhase2AutoTriggerInner = async (
  input: Phase2AutoTriggerInput,
  log: Phase2AutoTriggerLogger | undefined,
): Promise<Phase2AutoTriggerOutcome> => {
  const v = validatePhase2Cfg(input.phase2)
  if ("kind" in v) return v
  // Read thresholds. countSince(lastSuccessAt) counts rows since the last
  // successful Phase 2; first-run (lastSuccessAt === null) treats all rows
  // as pending and the age branch fires via POSITIVE_INFINITY.
  let watermark: WatermarkState
  let pendingCount: number
  try {
    watermark = await v.store.getWatermark()
    pendingCount = await v.store.countSince(watermark.lastSuccessAt)
  } catch (e) {
    return { kind: "error", message: `store read failed: ${errMessage(e)}` }
  }
  const now = (input.now ?? Date.now)()
  const ageMs =
    watermark.lastSuccessAt === null ? Number.POSITIVE_INFINITY : now - watermark.lastSuccessAt
  const reason = pickTriggerReason(pendingCount, ageMs)
  if (reason === null) return { kind: "skipped", reason: "below_thresholds" }
  // Threshold met — fetch the new stage1 rows + assemble the Phase2Input.
  let stage1Entries: Awaited<ReturnType<Stage1StorePort["fetchSince"]>>
  try {
    stage1Entries = await v.store.fetchSince(watermark.lastSuccessAt)
  } catch (e) {
    return { kind: "error", message: `store fetchSince failed: ${errMessage(e)}` }
  }
  const existing = v.existingContent ?? {
    memoryMd: null,
    rawMemoriesMd: null,
    memorySummaryMd: null,
  }
  const phase2Input: Phase2Input = {
    stage1Entries,
    existingMemoryMd: existing.memoryMd,
    existingRawMemoriesMd: existing.rawMemoriesMd,
    existingMemorySummaryMd: existing.memorySummaryMd,
    mode: v.mode ?? "incremental",
    lastSuccessWatermark: watermark.lastSuccessAt,
    ...(input.signal ? { signal: input.signal } : {}),
    now: input.now ?? Date.now,
  }
  dispatchPhase2Background(phase2Input, v, log)
  return { kind: "scheduled", reason }
}

/** Test-only escape hatch — clear the in-flight guard between tests so
 *  the WeakSet does not leak across cases. NOT for production use. */
export const __resetPhase2InflightForTests = (writer: MemoryWriter): void => {
  _inflight.delete(writer)
}
