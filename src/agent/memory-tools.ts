import { z } from "zod"
import {
  EMBED_DIM,
  type EmbedderPort,
  type MemoryEntry,
  type MemoryKind,
  type MemoryQuery,
  type PersistentStorePort,
} from "@/memory"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

/**
 * Self-edit memory tools (RFC §6.3, long-term memory). Let the model search,
 * write, and revise its own durable memory mid-session. Every `execute` is
 * defensive: any failure yields a single `ok:false` result rather than
 * throwing out of the generator (the dispatcher must never see a throw).
 */

/**
 * Per-thread memory mode (ADR-0432, Codex `codex_memories_extension`):
 *  - `enabled`   : recall + write both active (DEFAULT — byte-identical).
 *  - `read-only` : recall active, every write/update returns a typed `ok:false`.
 *  - `disabled`  : neither recall NOR write touch the store; both are no-ops.
 * Absent ⇒ treated as `enabled` (no behavior change).
 */
export type ThreadMemoryMode = "enabled" | "disabled" | "read-only"

/**
 * Which guard arm evaluated a write, for arm-state telemetry (jul-03 B3). The
 * guard is fail-open UNLESS a threshold knob AND a live source both exist — a
 * latent-config trap. Emitting the arm state on every write-guard evaluation
 * proves the guard is actually LIVE (armed, reading a real source) rather than
 * silently inert. `source` distinguishes the LOCAL cost fraction from the REAL
 * provider rate-limit signal.
 */
export interface MemoryWriteGuardArm {
  /** `cost` = local `BudgetMeter.remainingPercent()`; `provider` = provider
   *  `x-ratelimit-remaining` tap. */
  source: "cost" | "provider"
  /** True when a live source produced a comparable number (a real reading), so
   *  the arm actually participated. `provider` is unarmed when its tap returns
   *  `undefined` (no snapshot yet). */
  armed: boolean
  /** The observed 0..100 remaining percentage, when `armed`. */
  observed?: number
  /** True iff this arm refused the write (`observed < minRemainingPercent`). */
  blocked: boolean
}

/**
 * Write-guard (ADR-0432, jul-03 B3). When configured, a `memory_write` /
 * `memory_update` is SKIPPED (typed `ok:false`, store untouched) if EITHER the
 * run's remaining budget percentage OR the provider's live rate-limit window is
 * strictly below `minRemainingPercent`. Default-OFF: absent ⇒ no guard, every
 * write proceeds (byte-identical).
 *
 * TWO independent signals (jul-03 B3 — kept SEPARATE by design):
 *   - `remainingPercent()` — LOCAL cost/token fraction from `BudgetMeter`
 *     (ADR-0138). Returns 100 with no cost dial (a human REPL), so on its own it
 *     mirrors Codex `min_rate_limit_remaining_percent` by NAME only.
 *   - `providerRateLimitRemainingPercent()` — the REAL provider quota window
 *     (`x-ratelimit-remaining` / `x-codex-*-used-percent`). Returns `undefined`
 *     until the provider actually reports one, so the provider arm fails OPEN on
 *     "unknown" and only refuses on a genuinely low window.
 * The memory slice never owns a meter; it only reads these 0..100 signals at
 * write time.
 */
export interface MemoryWriteGuard {
  /** Skip the write when a signal is strictly below this 0..100 threshold. */
  minRemainingPercent: number
  /** Returns the run's LOCAL remaining budget as a 0..100 percentage. */
  remainingPercent: () => number
  /**
   * Returns the PROVIDER's live rate-limit remaining percentage (0..100), or
   * `undefined` when the provider has not reported one yet. Absent closure ⇒ the
   * provider arm is never armed (byte-identical to the cost-only guard).
   */
  providerRateLimitRemainingPercent?: () => number | undefined
  /** Optional arm-state telemetry sink (jul-03 B3). Called once per evaluated
   *  arm on every write-guard check. Absent ⇒ no telemetry (byte-identical). */
  onArm?: (arm: MemoryWriteGuardArm) => void
}

/**
 * Line-level source citation (ADR-0432, Codex `MemoryCitationEntry`
 * `{ lineStart, lineEnd }`). Orthogonal to ADR-0082 `MemoryCitation` (which is
 * prompt-WINDOW placement provenance, NOT source-line spans). 1-based,
 * inclusive. Surfaced inline in `memory_search` output so the model can ground
 * a recalled claim to the exact lines of the stored record.
 */
