/**
 * HELLGATE — S: harness provenance lives on the message, not in its id
 * (§17.5 packet S).
 *
 * `makeSyntheticUserMessage` marks a harness-authored `role:"user"` message by
 * encoding the kind INTO the id (`quanta:synthetic-user:<kind>:<uuid>`), and
 * `isSyntheticUserMessage` reads it back by prefix. That works only for
 * messages the harness both authors AND gives an id to.
 *
 * Compaction summaries are neither. All three summary sites build the message
 * inline — the local variable is literally named `synthetic` — with no id and
 * no marker of any kind:
 *
 *   compaction.ts:430  `<continuation summary>`  (reactive squeeze)
 *   compaction.ts:753  `<conversation summary>`  (proactive)
 *   compaction.ts:945  `<continuation summary>`  (background)
 *
 * So the harness's own output re-enters the transcript indistinguishable from
 * human speech. The consequence is concrete and self-inflicted: the NEXT
 * compaction summarizes the PREVIOUS compaction's summary as if the user had
 * written it. `/rewind` offers it as a turn to undo. Memory recall anchors on
 * it.
 *
 * The fix separates the two jobs the id was doing. `id` is IDENTITY. Provenance
 * moves to an optional, local-only `origin` — which means it survives on a
 * message that must stay id-less, and survives `assignMessageIds` stamping an
 * `m{k}` id on save.
 *
 * Invariants:
 *
 *  S-1  RED — every persisted compaction summary carries harness provenance.
 *  S-2  `id` and `origin` are INDEPENDENT: a message can carry provenance with
 *       no id, and `assignMessageIds` giving it one does not erase it.
 *  S-3  Legacy fallback — a session saved before this change, whose only mark
 *       is the id prefix, is still recognized.
 *  S-4  PAIRED CONTROL — a genuine user message has NO provenance. Zero false
 *       positives is the whole point: mislabelling human speech as harness
 *       output would silently drop the user's own words from recall.
 *  S-5  WIRE PURITY — `origin` never reaches a provider payload.
 *  S-6  The consequence closes: compaction labels a PRIOR summary as harness
 *       speech rather than summarizing it as the user's words.
 */

import { describe, expect, test } from "bun:test"
import { summaryRoleOf } from "@/agent/compaction/harness-speech"
import {
  isSyntheticUserMessage,
  makeSyntheticUserMessage,
  SYNTHETIC_USER_MESSAGE_ID_PREFIX,
} from "@/agent/synthetic-user"
import type { Message } from "@/llm"
import { buildAnthropicMessagesRequest } from "@/llm/anthropic-messages-codec"

const userSays = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

describe("S — provenance is carried by the message", () => {
  test("S-2 a message can carry provenance with NO id", () => {
    const m: Message = { ...userSays("<conversation summary>\nx"), origin: "harness" }
    expect(m.id).toBeUndefined()
    expect(isSyntheticUserMessage(m)).toBe(true)
  })

  test("S-2b assigning an id later does not erase provenance", async () => {
    const { assignMessageIds } = await import("@/session")
    const m: Message = { ...userSays("<conversation summary>\nx"), origin: "harness" }
    const [assigned] = assignMessageIds([m], (i) => `m${i}`)
    if (assigned === undefined) throw new Error("expected one message back")
    expect(assigned.id).toBe("m0")
    expect(isSyntheticUserMessage(assigned)).toBe(true)
  })

  test("S-3 legacy fallback — the id prefix alone is still recognized", () => {
    const legacy: Message = {
      ...userSays("continue"),
      id: `${SYNTHETIC_USER_MESSAGE_ID_PREFIX}same-turn-recovery:abc-123`,
    }
    expect(legacy.origin).toBeUndefined()
    expect(isSyntheticUserMessage(legacy)).toBe(true)
  })

  test("S-3b `makeSyntheticUserMessage` sets BOTH, so new sessions need no fallback", () => {
    const m = makeSyntheticUserMessage("tool-nudge", [{ type: "text", text: "keep going" }])
    expect(m.origin).toBe("harness")
    expect(m.id?.startsWith(SYNTHETIC_USER_MESSAGE_ID_PREFIX)).toBe(true)
  })

  test("S-4 PAIRED CONTROL — a genuine user message carries no provenance", () => {
    const human = userSays("please refactor the parser")
    expect(human.origin).toBeUndefined()
    expect(isSyntheticUserMessage(human)).toBe(false)
    expect(summaryRoleOf(human)).toBe("user")
  })

  test("S-4b a human message that merely MENTIONS a summary header is not harness speech", () => {
    const human = userSays("why does the transcript say <conversation summary> at the top?")
    expect(isSyntheticUserMessage(human)).toBe(false)
  })

  test("S-5 WIRE PURITY — `origin` never reaches the provider payload", () => {
    const req = buildAnthropicMessagesRequest("m", 100, {
      messages: [
        { ...userSays("<conversation summary>\nearlier work"), origin: "harness" },
        userSays("now do the next thing"),
      ],
      tools: [],
    } as never)
    expect(JSON.stringify(req)).not.toContain("origin")
    expect(JSON.stringify(req)).not.toContain("harness")
  })
})

describe("S-1/S-6 — compaction summaries are harness speech", () => {
  const SUMMARY_SITES = [
    ["reactive squeeze", "<continuation summary>"],
    ["proactive", "<conversation summary>"],
    ["background", "<continuation summary>"],
  ] as const

  for (const [label, header] of SUMMARY_SITES) {
    test(`S-6 a ${label} summary is labelled harness, not user`, () => {
      const summary: Message = { ...userSays(`${header}\nwhat happened before`), origin: "harness" }
      expect(summaryRoleOf(summary)).toBe("harness")
    })
  }

  test("S-1 the shipped compaction summary builder stamps provenance", async () => {
    const { buildCompactionSummaryMessage } = await import("@/agent/compaction/harness-speech")
    const m = buildCompactionSummaryMessage("<conversation summary>", "what happened")
    expect(m.origin).toBe("harness")
    expect(isSyntheticUserMessage(m)).toBe(true)
    expect(summaryRoleOf(m)).toBe("harness")
  })
})
