/**
 * Default `SideChatManager` impl (ADR-0244).
 *
 * Map-backed in-memory manager. The CORE invariant — "no operation on a
 * SideChatId reaches the parent session's `messages[]`" — is enforced
 * structurally: this slice has no reference to any parent `messages[]`
 * array. The only state it owns is its own internal Map
 * (`SideChatId → entry`), and the side-chat's own message list is built
 * exclusively from `{ role, text, recordedAt }` rows created locally.
 *
 * Plane-clean: imports `node:crypto`, `@/shared`, and sibling files only.
 * No `@/agent/loop`, no `@/agent/dispatch`, no `@/llm` (the side-chat
 * message shape is deliberately distinct from `@/llm.Message` to keep
 * cross-pollination structurally impossible — see `types.ts`).
 */

import { randomUUID } from "node:crypto"
import { assertNever, err, ok, type Result } from "@/shared"
import type {
  SideChatCloseAllInput,
  SideChatListInput,
  SideChatManager,
  SideChatSendInput,
  SideChatSendResult,
  SideChatStartInput,
  SideChatStartResult,
  SideChatStopInput,
  SideChatStopResult,
} from "./port"
import type { SideChatError, SideChatId, SideChatMessage, SideChatState } from "./types"

/** One row in the manager's internal Map. */
interface Entry {
  readonly id: SideChatId
  readonly parentSessionId: string
  state: SideChatState
  readonly messages: SideChatMessage[]
  /** Epoch-ms timestamp at start time (used for newest-first list ordering). */
  readonly startedAt: number
  /** Monotonic counter at start time — tiebreaker when two starts share `startedAt`. */
  readonly startSeq: number
}

