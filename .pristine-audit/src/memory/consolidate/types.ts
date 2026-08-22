/**
 * ADR-0068 — Codex 2-Phase memory consolidator types (SOTA++ v2).
 *
 * SSOT for Phase 1 (per-thread distill) + Phase 2 (global consolidator).
 * No I/O, no clock, no LLM — just types + named errors. Ports are
 * dependency-injected so the consolidator pipeline is exercisable with
 * deterministic mocks in unit tests.
 *
 * Negative invariants (ADR-0068 §Negative-invariants):
 *   1. memory_mode defaults to 'disabled' — opt-in distill only.
 *   2. MEMORY.md size is bounded by `MEMORY_MAX_BYTES`; Phase 2 prompt is
 *      instructed to rolling-distill older entries on overflow.
 *   3. 3-file write is atomic via temp-dir + dir-rename OR `.git` commit.
 *   4. Prior MEMORY.md content is fed back to Phase 2 (user manual edits
 *      are preserved unless contradicted by new evidence).
 *   5. Rollout content is data, not instructions — Phase 2 prompt has the
 *      verbatim Codex defense; inject channel adds an untrusted wrapper.
 *   6. Threads below `MIN_TURN_THRESHOLD` turns are skipped.
 */

/**
 * ADR-0131 — 4-state memory outcome enum (per-Stage1 entry).
 *
 * Replaces free-form percentage scoring with a fixed-set enum to prevent
 * inflation ("80% done" hallucinations). Adopted from Codex memory corpus
 * (R4+R6 analysis of /.extracted_source/userdata/codex/memories) where the
 * production distribution is approximately:
 *
 *   partial   ~75%   ← dominant; safe default; narrow lane open
 *   success   ~15%   ← only when claim has file:line/SHA evidence anchor
 *   uncertain ~10%   ← claim made, not yet verified ([[no-heuristics-only-validated]])
 *   fail       ~1%   ← proof contradicts; gates promotion to phase2 (Phase C below)
 *
 * The ordering of {@link MEMORY_OUTCOMES} mirrors that frequency so any
 * "first valid" enumeration converges on the safe inflation-resistant
 * default. The enum is fixed-set (validated signal, not a heuristic
 * threshold) per [[no-heuristics-only-validated]].
 */
export type MemoryOutcome = "partial" | "success" | "uncertain" | "fail"

/**
 * Canonical enumeration of {@link MemoryOutcome} values in frequency-descending
 * order (Codex production distribution: partial > success > uncertain > fail).
 *
 * Iteration order matters for any "pick first defaulted" logic and for the
 * Phase 2 promotion gate (ADR-0131 §3) which uses this tuple as the
 * authoritative allow-list (rejecting 'fail' regardless of score).
 */
export const MEMORY_OUTCOMES = ["partial", "success", "uncertain", "fail"] as const

/** Runtime type guard for an unknown value being a valid {@link MemoryOutcome}.
 *  Safe at trust boundaries (SQLite rows, JSON blobs, frontmatter parses).
 *  Mirrors the `isStage1Row` pattern in {@link store.ts}. */
export const isMemoryOutcome = (v: unknown): v is MemoryOutcome =>
  typeof v === "string" && (MEMORY_OUTCOMES as readonly string[]).includes(v)

/** Per-thread Phase 1 distillation result. Mirrors Codex
 *  `stage1_outputs` row (thread_id PK + rolling fields). */
