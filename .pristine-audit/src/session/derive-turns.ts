/**
 * Transcript → turns reconstruction (domain logic, surface-agnostic).
 *
 * Segments a `Message[]` transcript into turns (one turn = one real user
 * prompt + the assistant work that followed) and pairs each `tool_use` with
 * its later-arriving `tool_result` to settle an `ok` outcome. This is the
 * canonical turn model shared by every surface that renders a transcript
 * (`/history`, `/inspect`, the web daemon) — it lives here, NOT in any one
 * surface, so the segmentation knowledge is defined once.
 *
 * Relocated from `apps/cli/history-cmd.ts` (ADR thin-surface audit): the CLI
 * command now only parses args + renders; the reconstruction state machine is
 * core. `history-cmd` re-exports `deriveTurns` for back-compat.
 *
 * Reads ONLY `@/llm` (the `Message` type). No I/O, no surface coupling.
 */

import type { Message } from "@/llm"

/** One turn = one user message + the assistant work that followed. */
export interface DerivedTurn {
  /** 1-based turn number, stable across calls. */
  readonly index: number
  /** First-line summary of the user prompt (trimmed, no inline newlines). */
  readonly summary: string
  /** Tool calls discovered in the assistant content that followed. */
  readonly tools: readonly DerivedTool[]
}

export interface DerivedTool {
  readonly id: string
  readonly name: string
  /** Settled outcome — `true` on `tool_result.is_error !== true`, `false`
   *  when `is_error === true`, `undefined` when the result block is still
   *  missing (in-flight turn). */
  readonly ok?: boolean
}

const firstLine = (s: string): string => {
  const trimmed = s.trim()
  const nl = trimmed.indexOf("\n")
  return nl < 0 ? trimmed : trimmed.slice(0, nl)
}

const userSummary = (msg: Message): string => {
  for (const block of msg.content) {
    if (block.type === "text") {
      const line = firstLine(block.text)
      if (line.length > 0) return line
    }
  }
  return "(no text)"
}

/** Mutable per-turn scratch + reverse-lookup state used by {@link deriveTurns}.
 *  Lives in one struct so the helper functions can share state without each
 *  growing the cognitive-complexity score of the outer fold. */
interface DeriveAccum {
  readonly turnsMut: { index: number; summary: string; tools: DerivedTool[] }[]
  current: { summary: string; tools: DerivedTool[] } | undefined
  /** tool_use_id → [(turn-tools-array, slot-index)] so we can rewrite in place. */
  readonly indexById: Map<string, { arr: DerivedTool[]; slot: number }[]>
}

const settleToolResult = (acc: DeriveAccum, toolUseId: string, isError: boolean): void => {
  const refs = acc.indexById.get(toolUseId)
  if (refs === undefined) return
  for (const ref of refs) {
    const cur = ref.arr[ref.slot]
    if (cur !== undefined && cur.id === toolUseId) {
      ref.arr[ref.slot] = { id: cur.id, name: cur.name, ok: !isError }
    }
  }
}

const hasUserText = (msg: Message): boolean =>
  msg.content.some((b) => b.type === "text" && b.text.trim().length > 0)

const consumeUserMessage = (acc: DeriveAccum, msg: Message): void => {
  if (hasUserText(msg)) {
    const tools: DerivedTool[] = []
    const entry = { index: acc.turnsMut.length + 1, summary: userSummary(msg), tools }
    acc.current = { summary: entry.summary, tools }
    acc.turnsMut.push(entry)
  }
  for (const block of msg.content) {
    if (block.type === "tool_result") {
      settleToolResult(acc, block.tool_use_id, block.is_error === true)
    }
  }
}

const consumeAssistantMessage = (acc: DeriveAccum, msg: Message): void => {
  const cur = acc.current
  if (cur === undefined) return
  for (const block of msg.content) {
    if (block.type !== "tool_use") continue
    const slot = cur.tools.length
    cur.tools.push({ id: block.id, name: block.name })
    const refs = acc.indexById.get(block.id) ?? []
    refs.push({ arr: cur.tools, slot })
    acc.indexById.set(block.id, refs)
  }
}

/** Walk the message array and group into turns. A turn opens at every
 *  `user` message whose first text block is NOT a `tool_result` carrier
 *  (real user prompt, not a synthetic tool_result-only user message).
 *
 *  Implementation note: `DerivedTool` is intentionally a value type (readonly
 *  fields). To "settle" a tool_use_id ⇄ tool_result pair after the fact we
 *  track the (turn-array, slot-index) pointer at insertion time, then rewrite
 *  that exact slot when the result arrives. This is the only way to keep the
 *  external interface immutable while still flowing `ok` through async-arriving
 *  results — the alternative would be exposing mutable holes. */
export const deriveTurns = (messages: readonly Message[]): readonly DerivedTurn[] => {
  const acc: DeriveAccum = { turnsMut: [], current: undefined, indexById: new Map() }
  for (const msg of messages) {
    if (msg.role === "user") consumeUserMessage(acc, msg)
    else consumeAssistantMessage(acc, msg)
  }
  // Defensive copy so callers can rely on a stable snapshot.
  return acc.turnsMut.map((t) => ({ index: t.index, summary: t.summary, tools: [...t.tools] }))
}
