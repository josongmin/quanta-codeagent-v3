/**
 * Claude Code session translator (ADR-0038, L4 promotion).
 *
 * Parses a Claude Code session transcript (`~/.claude/projects/<slug>/<id>.
 * jsonl`) into v3 `Message[]`. Each line is a JSON object discriminated by
 * its `.type` field:
 *
 *   - `user` / `assistant`  → carry `message: { role, content }`; content is
 *                             either a plain string or an array of content
 *                             blocks (`text` / `tool_use` / `tool_result`).
 *   - everything else       → bookkeeping (`queue-operation`, `attachment`,
 *                             `file-history-snapshot`, `ai-title`, `summary`,
 *                             …) and is skipped.
 *
 * Defensive by contract: a malformed line (bad JSON, wrong shape, unknown
 * block type) is skipped, never thrown. Messages whose translated content is
 * empty are dropped — they carry no signal and would pollute the transcript.
 */

import { readFile } from "node:fs/promises"
import type { ContentBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from "@/llm"
import type { SessionTranslator, TranslatableProvider } from "./types"

/** Metadata line types we explicitly recognize and skip (non-exhaustive —
 *  any `.type` other than user/assistant is skipped anyway, but listing the
 *  known ones documents intent + guards against accidental future mapping). */
const SKIP_TYPES = new Set([
  "queue-operation",
  "attachment",
  "file-history-snapshot",
  "ai-title",
  "summary",
])

/** Coerce an unknown into a non-null object, else undefined. */
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined

/** Translate a single Claude Code content block into a v3 ContentBlock.
 *  Returns undefined for unknown / malformed blocks (caller skips). */
const translateBlock = (raw: unknown): ContentBlock | undefined => {
  const block = asObject(raw)
  if (block === undefined) return undefined
  const type = block.type
  if (type === "text") {
    if (typeof block.text !== "string") return undefined
    const t: TextBlock = { type: "text", text: block.text }
    return t
  }
  if (type === "tool_use") {
    if (typeof block.id !== "string" || typeof block.name !== "string") return undefined
    const t: ToolUseBlock = { type: "tool_use", id: block.id, name: block.name, input: block.input }
    return t
  }
  if (type === "tool_result") {
    if (typeof block.tool_use_id !== "string") return undefined
    // Claude Code tool_result.content is sometimes a string, sometimes an
    // array of `{type:"text", text}` blocks. Normalize to a single string.
    const t: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: normalizeToolResultContent(block.content),
      ...(block.is_error === true ? { is_error: true } : {}),
    }
    return t
  }
  return undefined
}

/** Flatten a tool_result `content` (string | block[] | unknown) to a string. */
const normalizeToolResultContent = (raw: unknown): string => {
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) {
    const parts: string[] = []
    for (const part of raw) {
      const obj = asObject(part)
      if (obj?.type === "text" && typeof obj.text === "string") parts.push(obj.text)
      else if (typeof part === "string") parts.push(part)
    }
    return parts.join("")
  }
  return ""
}

/** Translate the `message.content` (string | block[]) into v3 ContentBlocks. */
const translateContent = (raw: unknown): ContentBlock[] => {
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ type: "text", text: raw }]
  }
  if (!Array.isArray(raw)) return []
  const blocks: ContentBlock[] = []
  for (const item of raw) {
    const b = translateBlock(item)
    if (b !== undefined) blocks.push(b)
  }
  return blocks
}

/** Translate a single parsed JSONL line into a Message, or undefined to skip. */
const translateLine = (parsed: unknown): Message | undefined => {
  const obj = asObject(parsed)
  if (obj === undefined) return undefined
  const type = obj.type
  if (type !== "user" && type !== "assistant") return undefined
  if (SKIP_TYPES.has(type as string)) return undefined
  const message = asObject(obj.message)
  if (message === undefined) return undefined
  const role = message.role
  if (role !== "user" && role !== "assistant") return undefined
  const content = translateContent(message.content)
  if (content.length === 0) return undefined
  return { role, content }
}

/** Claude Code session translator. */
export const claudeCodeTranslator: SessionTranslator = {
  async translateFromFile(jsonlPath: string, _provider: TranslatableProvider): Promise<Message[]> {
    const raw = await readFile(jsonlPath, "utf8")
    const messages: Message[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // Malformed line — skip defensively, do not abort the whole file.
        continue
      }
      const msg = translateLine(parsed)
      if (msg !== undefined) messages.push(msg)
    }
    return messages
  },
}