export interface Stage1Output {
  /** PRIMARY KEY — exactly one row per thread. UPSERT semantics: a re-run of
   *  Phase 1 for the same thread replaces the prior row. */
  readonly threadId: string
  /** Human-readable session slug — `${YYYYMMDD-HHMMSS}-${title}` form is
   *  Codex parity but quanta accepts any non-empty string. */
  readonly rolloutSlug: string
  /** LLM-distilled summary, ~1-3 paragraphs. Forms the bulk of MEMORY.md
   *  on a clean re-INIT. */
  readonly rolloutSummary: string
  /** Raw key facts/decisions/preferences/blockers extracted from this
   *  thread. Markdown bullets. Forms raw_memories.md when concatenated
   *  across all threads. */
  readonly rawMemory: string
  /** User preferences observed THIS thread, e.g. "uses bun", "prefers
   *  short summaries". JSON-array-serialized to SQLite. */
  readonly preferenceSignals: ReadonlyArray<string>
  /** ms epoch — when the source session was last touched (drives
   *  selection in Phase 2). */
  readonly sourceUpdatedAt: number
  /** Whether this row is queued for the NEXT Phase 2 run. Phase 1 sets
   *  to true on upsert; Phase 2 clears after consolidating. */
  readonly selectedForPhase2: boolean
  /** sourceUpdatedAt snapshot at selection time — Phase 2 ignores rows
   *  whose source has changed since (re-distill needed). */
  readonly selectedForPhase2SourceUpdatedAt: number | null
  /** ms epoch — last time Phase 2 read this row. */
  readonly lastUsage: number | null
  /** Cumulative usage count — high counts are anchor rows; Phase 2
   *  preserves them across rolling distill. */
  readonly usageCount: number
  /**
   * ADR-0131 — optional 4-state outcome enum (NEW Wave-W1 field).
   *
   * Absent/null for legacy rows (backward compatible — every existing
   * Phase 1 path is unchanged; consumers MUST treat undefined as "not
   * declared", NOT as a synonym for 'partial'). When present, Phase 2
   * promotion gate (`phase2-promotion.ts`) reads this and refuses to
   * promote rows whose outcome is 'fail'.
   *
   * Validated signal per [[no-heuristics-only-validated]]: enum is a
   * closed 4-set; no scoring, no thresholds.
   */
  readonly outcome?: MemoryOutcome
  /**
   * ADR-0131 — optional evidence anchor for {@link Stage1Output.outcome}.
   *
   * Required to be `file:line`, URL, or commit SHA when {@link outcome}
   * is `'success'` (lint enforces; not a schema constraint). May be
   * null/undefined when outcome is absent or when it is `partial` /
   * `uncertain` / `fail`. Promotion gate uses presence-or-absence as a
   * score contributor (not the evidence's content — content quality is
   * a manual review concern).
   */
  readonly outcomeEvidence?: string | null
}

/** Disk paths for the user-home memory dir. */
export interface MemoryDirPaths {
  /** `~/.quanta/memory/` — chmod 0700 on init. */
  readonly root: string
  /** `${root}/MEMORY.md` — user-read consolidated, ≤ MEMORY_MAX_BYTES. */
  readonly memoryMd: string
  /** `${root}/raw_memories.md` — append-only Phase 1 evidence trail. */
  readonly rawMemoriesMd: string
  /** `${root}/memory_summary.md` — prompt-inject channel (cache-friendly),
   *  ≤ MEMORY_SUMMARY_MAX_BYTES. */
  readonly memorySummaryMd: string
}

/** Phase 1 input — caller assembles from the just-finished session. */
export interface Phase1Input {
  readonly threadId: string
  readonly sessionId: string
  readonly rolloutMessages: ReadonlyArray<{ role: string; content: unknown }>
  /** Real (non-meta) turn count from the session. Threads with `turnCount
   *  < MIN_TURN_THRESHOLD` are skipped (returns `kind:"skipped"`). */
  readonly turnCount: number
  /** Per-thread opt-in. `'disabled'` (default) skips Phase 1 entirely. */
  readonly memoryMode: "enabled" | "disabled"
  /** Injected clock — Date.now() in production, fixed in tests. */
  readonly now: () => number
  /** Optional cancellation from the caller. Absent preserves legacy behavior. */
  readonly signal?: AbortSignal
}

/** Phase 1 port — wraps an LLM call to distill a rollout. Mockable. */
export interface Phase1Port {
  distill(args: {
    rolloutMessages: ReadonlyArray<{ role: string; content: unknown }>
    signal?: AbortSignal
  }): Promise<{
    rolloutSummary: string
    rawMemory: string
    preferenceSignals: ReadonlyArray<string>
  }>
}

