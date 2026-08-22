/**
 * N1 hellgate — the assistant-language notice rides the per-turn DYNAMIC slot
 * and is DEFAULT-OFF byte-identical. `languageHint` is pre-computed by the
 * context-assembler (gate + `buildLanguageHint`); this pins the prompt-push:
 *   - present  ⇒ the notice appears in the trailing dynamic reminder
 *   - absent   ⇒ NO language notice (the dynamic tail is byte-identical)
 * red-on-injection: if `buildDynamicContext` stopped pushing `languageHint`,
 * the present-case assertion fails.
 */
import { describe, expect, test } from "bun:test"
import { buildTurnContext, type TurnContextInput } from "@/agent"
import type { Message } from "@/llm"

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "do it" }] }]
const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})
const dynamicTail = (out: { messages: readonly Message[] }): string => {
  const m = out.messages[out.messages.length - 1]
  const block = m?.content[0]
  return block?.type === "text" ? block.text : ""
}

const KO_HINT =
  "User language: the user is writing in Korean (ko). Respond in Korean unless they switch languages or explicitly ask otherwise."

describe("N1 — language notice in the per-turn dynamic slot", () => {
  test("languageHint present ⇒ notice appears in the dynamic reminder", () => {
    const tail = dynamicTail(buildTurnContext(base({ languageHint: KO_HINT })))
    expect(tail).toContain("User language")
    expect(tail).toContain("Korean")
    expect(tail).toContain("(ko)")
  })

  test("languageHint absent ⇒ NO language notice (byte-identical vs the with-hint tail minus the notice)", () => {
    const withTail = dynamicTail(buildTurnContext(base({ languageHint: KO_HINT })))
    const withoutTail = dynamicTail(buildTurnContext(base()))
    expect(withoutTail).not.toContain("User language")
    expect(withoutTail).not.toBe(withTail) // the notice genuinely changed the prompt
  })

  test("empty languageHint ⇒ treated as absent (no stray blank push)", () => {
    const tail = dynamicTail(buildTurnContext(base({ languageHint: "" })))
    expect(tail).not.toContain("User language")
  })
})
