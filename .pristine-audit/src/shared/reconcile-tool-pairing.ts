/**
 * Resume-boundary `tool_use`↔`tool_result` reconciliation — PURE leaf.
 *
 * Relocated here (from `@/memory/history-sanitization`) so BOTH the
 * write-path (`@/session/store.ts` — `rewindToMessage` / `forkSession`) and
 * the read-path (`@/runner/orchestrate/resume-fsm.ts`, via the
 * `@/memory/history-sanitization` re-export) can share one implementation
 * without forging a forbidden `@/session → @/memory` slice edge. `@/shared` is
 * THE leaf every slice may import; this pass is pure (no I/O, no clock, no RNG)
 * so a leaf home is structurally clean.
 *
 * # Why this exists
 *
 * The live-turn path already seals the transcript at turn boundaries
 * (`@/agent/turn-closeout.ts#stripOrphanToolUse`, wired in `loop.ts`). But when
 * a transcript is RE-LOADED from disk — session resume, fork, checkpoint
 * rewind, subagent resume — the loaded message array can contain a dangling
 * pair that was never sealed on the live path, or that a rewind *split* mid-pair
 * (rewind truncates at `idx+1`; if `idx` is an assistant `tool_use` turn whose
 * `tool_result` lived in the very next message, the truncation orphans it).
 *
 * Anthropic Messages API and OpenAI (chat + Responses) BOTH 400 when:
 *   - an assistant `tool_use` (block `id`) has no following `tool_result`
 *     (block `tool_use_id`) referencing it, OR
 *   - a `tool_result` references a `tool_use_id` that never appeared as a
 *     preceding `tool_use` `id`.
 *
 * Codex repairs the same class before re-sending in
 * `codex-rs/core/src/context_manager/normalize.rs` (7-case scan). This is the
 * quanta analog, collapsed to the two structural cases our wire shape produces.
 *
 * # The two repairs
 *
 *   (1) Orphan `tool_use` (no matching result anywhere AFTER it)
 *       → SYNTHESIZE a placeholder `tool_result` stub, inserted as a
 *         `{role:"user"}` message immediately after the assistant message that
 *         carries the orphan use.
 *
 *       Decision — SYNTHESIZE rather than DROP. Justification:
 *         - Dropping the `tool_use` block can orphan surrounding `text` /
 *           `thinking` blocks in the SAME assistant `content[]` (the model often
 *           narrates then calls a tool); removing the call silently rewrites the
 *           assistant's visible turn. A stub result is minimally lossy.
 *         - A synthesized `tool_result` is valid on BOTH wire shapes: Anthropic
 *           consumes the `{type:"tool_result", tool_use_id, content}` block in a
 *           user message; OpenAI's adapter flattens the same block to a `tool`
 *           role message keyed by the call id. The portable `content` string
 *           (`is_error:true`) is the field both adapters read.
 *         - It preserves turn ordering: the stub lands exactly where a real
 *           result would have, so no later message is reordered.
 *
 *   (2) Orphan `tool_result` (references an id with no PRECEDING `tool_use`)
 *       → DROP the block. A result with no call is *always* invalid and carries
 *         no recoverable assistant intent. If dropping empties a message's
 *         `content[]`, the now-empty message is dropped too (an empty-content
 *         message is itself a 400).
 *
 * # Invariants
 *   - PURE. No I/O, no clock, no RNG, no telemetry. Deterministic.
 *   - NO-THROW. Malformed inputs (non-array `content`, non-object blocks,
 *     missing ids) are passed through untouched; the function never throws.
 *   - BYTE-IDENTICAL when already valid. A correctly-paired transcript returns
 *     the SAME top-level array reference, with every message object identity
 *     preserved — zero allocation on the happy path (the common case).
 *   - ORDER-PRESERVING. Non-tool content (text/image/thinking/document) and
 *     valid pairs keep their relative order.
 *
 * # Slice-fence
 *   `@/shared` is the leaf — this module imports nothing. The `Message` /
 *   `ContentBlock` shapes are accepted structurally (it never imports `@/llm`).
 *   The concrete `Message` from `@/llm/types.ts` is assignable to `MsgLike`.
 */

