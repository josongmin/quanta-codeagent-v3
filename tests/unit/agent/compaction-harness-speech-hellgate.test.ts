/**
 * HELLGATE — compaction must not summarize harness speech as the user's
 * (aug-23 Grok-Build diff, priority 1)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §10.3, verified by
 * EXECUTION during the audit: driving the real injectors into a real working
 * memory and capturing the summarizer prompt produced FIVE `[user]` turns of
 * which ONE was a human. `renderForSummary` consults only `m.role`, and
 * `SUMMARY_SYSTEM` explicitly instructs the summarizer to preserve
 * "security-relevant instructions or constraints the user stated… verbatim" —
 * so a harness reminder can be canonized as a user constraint.
 *
 * The audit also proved TAGGING ALONE IS NOT ENOUGH: messages already carrying
 * `makeSyntheticUserMessage` ids reached the summarizer as `[user]` too,
 * because compaction never reads the marker. The consumer must change.
 *
 * Invariants:
 *
 *  H1  LABELLED — a tagged harness message is NOT rendered as `[user]`.
 *  H2  HUMAN SPEECH IS UNTOUCHED (paired control) — a real user turn still
 *      renders as `[user]`, so the fix is not "relabel everything".
 *  H3  CONTENT SURVIVES — the harness text is still present. Compaction must
 *      not silently drop context; the defect is mis-attribution, not presence.
 *  H4  BOUNDARY IS NOT ANCHORED BY HARNESS TURNS — `findBoundary` counts turns
 *      to keep. Harness messages are not turns the user took, so they must not
 *      consume the keep-window.
 *  H5  UNTAGGED LEGACY MESSAGES still render as before (back-compat: the tag is
 *      the signal, and absent it nothing changes).
 */

import { describe, expect, test } from "bun:test"
import { findBoundary, renderMessagesForSummary } from "@/agent/compaction"
import { makeSyntheticUserMessage } from "@/agent/synthetic-user"
import type { Message } from "@/llm"

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const harness = (text: string): Message =>
  makeSyntheticUserMessage("same-turn-recovery", [{ type: "text", text }])

describe("H1/H2/H3 — harness speech is labelled, human speech is not", () => {
  const rendered = renderMessagesForSummary([
    user("Never touch secrets.txt"),
    harness("You returned an empty response. Continue the task."),
    assistant("ok"),
  ])

  test("the human turn is still [user]", () => {
    expect(rendered).toContain("[user] Never touch secrets.txt")
  })

  test("the harness turn is NOT attributed to the user", () => {
    expect(rendered).not.toContain("[user] You returned an empty response")
  })

  test("its content is preserved (mis-attribution is the bug, not presence)", () => {
    expect(rendered).toContain("You returned an empty response")
  })

  test("exactly one [user] turn is present", () => {
    expect(rendered.split("[user]").length - 1).toBe(1)
  })
})

describe("H4 — harness messages do not consume the keep-window", () => {
  test("boundary keeps the same USER turns regardless of interleaved harness turns", () => {
    const withHarness: Message[] = [
      user("first"),
      assistant("a1"),
      harness("nudge"),
      user("second"),
      assistant("a2"),
      harness("another nudge"),
      user("third"),
      assistant("a3"),
    ]
    const withoutHarness: Message[] = [
      user("first"),
      assistant("a1"),
      user("second"),
      assistant("a2"),
      user("third"),
      assistant("a3"),
    ]
    // Keeping 2 turns must retain "second"/"third" in BOTH transcripts.
    const keptWith = withHarness.slice(findBoundary(withHarness, 2))
    const keptWithout = withoutHarness.slice(findBoundary(withoutHarness, 2))
    const userTextsOf = (ms: Message[]): string[] =>
      ms
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content.map((b) => ("text" in b ? b.text : "")))
        .filter((t) => t === "first" || t === "second" || t === "third")
    expect(userTextsOf(keptWith)).toEqual(userTextsOf(keptWithout))
  })
})

describe("H5 — back-compat for untagged messages", () => {
  test("an untagged user message renders as [user]", () => {
    expect(renderMessagesForSummary([user("plain")])).toContain("[user] plain")
  })
})