export interface LineCitation {
  recordId: string
  lineStart: number
  lineEnd: number
  /** Provenance (jul-03 B3, Codex `MemoryCitationEntry.threadIds`): the session
   *  that originated the cited record. Omitted when unknown. */
  threadId?: string
  /** Provenance (jul-03 B3, Codex `MemoryCitationEntry.entries[].note`): advisory
   *  reuse guidance carried with the record. Omitted when absent. */
  note?: string
}

/** Optional provenance carried onto a {@link LineCitation}. */
export interface LineCitationProvenance {
  threadId?: string
  note?: string
}

/** Count 1-based lines in `text` (an empty string is a single L1 line). */
const lineCountOf = (text: string): number => (text.length === 0 ? 1 : text.split("\n").length)

/** 1-based (inclusive) line index of char offset `pos` within `text`: one more
 *  than the number of newlines strictly before `pos`. */
const lineAtOffset = (text: string, pos: number): number => {
  let line = 1
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) line++
  }
  return line
}

/**
 * 1-based inclusive line span of a record's text (jul-03 B3).
 *
 * When `matchText` is supplied and is found (case-insensitive substring, exactly
 * the `ranking.textScore` `lc/includes` match semantics), the span is the REAL
 * sub-range of lines the FIRST match occupies — `[first-line, last-line]` of the
 * matched substring — so `[L{s}-{e}]` is informative, not the degenerate
 * whole-record `L1..N`. When `matchText` is absent or NOT found, it falls back
 * to the whole record (`L1..N`), byte-identical to the legacy behaviour so
 * callers that carry no query are unaffected. `provenance` (threadId / note) is
 * appended when present (fields omitted otherwise — exactOptionalPropertyTypes).
 */
export const lineSpanOf = (
  recordId: string,
  text: string,
  matchText?: string,
  provenance?: LineCitationProvenance,
): LineCitation => {
  const total = lineCountOf(text)
  let lineStart = 1
  let lineEnd = total
  if (matchText !== undefined && matchText.length > 0) {
    const idx = text.toLowerCase().indexOf(matchText.toLowerCase())
    if (idx >= 0) {
      lineStart = lineAtOffset(text, idx)
      // `idx + len - 1` is the last matched char; a match ending exactly at a
      // boundary still lands on the line that char belongs to.
      lineEnd = lineAtOffset(text, idx + matchText.length - 1)
    }
  }
  return {
    recordId,
    lineStart,
    lineEnd,
    ...(provenance?.threadId !== undefined ? { threadId: provenance.threadId } : {}),
    ...(provenance?.note !== undefined ? { note: provenance.note } : {}),
  }
}

export interface MemoryToolsDeps {
  store: PersistentStorePort
  embedder?: EmbedderPort
  /**
   * Per-thread memory mode (ADR-0432). Absent ⇒ `enabled` (byte-identical).
   */
  threadMode?: ThreadMemoryMode
  /**
   * Append 1-based source-line spans to `memory_search` output (ADR-0432).
   * Absent / `false` ⇒ legacy output, byte-identical.
   */
  lineCitations?: boolean
  /**
   * Budget-aware write-guard (ADR-0432). Absent ⇒ no guard (byte-identical).
   */
  writeGuard?: MemoryWriteGuard
  /** Injected clock so replay / unit tests get deterministic
   *  `mem:tool:<base36ts>:<uuid8>` ids AND `createdAt` values that get
   *  PERSISTED into the durable store (which the LLM then reads back in a
   *  future session — model-facing through the store, ADR-0078 leak). Defaults
   *  to {@link Date.now}; production output byte-identical for the current
   *  moment. Pattern: `opts.now ?? Date.now` (cf. agent/admissibility-gate.ts,
   *  memory/consolidate/writer.ts). */
  now?: () => number
  /** Injected uuid source for the same persisted-id determinism. Only the
   *  first 8 chars are used in the id, so any unique string per call works.
   *  Defaults to {@link crypto.randomUUID}. */
  uuid?: () => string
}

/** Embed `text`, returning the vector only if it is the expected dimension. */
const tryEmbed = async (
  embedder: EmbedderPort | undefined,
  text: string,
): Promise<number[] | undefined> => {
  if (!embedder) return undefined
  try {
    const [vec] = await embedder.embed([text])
    return vec && vec.length === EMBED_DIM ? vec : undefined
  } catch {
    return undefined
  }
}

const errMsg = (e: unknown): string => errMessage(e)

