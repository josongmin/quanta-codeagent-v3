/**
 * Hellgate — fork_turns parent-context inheritance (GAP8a).
 *
 * Proves the pure selection + preamble core: none/all/N turn selection by
 * user-message boundary, redacted DATA-framed preamble, byte-identical cold start.
 */
import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import {
  buildForkTurnsPreamble,
  composeForkedPrompt,
  selectForkTurns,
} from "@/agent/fork-turns"

const u = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] })
const a = (t: string): Message => ({ role: "assistant", content: [{ type: "text", text: t }] })
// 3 user turns: [u1,a1, u2,a2, u3,a3]
const convo: Message[] = [u("u1"), a("a1"), u("u2"), a("a2"), u("u3"), a("a3")]
const flatRedact = (ms: readonly Message[]): string =>
  ms.map((m) => `${m.role}:${m.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`).join("\n")

describe("selectForkTurns", () => {
  test("none ⇒ []", () => expect(selectForkTurns(convo, "none")).toEqual([]))
  test("all ⇒ full copy (new array)", () => {
    const r = selectForkTurns(convo, "all")
    expect(r).toEqual(convo)
    expect(r).not.toBe(convo)
  })
  test("N ⇒ last N user-turns + their responses", () => {
    // last 1 turn = from u3
    expect(selectForkTurns(convo, 1)).toEqual([u("u3"), a("a3")])
    // last 2 turns = from u2
    expect(selectForkTurns(convo, 2)).toEqual([u("u2"), a("a2"), u("u3"), a("a3")])
  })
  test("N ≥ available user turns ⇒ all", () => {
    expect(selectForkTurns(convo, 99)).toEqual(convo)
  })
  test("N ≤ 0 / non-finite ⇒ [] (no inheritance)", () => {
    expect(selectForkTurns(convo, 0)).toEqual([])
    expect(selectForkTurns(convo, -3)).toEqual([])
    expect(selectForkTurns(convo, Number.NaN)).toEqual([])
  })
  test("non-integer N is floored", () => {
    expect(selectForkTurns(convo, 1.9)).toEqual([u("u3"), a("a3")])
  })
})

describe("buildForkTurnsPreamble + composeForkedPrompt", () => {
  test("none ⇒ undefined preamble ⇒ prompt UNCHANGED (byte-identical cold start)", () => {
    const pre = buildForkTurnsPreamble(convo, "none", flatRedact)
    expect(pre).toBeUndefined()
    expect(composeForkedPrompt("do the task", pre)).toBe("do the task")
  })
  test("N ⇒ redacted preamble of the last N turns, DATA-framed", () => {
    const pre = buildForkTurnsPreamble(convo, 1, flatRedact)
    expect(pre).toBe("user:u3\nassistant:a3")
    const composed = composeForkedPrompt("do it", pre)
    expect(composed).toContain("Inherited parent context")
    expect(composed).toContain("DATA")
    expect(composed).toContain("u3")
    expect(composed).toContain("## Your task\ndo it")
  })
  test("empty conversation ⇒ undefined preamble", () => {
    expect(buildForkTurnsPreamble([], "all", flatRedact)).toBeUndefined()
  })
  test("the injected redactor IS applied (scrubbing happens)", () => {
    const scrub = (_ms: readonly Message[]): string => "[REDACTED]"
    expect(buildForkTurnsPreamble(convo, "all", scrub)).toBe("[REDACTED]")
  })
})
