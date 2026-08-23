/**
 * HELLGATE — `/rewind` does not treat harness speech as a user turn
 * (aug-23 Grok-Build diff, priority 1 / follow-on)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §10.3. `resolveTarget`
 * matches ANY message id and counts `role === "user"` toward `dropTurns`. Every
 * harness utterance in this codebase is a `role:"user"` message, so runtime
 * reminders are (a) addressable rewind targets and (b) inflate the "you will
 * drop N turns" figure the destructive confirm shows the operator.
 *
 * The companion commit made compaction read `isSyntheticUserMessage`; this
 * closes the same hole on the rewind path.
 *
 * Invariants:
 *
 *  H1  NOT COUNTED — harness messages after the target do not inflate
 *      `dropTurns`. The operator is told how many of THEIR turns are lost.
 *
 *  H2  STILL COUNTED IN dropMsgs — they ARE dropped, so the message count must
 *      stay honest. Under-reporting deletion would be a different lie.
 *
 *  H3  NOT ADDRESSABLE — a harness message id is not a valid rewind target.
 *
 *  H4  PAIRED CONTROL — a real user message is still addressable and still
 *      counted, so the fix is not "ignore everything".
 *
 *  H5  UNTAGGED LEGACY — a message with no synthetic id behaves exactly as
 *      before (back-compat).
 */

import { describe, expect, test } from "bun:test"
import { SYNTHETIC_USER_MESSAGE_ID_PREFIX } from "@/agent/synthetic-user"
import { findToLastTargetForTest, resolveTargetForTest } from "@/apps/cli/rewind-cmd"

type Saved = { readonly messages: readonly { role: "user" | "assistant"; id?: string }[] }

const harnessId = (kind: string) => `${SYNTHETIC_USER_MESSAGE_ID_PREFIX}${kind}:abc-123`

const saved: Saved = {
  messages: [
    { role: "user", id: "m1" },
    { role: "assistant", id: "m2" },
    { role: "user", id: harnessId("turn-budget") },
    { role: "user", id: "m3" },
    { role: "assistant", id: "m4" },
    { role: "user", id: harnessId("tool-nudge") },
  ],
}

describe("H1/H2 — harness messages are dropped but not counted as turns", () => {
  const res = resolveTargetForTest(saved, "m1")

  test("dropTurns counts only real user turns after the target", () => {
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    // after m1: [assistant m2, harness, user m3, assistant m4, harness]
    // real user turns = 1 (m3)
    expect(res.dropTurns).toBe(1)
  })

  test("dropMsgs still counts every dropped message", () => {
    if (res.kind !== "ok") return
    expect(res.dropMsgs).toBe(5)
  })
})

describe("H3 — a harness message is not a rewind target", () => {
  test("exact harness id is rejected", () => {
    const res = resolveTargetForTest(saved, harnessId("turn-budget"))
    expect(res.kind).toBe("err")
  })

  test("a prefix that only matches harness ids is rejected", () => {
    const res = resolveTargetForTest(saved, SYNTHETIC_USER_MESSAGE_ID_PREFIX)
    expect(res.kind).toBe("err")
  })
})

describe("H4 — paired control: real messages still work", () => {
  test("a real user id resolves", () => {
    const res = resolveTargetForTest(saved, "m3")
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    expect(res.fullId).toBe("m3")
  })

  test("an assistant id resolves", () => {
    expect(resolveTargetForTest(saved, "m2").kind).toBe("ok")
  })
})

describe("H5 — back-compat for untagged transcripts", () => {
  test("a transcript with no synthetic ids counts every user turn", () => {
    const plain: Saved = {
      messages: [
        { role: "user", id: "a1" },
        { role: "user", id: "a2" },
        { role: "user", id: "a3" },
      ],
    }
    const res = resolveTargetForTest(plain, "a1")
    expect(res.kind).toBe("ok")
    if (res.kind !== "ok") return
    expect(res.dropTurns).toBe(2)
    expect(res.dropMsgs).toBe(2)
  })
})

/** The H6 fixtures are role/id tables like the module-level {@link saved}; this
 *  names the same shape so each case reads as the table it is. */
const savedOf = (messages: Saved["messages"]): Saved => ({ messages })

/* ------------------------------------------------------------------------- *
 * H6 — `--to-last` must not pick a harness message (audit R1 finding #5)
 *
 * `findToLastTarget` walks back to the trailing `role:"user"` message and
 * returns the id BEFORE it. Harness reminders ride as `role:"user"`, so with a
 * trailing reminder it treated the REMINDER as the turn to undo, and could
 * return a synthetic id that `resolveTarget` now refuses — surfacing an
 * internal id in an error message where the command used to work.
 * ------------------------------------------------------------------------- */

describe("H6 — --to-last skips harness messages", () => {
  test("a trailing harness reminder is not the turn to undo", () => {
    const withTrailingHarness = savedOf([
      { role: "user" as const, id: "u1" },
      { role: "assistant" as const, id: "a1" },
      { role: "user" as const, id: "u2" },
      { role: "assistant" as const, id: "a2" },
      { role: "user" as const, id: harnessId("peer-mail") },
    ])
    const target = findToLastTargetForTest(withTrailingHarness)
    // The real last user turn is u2; the message before it is a1.
    expect(target).toBe("a1")
  })

  test("the returned target always resolves", () => {
    const withTrailingHarness = savedOf([
      { role: "user" as const, id: "u1" },
      { role: "assistant" as const, id: "a1" },
      { role: "user" as const, id: "u2" },
      { role: "user" as const, id: harnessId("tool-nudge") },
    ])
    const target = findToLastTargetForTest(withTrailingHarness)
    expect(target).toBeDefined()
    if (target === undefined) return
    expect(resolveTargetForTest(withTrailingHarness, target).kind).toBe("ok")
  })

  test("paired control — no harness messages behaves as before", () => {
    const plain = savedOf([
      { role: "user" as const, id: "u1" },
      { role: "assistant" as const, id: "a1" },
      { role: "user" as const, id: "u2" },
    ])
    expect(findToLastTargetForTest(plain)).toBe("a1")
  })
})