/** Build the shallow patch for `memory_update` (re-embedding on text change). */
const buildUpdatePatch = async (
  input: UpdateInput,
  embedder: EmbedderPort | undefined,
): Promise<Partial<MemoryEntry>> => {
  const patch: Partial<MemoryEntry> = {}
  if (input.text !== undefined) {
    patch.text = input.text
    const embedding = await tryEmbed(embedder, input.text)
    if (embedding) patch.embedding = embedding
  }
  if (input.tags !== undefined) patch.tags = input.tags
  if (input.importance !== undefined) patch.importance = input.importance
  return patch
}

const searchSchema = z.object({
  query: z.string().describe("Free-text query; semantic when an embedder is configured."),
  limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)."),
  tier: z
    .enum(["episodic", "semantic"])
    .optional()
    .describe("Restrict to this memory tier (default: both)."),
  kind: z
    .enum(["fact", "decision", "observation", "preference"])
    .optional()
    .describe("Restrict to this memory kind (default: all)."),
  minImportance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop entries with importance below this 0..1 threshold."),
})
type SearchInput = z.infer<typeof searchSchema>

const writeSchema = z.object({
  text: z.string().min(1).describe("The durable statement to remember."),
  kind: z
    .enum(["fact", "decision", "observation", "preference"])
    .optional()
    .describe("Memory kind (default observation)."),
  tags: z.array(z.string()).optional().describe("Short lowercase topic tags."),
  importance: z.number().min(0).max(1).optional().describe("Value weight 0..1 (default 0.6)."),
})
type WriteInput = z.infer<typeof writeSchema>

const updateSchema = z.object({
  id: z.string().describe("Id of the memory to revise."),
  text: z.string().optional().describe("New text (triggers re-embedding)."),
  tags: z.array(z.string()).optional().describe("Replacement tags."),
  importance: z.number().min(0).max(1).optional().describe("New importance 0..1."),
  delete: z.boolean().optional().describe("Hard-delete the entry instead of patching."),
})
type UpdateInput = z.infer<typeof updateSchema>