/** Phase 1 outcome — discriminated union; never a plain null. */
export type Phase1Outcome =
  | { kind: "distilled"; stage1: Stage1Output; durationMs: number }
  | {
      kind: "skipped"
      reason: "memory_mode_disabled" | "turns_below_threshold" | "no_messages" | "thread_id_empty"
    }

/** Phase 2 input — caller fetches stage1_entries via Stage1StorePort. */
export interface Phase2Input {
  /** Rows selected since the last watermark. EMPTY in INIT mode is
   *  legal — the consolidator still runs to rebuild from raw_memories.md. */
  readonly stage1Entries: ReadonlyArray<Stage1Output>
  /** Prior MEMORY.md content (user manual edits live here). Phase 2 LLM
   *  MUST preserve unless contradicted by new evidence. */
  readonly existingMemoryMd: string | null
  /** Prior raw_memories.md content. Phase 2 appends new Stage 1 rows
   *  rather than replacing, in `incremental` mode. */
  readonly existingRawMemoriesMd: string | null
  /** Prior memory_summary.md (top index). Replaced on every run. */
  readonly existingMemorySummaryMd: string | null
  /** `INIT` rebuilds from scratch (raw_memories.md is the source of
   *  truth); `incremental` extends prior outputs. */
  readonly mode: "INIT" | "incremental"
  /** ms epoch — last successful Phase 2. null on first run. */
  readonly lastSuccessWatermark: number | null
  readonly now: () => number
  /** Optional cancellation from the caller. Absent preserves legacy behavior. */
  readonly signal?: AbortSignal
}

/**
 * `Phase2Summarizer` — the minimal LLM-callback shape `LlmPhase2Port`
 * needs. Defined here so `src/memory/consolidate/phase2-llm.ts` never
 * imports `@/llm` (RFC §3.1 slice isolation; biome's override-includes
 * matcher has historically dropped the `paths` form on `src/memory/**`
 * — see biome.json comment — so we enforce this STRUCTURALLY in addition
 * to lexically).
 *
 * The composition root (apps layer) supplies the wrapper:
 *
 *     // apps/agent/index.ts or apps/cli/internal.ts
 *     const phase2Summarize: Phase2Summarizer = async ({ system, userText, signal }) => {
 *       const events: StreamEvent[] = []
 *       let tokensUsed: number | undefined
 *       for await (const ev of llm.stream({
 *         system,
 *         messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
 *         tools: [],
 *         signal,
 *       })) {
 *         events.push(ev)
 *         if (ev.type === "usage" && typeof ev.usage?.totalTokens === "number") {
 *           tokensUsed = ev.usage.totalTokens
 *         }
 *       }
 *       const { message } = assembleFromEvents(events)
 *       const text = (Array.isArray(message.content) ? message.content : [])
 *         .map((b) => (b.type === "text" ? b.text : ""))
 *         .join("")
 *       return { text, tokensUsed }
 *     }
 *
 *     const phase2Port = new LlmPhase2Port(phase2Summarize)
 *
 * Generic failures raised by the summarizer are wrapped as
 * `Phase2ConsolidateError` by `LlmPhase2Port`. Abort-like failures are
 * propagated unchanged so callers can distinguish cancellation.
 */
export type Phase2Summarizer = (args: {
  system: string
  userText: string
  signal?: AbortSignal
}) => Promise<{
  /** Full assistant text — `LlmPhase2Port` parses the triple-section
   *  envelope (`<MEMORY_MD>…</MEMORY_MD>` etc.) out of this string. */
  text: string
  /** Optional total-tokens reading for OTel
   *  (`quanta.memory.phase2.tokens_used`). */
  tokensUsed?: number
}>

/** Phase 2 port — wraps the LLM consolidator. Same shape as Phase 1's
 *  for symmetry; a different (cheaper) model is typical (ADR-0011
 *  `summarizerLlm` pattern). */