/** Structural minimum for a message in a loaded transcript. Matches `Message`
 *  from `@/llm/types.ts` without importing it (leaf isolation). */
interface MsgLike {
  readonly role: string
  readonly content: unknown
}

/** Structural read of a `tool_use` block (`@/llm/types.ts#ToolUseBlock`). */
interface ToolUseLike {
  readonly type: "tool_use"
  readonly id: string
}

/** Structural read of a `tool_result` block (`@/llm/types.ts#ToolResultBlock`). */
interface ToolResultLike {
  readonly type: "tool_result"
  readonly tool_use_id: string
}

/** Default placeholder text for a synthesized stub result. Deterministic
 *  constant — callers do not parameterize it (keeps the pass pure + the wire
 *  shape uniform across surfaces). */
export const RECONCILE_PLACEHOLDER_TEXT =
  "[tool result missing after resume — synthesized to keep the transcript valid]"

/** True iff `block` is a structurally-valid `tool_use` block carrying a
 *  non-empty string `id`. Defensive: anything else is "not a tool_use". */
const isToolUse = (block: unknown): block is ToolUseLike =>
  !!block &&
  typeof block === "object" &&
  (block as { type?: unknown }).type === "tool_use" &&
  typeof (block as { id?: unknown }).id === "string" &&
  (block as { id: string }).id.length > 0

/** True iff `block` is a structurally-valid `tool_result` block carrying a
 *  non-empty string `tool_use_id`. */
const isToolResult = (block: unknown): block is ToolResultLike =>
  !!block &&
  typeof block === "object" &&
  (block as { type?: unknown }).type === "tool_result" &&
  typeof (block as { tool_use_id?: unknown }).tool_use_id === "string" &&
  (block as { tool_use_id: string }).tool_use_id.length > 0

/** Build a placeholder `tool_result` block for an orphan `tool_use` `id`.
 *  `is_error:true` + a `content` string both wire shapes carry. */
const makeStubResult = (
  toolUseId: string,
): ToolResultLike & {
  content: string
  is_error: true
} => ({
  type: "tool_result",
  tool_use_id: toolUseId,
  content: RECONCILE_PLACEHOLDER_TEXT,
  is_error: true,
})

/** Read a message's `content` as a block array, or `null` when it is not an
 *  array (string content, malformed). `null` ⇒ the message has no tool blocks
 *  to reconcile and is passed through verbatim. */
const blockArray = (msg: MsgLike): readonly unknown[] | null =>
  Array.isArray(msg.content) ? (msg.content as readonly unknown[]) : null

/** Outcome of the phase-1 forward scan. `satisfiedUseIds` = tool_use ids that
 *  have a downstream result; `sawAnyToolBlock` short-circuits the happy path. */
interface ScanResult {
  readonly satisfiedUseIds: ReadonlySet<string>
  readonly sawAnyToolBlock: boolean
}

/** Phase 1 — forward scan. A `tool_result` satisfies a use only if that use
 *  already appeared at or before it (a result preceding its use is itself an
 *  orphan, dropped in phase 2). Pure read; allocates two small sets. */
const scanPairing = <M extends MsgLike>(messages: readonly M[]): ScanResult => {
  const seenUseIds = new Set<string>()
  const satisfiedUseIds = new Set<string>()
  let sawAnyToolBlock = false
  for (const msg of messages) {
    const blocks = blockArray(msg)
    if (blocks === null) continue
    for (const block of blocks) {
      if (isToolUse(block)) {
        seenUseIds.add(block.id)
        sawAnyToolBlock = true
      } else if (isToolResult(block)) {
        sawAnyToolBlock = true
        if (seenUseIds.has(block.tool_use_id)) satisfiedUseIds.add(block.tool_use_id)
      }
    }
  }
  return { satisfiedUseIds, sawAnyToolBlock }
}

/** Per-message rebuild result. `kept` is the (possibly filtered) block array;
 *  `mutated` flags whether an orphan result was dropped; `orphanUseIds` lists
 *  the orphan `tool_use` ids this message introduces (stubs spliced after). */