export interface DefaultSideChatManagerOpts {
  /** Injected clock used for timestamps. Default `Date.now`. */
  readonly now?: () => number
  /** Override the UUID minter (tests inject a counter). Default `crypto.randomUUID`. */
  readonly mintSideChatId?: () => string
  /** Cap on simultaneously-present entries (active + stopped). When the cap
   *  is hit, the manager evicts STOPPED entries first; if none exist, the
   *  call surfaces `Err("capacity-exceeded")`. Default 1000. */
  readonly maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 1000

/** Validate the parent id — non-empty trimmed string. */
const isValidParent = (parentSessionId: unknown): parentSessionId is string =>
  typeof parentSessionId === "string" && parentSessionId.trim().length > 0

/** Validate the prompt — non-empty trimmed string. */
const isValidPrompt = (prompt: unknown): prompt is string =>
  typeof prompt === "string" && prompt.trim().length > 0

/** Build the synthesised placeholder reply. LLM wiring belongs to a higher
 *  layer — this slice owns only the lifecycle, so the reply is a structured
 *  acknowledgement that future LLM-backed replies can replace WITHOUT
 *  changing the port shape. */
const makeReply = (userText: string, recordedAt: number): SideChatMessage => ({
  role: "assistant",
  text: `[side-chat ack] received ${userText.length} chars`,
  recordedAt,
})

/** Pre-flight abort check. Returns the err to surface, or null when ok. */
const abortedCheck = (signal: AbortSignal | undefined): SideChatError | null => {
  if (signal !== undefined && signal.aborted === true) {
    return { code: "aborted", message: "side-chat: aborted before start" }
  }
  return null
}

export const defaultSideChatManager = (opts?: DefaultSideChatManagerOpts): SideChatManager => {
  const now = opts?.now ?? Date.now
  const mintId = opts?.mintSideChatId ?? (() => randomUUID())
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES

  /** SideChatId → entry. Single source of truth for the manager. */
  const entries = new Map<SideChatId, Entry>()
  /** Monotonic counter for `startSeq`. */
  let seq = 0

  /** Evict stopped entries until size < cap. Returns the count evicted. */
  const evictStopped = (): number => {
    let count = 0
    for (const [id, e] of entries) {
      if (entries.size < maxEntries) break
      if (e.state === "stopped") {
        entries.delete(id)
        count += 1
      }
    }
    return count
  }

  return {
    start(input: SideChatStartInput): Result<SideChatStartResult, SideChatError> {
      const abort = abortedCheck(input.signal)
      if (abort !== null) return err(abort)

      if (!isValidParent(input.parentSessionId)) {
        return err({
          code: "invalid-parent",
          message: "side-chat: parentSessionId must be a non-empty string",
        })
      }
      if (!isValidPrompt(input.prompt)) {
        return err({
          code: "invalid-prompt",
          message: "side-chat: prompt must be a non-empty string",
        })
      }

      if (entries.size >= maxEntries) {
        evictStopped()
        if (entries.size >= maxEntries) {
          return err({
            code: "capacity-exceeded",
            message: `side-chat: capacity ${maxEntries} reached; no stopped entries to evict`,
          })
        }
      }

      seq += 1
      const id = mintId()
      // Defensive: collision (extremely unlikely with crypto.randomUUID v4)
      // surfaces as a fresh capacity-style error rather than silently
      // overwriting an existing chat.
      if (entries.has(id)) {
        return err({
          code: "capacity-exceeded",
          message: `side-chat: minted id '${id}' already in use (UUID collision)`,
        })
      }
      const startedAt = now()
      const initial: SideChatMessage = {
        role: "user",
        text: input.prompt,
        recordedAt: startedAt,
      }
      entries.set(id, {
        id,
        parentSessionId: input.parentSessionId,
        state: "active",
        messages: [initial],
        startedAt,
        startSeq: seq,
      })
      return ok({ id, state: "active" })
    },

    send(input: SideChatSendInput): Result<SideChatSendResult, SideChatError> {
      const abort = abortedCheck(input.signal)
      if (abort !== null) return err(abort)

      const e = entries.get(input.id)
      if (e === undefined) {
        return err({
          code: "unknown-id",
          message: `side-chat: no chat registered under id '${input.id}'`,
        })
      }
      // Exhaustive state guard — HELL-SC-14 seals this surface.
      switch (e.state) {
        case "active":
          break
        case "stopped":
          return err({
            code: "not-active",
            message: `side-chat: chat '${input.id}' is stopped`,
          })
        default:
          assertNever(e.state)
      }

      if (typeof input.message !== "string" || input.message.length === 0) {
        return err({
          code: "invalid-prompt",
          message: "side-chat: message must be a non-empty string",
        })
      }

      const userAt = now()
      e.messages.push({ role: "user", text: input.message, recordedAt: userAt })
      const reply = makeReply(input.message, now())
      e.messages.push(reply)
      return ok({ reply })
    },

    stop(input: SideChatStopInput): Result<SideChatStopResult, SideChatError> {
      const e = entries.get(input.id)
      if (e === undefined) {
        return err({
          code: "unknown-id",
          message: `side-chat: no chat registered under id '${input.id}'`,
        })
      }
      // Idempotent stop — second call returns the same Ok payload.
      e.state = "stopped"
      return ok({ state: "stopped" })
    },

    list(input: SideChatListInput): ReadonlyArray<SideChatId> {
      if (!isValidParent(input.parentSessionId)) return []
      const rows: Entry[] = []
      for (const e of entries.values()) {
        if (e.parentSessionId !== input.parentSessionId) continue
        if (e.state !== "active") continue
        rows.push(e)
      }
      // newest-first: higher startedAt first; startSeq tiebreaker.
      rows.sort((a, b) => {
        if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
        return b.startSeq - a.startSeq
      })
      return rows.map((r) => r.id)
    },

    closeAllForParent(input: SideChatCloseAllInput): number {
      if (!isValidParent(input.parentSessionId)) return 0
      let n = 0
      for (const e of entries.values()) {
        if (e.parentSessionId !== input.parentSessionId) continue
        if (e.state === "active") {
          e.state = "stopped"
          n += 1
        }
      }
      return n
    },
  }
}