export interface Phase2Port {
  consolidate(args: {
    stage1Entries: ReadonlyArray<Stage1Output>
    existingMemoryMd: string | null
    existingRawMemoriesMd: string | null
    mode: "INIT" | "incremental"
    signal?: AbortSignal
  }): Promise<{
    /** Must not exceed `MEMORY_MAX_BYTES`; caller enforces. */
    memoryMd: string
    /** Unbounded — append-only ingestion trail. */
    rawMemoriesMd: string
    /** Must not exceed `MEMORY_SUMMARY_MAX_BYTES`; caller enforces. */
    memorySummaryMd: string
    /** Optional — Phase 2 LLM call may report token usage for OTel
     *  (`quanta.memory.phase2.tokens_used`). */
    tokensUsed?: number
  }>
}

/** Phase 2 outcome — discriminated. `consolidated` is the happy path;
 *  `skipped` happens when there is nothing new to consolidate. */
export type Phase2Outcome =
  | {
      kind: "consolidated"
      mode: "INIT" | "incremental"
      stage1Count: number
      bytesWritten: { memory: number; rawMemories: number; memorySummary: number }
      /** SHA of the `.git` commit Phase 2 created. null when git is
       *  disabled (test mode). */
      gitCommitSha: string | null
      durationMs: number
      /** From Phase2Port if provided. */
      tokensUsed: number | null
    }
  | { kind: "skipped"; reason: "no_new_entries" | "memory_disabled_globally" }

/** Watermark state — singleton row in `consolidate_watermark`. */
export interface WatermarkState {
  /** ms epoch of last successful Phase 2 run. null until first run. */
  readonly lastSuccessAt: number | null
  /** ms epoch of last INIT (full rebuild). */
  readonly lastInitAt: number | null
  /** stage1_outputs count consolidated in the last run. */
  readonly lastConsolidatedCount: number
}

/** SQLite-backed Stage 1 store port. Implementation lives in
 *  `src/memory/consolidate/store.ts` (Wave A owner). */
export interface Stage1StorePort {
  upsert(out: Stage1Output): Promise<void>
  /** Rows with `sourceUpdatedAt > watermark` (or all if watermark null),
   *  ordered DESC by sourceUpdatedAt, optionally capped. */
  fetchSince(watermark: number | null, limit?: number): Promise<Stage1Output[]>
  countSince(watermark: number | null): Promise<number>
  getWatermark(): Promise<WatermarkState>
  setWatermark(next: WatermarkState): Promise<void>
}

// ─── Named errors ──────────────────────────────────────────────────────────
// Every Phase 1/2 failure surface is a named class so callers can
// distinguish distill failures from write failures from tainted rollouts.
// No silent catch anywhere in the pipeline — these propagate.

export class Phase1DistillError extends Error {
  public readonly threadId: string
  constructor(message: string, threadId: string) {
    super(`Phase 1 distill failed for thread '${threadId}': ${message}`)
    this.name = "Phase1DistillError"
    this.threadId = threadId
  }
}

export class Phase2ConsolidateError extends Error {
  public readonly mode: "INIT" | "incremental"
  constructor(message: string, mode: "INIT" | "incremental") {
    super(`Phase 2 consolidate failed (${mode} mode): ${message}`)
    this.name = "Phase2ConsolidateError"
    this.mode = mode
  }
}

export class MemoryWriteError extends Error {
  public readonly path: string
  constructor(message: string, path: string) {
    super(`Memory write failed at '${path}': ${message}`)
    this.name = "MemoryWriteError"
    this.path = path
  }
}

export class RolloutTaintedError extends Error {
  public readonly threadId: string
  constructor(message: string, threadId: string) {
    super(`Rollout content tainted (skipped distill) for thread '${threadId}': ${message}`)
    this.name = "RolloutTaintedError"
    this.threadId = threadId
  }
}

export class WatermarkConflictError extends Error {
  constructor(message: string) {
    super(`Watermark conflict: ${message}`)
    this.name = "WatermarkConflictError"
  }
}