/** Build the three self-edit memory tools bound to a store (+ optional embedder). */
export const memoryTools = (deps: MemoryToolsDeps): Tool[] => {
  // ADR-0078 determinism leak: `id` and `createdAt` are PERSISTED into the
  // store the LLM reads back next session. Default-bind to Date.now /
  // crypto.randomUUID so production output is byte-identical; replay/test
  // callers supply deterministic ones via `deps.now` / `deps.uuid`.
  const now = deps.now ?? Date.now
  const uuid = deps.uuid ?? (() => crypto.randomUUID())
  // ADR-0432 gates. All default-OFF: absent config ⇒ byte-identical legacy
  // behaviour (recall on, writes on, no line spans).
  const mode: ThreadMemoryMode = deps.threadMode ?? "enabled"
  const recallDisabled = mode === "disabled"
  const writesDisabled = mode === "disabled" || mode === "read-only"
  /** Returns a typed-block reason iff a write must be refused, else undefined.
   *  jul-03 B3: evaluates TWO independent arms — the LOCAL cost fraction and the
   *  REAL provider rate-limit window — emitting arm-state telemetry for each so
   *  the guard is demonstrably LIVE (not a latent inert config). The provider
   *  arm fails OPEN when its tap returns `undefined` (no snapshot yet). */
  const writeBlockReason = (verb: string): string | undefined => {
    if (writesDisabled) return `${verb} blocked: memory mode is '${mode}' for this thread.`
    const guard = deps.writeGuard
    if (!guard) return undefined
    const threshold = guard.minRemainingPercent
    // Local cost/token arm (existing signal).
    const cost = guard.remainingPercent()
    const costArmed = Number.isFinite(cost)
    const costBlocked = costArmed && cost < threshold
    guard.onArm?.({
      source: "cost",
      armed: costArmed,
      ...(costArmed ? { observed: cost } : {}),
      blocked: costBlocked,
    })
    if (costBlocked) {
      return `${verb} skipped: ${cost.toFixed(0)}% budget remaining < ${threshold}% threshold.`
    }
    // Provider rate-limit arm (jul-03 B3 — the REAL provider signal, separate
    // from cost). Unarmed when the tap is absent or reports `undefined`.
    const provider = guard.providerRateLimitRemainingPercent?.()
    const providerArmed = provider !== undefined && Number.isFinite(provider)
    const providerBlocked = providerArmed && provider < threshold
    guard.onArm?.({
      source: "provider",
      armed: providerArmed,
      ...(providerArmed ? { observed: provider } : {}),
      blocked: providerBlocked,
    })
    if (providerBlocked) {
      return `${verb} skipped: ${provider.toFixed(0)}% provider rate-limit remaining < ${threshold}% threshold.`
    }
    return undefined
  }
  const memorySearch: Tool<SearchInput> = {
    name: "memory_search",
    description:
      "Search durable long-term memory for entries relevant to a query. Read-only. " +
      "Optional filters: `tier` (episodic|semantic), `kind` " +
      "(fact|decision|observation|preference), `minImportance` (0..1).",
    inputSchema: searchSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input: SearchInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        if (recallDisabled) {
          // ADR-0432: `disabled` mode ⇒ recall is a no-op, store never read.
          yield {
            type: "result",
            result: { ok: true, output: "Memory recall is disabled for this thread." },
          }
          return
        }
        const limit = input.limit ?? 5
        const embedding = await tryEmbed(deps.embedder, input.query)
        const query: MemoryQuery = { text: input.query, limit }
        if (embedding) query.embedding = embedding
        if (input.tier) query.tiers = [input.tier]
        if (input.kind) query.kinds = [input.kind]
        if (input.minImportance !== undefined) query.minImportance = input.minImportance
        const entries = await deps.store.recall(query)
        if (entries.length === 0) {
          yield { type: "result", result: { ok: true, output: "No matching memories." } }
          return
        }
        const lines = entries.map((e) => {
          const base = `#${e.id} (${e.kind}, ${(e.importance ?? 0.5).toFixed(2)}) ${e.text}`
          if (!deps.lineCitations) return base
          // ADR-0432 + jul-03 B3: append a REAL 1-based inclusive sub-span — the
          // lines the query actually matches (`[L2-2]`), not the degenerate
          // whole-record span. Provenance (originating session ⇒ threadId,
          // reuse guidance ⇒ note) mirrors Codex `MemoryCitationEntry`.
          const provenance: LineCitationProvenance = {
            ...(e.sessionId !== undefined ? { threadId: e.sessionId } : {}),
            ...(e.reuseRule !== undefined ? { note: e.reuseRule } : {}),
          }
          const span = lineSpanOf(e.id, e.text, input.query, provenance)
          const prov = span.note !== undefined ? ` {${span.note}}` : ""
          return `${base} [L${span.lineStart}-${span.lineEnd}]${prov}`
        })
        yield { type: "result", result: { ok: true, output: lines.join("\n") } }
      } catch (e) {
        yield {
          type: "result",
          result: { ok: false, output: `memory_search failed: ${errMsg(e)}` },
        }
      }
    },
  }

  const memoryWrite: Tool<WriteInput> = {
    name: "memory_write",
    description:
      "Save a new durable memory (fact/decision/observation/preference) for future sessions.",
    inputSchema: writeSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input: WriteInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        const blocked = writeBlockReason("memory_write")
        if (blocked) {
          yield { type: "result", result: { ok: false, output: blocked } }
          return
        }
        const kind: MemoryKind = input.kind ?? "observation"
        const ts = now()
        const id = `mem:tool:${ts.toString(36)}:${uuid().slice(0, 8)}`
        const entry: MemoryEntry = {
          id,
          kind,
          tier: "semantic",
          text: input.text,
          tags: input.tags ?? [],
          importance: input.importance ?? 0.6,
          createdAt: ts,
        }
        const embedding = await tryEmbed(deps.embedder, input.text)
        if (embedding) entry.embedding = embedding
        await deps.store.save(entry)
        yield { type: "result", result: { ok: true, output: `Saved memory ${id}.` } }
      } catch (e) {
        yield {
          type: "result",
          result: { ok: false, output: `memory_write failed: ${errMsg(e)}` },
        }
      }
    },
  }

  const memoryUpdate: Tool<UpdateInput> = {
    name: "memory_update",
    description: "Revise or delete an existing durable memory by id.",
    inputSchema: updateSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input: UpdateInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        const blocked = writeBlockReason("memory_update")
        if (blocked) {
          yield { type: "result", result: { ok: false, output: blocked } }
          return
        }
        const existing = await deps.store.get(input.id)
        if (!existing) {
          yield {
            type: "result",
            result: { ok: false, output: `Unknown memory id: ${input.id}` },
          }
          return
        }
        if (input.delete) {
          await deps.store.delete(input.id)
          yield { type: "result", result: { ok: true, output: `Deleted ${input.id}.` } }
          return
        }
        const patch = await buildUpdatePatch(input, deps.embedder)
        await deps.store.update(input.id, patch)
        yield { type: "result", result: { ok: true, output: `Updated ${input.id}.` } }
      } catch (e) {
        yield {
          type: "result",
          result: { ok: false, output: `memory_update failed: ${errMsg(e)}` },
        }
      }
    },
  }

  return [memorySearch as Tool, memoryWrite as Tool, memoryUpdate as Tool]
}