interface RebuildBlocks {
  readonly kept: unknown[]
  readonly mutated: boolean
  readonly orphanUseIds: string[]
}

/** Phase 2 (block level) — filter orphan `tool_result` blocks and record
 *  orphan `tool_use` ids. `liveUseIds` is MUTATED in place (it tracks ids seen
 *  so far across the whole rebuild sweep). */
const rebuildBlocks = (
  blocks: readonly unknown[],
  liveUseIds: Set<string>,
  satisfiedUseIds: ReadonlySet<string>,
): RebuildBlocks => {
  let mutated = false
  const kept: unknown[] = []
  const orphanUseIds: string[] = []
  for (const block of blocks) {
    if (isToolUse(block)) {
      liveUseIds.add(block.id)
      kept.push(block)
      if (!satisfiedUseIds.has(block.id)) orphanUseIds.push(block.id)
    } else if (isToolResult(block)) {
      // Orphan result (no preceding use) is always invalid → drop.
      if (liveUseIds.has(block.tool_use_id)) kept.push(block)
      else mutated = true
    } else {
      kept.push(block)
    }
  }
  return { kept, mutated, orphanUseIds }
}

/**
 * Reconcile dangling `tool_use`↔`tool_result` pairs in a loaded transcript so
 * the array is model-valid for both Anthropic and OpenAI.
 *
 * Single logical pass with three phases over the same buffer:
 *   1. Collect the set of all `tool_use` ids and all satisfied ids (a
 *      `tool_result` whose `tool_use_id` matches a `tool_use` that appeared at
 *      or before it). This yields the orphan-use set + lets phase 2 detect
 *      orphan results in one forward sweep.
 *   2. Rebuild messages: drop `tool_result` blocks with no preceding `tool_use`
 *      (orphan results); keep everything else byte-identical. Drop a message
 *      that becomes empty as a result.
 *   3. After each assistant message carrying an orphan `tool_use` (no result
 *      anywhere after it), splice a synthesized `{role:"user"}` stub-result
 *      message so the pair is satisfied in-order.
 *
 * Returns the SAME array reference when nothing was repaired (happy path).
 *
 * @typeParam M structural message type (the caller's concrete `Message` is
 *   assignable). Synthesized stub messages are constructed as `M` via a
 *   structural cast — they carry only `role` + `content`, the structural
 *   minimum, so the cast is sound for any superset `Message` shape.
 */
export const reconcileToolPairing = <M extends MsgLike>(
  messages: readonly M[],
): M[] | readonly M[] => {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return messages

    // Phase 1: which tool_use ids ever get a downstream result?
    const { satisfiedUseIds, sawAnyToolBlock } = scanPairing(messages)
    // Fast path: no tool blocks at all ⇒ nothing to reconcile, same reference.
    if (!sawAnyToolBlock) return messages

    // Phase 2 + 3: rebuild, dropping orphan results, splicing stubs.
    const liveUseIds = new Set<string>()
    const out: M[] = []
    let mutated = false

    for (const msg of messages) {
      const blocks = blockArray(msg)
      if (blocks === null) {
        out.push(msg)
        continue
      }
      const {
        kept,
        mutated: blocksMutated,
        orphanUseIds,
      } = rebuildBlocks(blocks, liveUseIds, satisfiedUseIds)
      if (blocksMutated) {
        mutated = true
        // Drop a message whose content emptied out entirely (empty-content
        // message is itself a 400); otherwise keep it with the filtered array.
        if (kept.length > 0) out.push({ ...(msg as object), content: kept } as M)
      } else {
        out.push(msg)
      }
      // Phase 3: splice a stub result for each orphan tool_use introduced here.
      if (orphanUseIds.length > 0) {
        mutated = true
        out.push({ role: "user", content: orphanUseIds.map(makeStubResult) } as unknown as M)
      }
    }

    return mutated ? out : messages
  } catch {
    // NO-THROW: a hostile / malformed input must never poison the load path.
    // Returning the original is the safe fallback (the provider will surface a
    // clean 400 if it really is invalid, rather than us crashing the resume).
    return messages
  }
}
