/**
 * GOAL-08 rail 15 (web half) — the `goalWork` WS frame decoder.
 *
 * A browser/IDE client asks the LIVE session for ONE user-requested goal turn
 * by sending `{kind:"goalWork", text}`. Like `peekControlRequest` /
 * `peekFollowerVerb` this is peeked + CONSUMED at the connection layer BEFORE
 * the session bridge — it is NOT a `SessionCommand` and never reaches the
 * kernel reducer. The decoder validates ONLY the envelope (NO-THROW); content
 * bounds + the goal state are the composed handler's contract.
 */

import { describe, expect, test } from "bun:test"
import { peekGoalWork } from "@/apps/web-daemon/goal-work-frame"

describe("GOAL-08 rail 15 — goalWork frame decoder", () => {
  test("a well-formed frame decodes to its text", () => {
    expect(peekGoalWork(JSON.stringify({ kind: "goalWork", text: "fix the flake" }))).toEqual({
      text: "fix the flake",
    })
  })

  test("the text is trimmed (CLI `/goal work` parity)", () => {
    expect(peekGoalWork(JSON.stringify({ kind: "goalWork", text: "  fix it  " }))).toEqual({
      text: "fix it",
    })
  })

  test.each([
    ["not json", "}{"],
    ["a JSON null frame", "null"],
    ["a non-object frame", JSON.stringify("goalWork")],
    // An array cannot carry a `kind`, so this pins the shape of the REFUSAL
    // (null, never a throw) rather than the `Array.isArray` guard itself —
    // that guard is unkillable from the wire and mirrors the sibling peekers.
    ["an array frame", JSON.stringify([{ kind: "goalWork", text: "x" }])],
    ["another kind", JSON.stringify({ kind: "controlRequest", request: { kind: "set_model" } })],
    ["a missing text", JSON.stringify({ kind: "goalWork" })],
    ["a non-string text", JSON.stringify({ kind: "goalWork", text: 7 })],
    ["a blank text", JSON.stringify({ kind: "goalWork", text: "   " })],
  ])("%s ⇒ null (falls through to the session bridge)", (_label, raw) => {
    expect(peekGoalWork(raw)).toBeNull()
  })
})
