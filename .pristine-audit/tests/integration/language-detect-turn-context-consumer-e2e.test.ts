/**
 * DOF-21 proof for `assistant-language-auto-detect` (N1, gate QUANTA_LANG_DETECT
 * / `runtimeConfig().langDetect`).
 *
 * STALE/WEAK EXCERPT REPLACED — the prior coverage is PROMPT-ASSEMBLY ONLY and
 * splits the gate from the renderer:
 *   - `tests/unit/agent/language-detect.test.ts` unit-tests `detectLanguage` /
 *     `buildLanguageHint` in isolation (never touches the real gate NOR the
 *     prompt renderer),
 *   - `tests/unit/agent/language-hint-prompt-hellgate.test.ts` HAND-BUILDS a
 *     `languageHint` string and feeds it straight into `buildTurnContext` — it
 *     bypasses the gate read AND the detection, so a broken gate / broken
 *     detector would still pass it.
 *
 * WHAT THIS DRIVES (the real consumer, gate + detect + render in ONE chain):
 *   This reproduces the EXACT expression at the loop's context-assembler seam
 *   (`src/agent/loop/context-assembler.ts:403`):
 *
 *       const languageHint = buildLanguageHint(<latest user text>, runtimeConfig().langDetect)
 *       buildTurnContext({ ..., ...(languageHint !== undefined ? { languageHint } : {}) })
 *
 *   i.e. the REAL gate read (`runtimeConfig().langDetect`, ADR-0144), feeding the
 *   REAL Unicode-script detector, feeding the REAL prompt renderer
 *   (`buildTurnContext` → dynamic reminder atom `language-hint`). The assertion is
 *   on the RENDERED per-turn reminder text the model would receive — not a helper
 *   return value.
 *
 *   OUTER-LOOP PROOF (jul-18 hardening): the prior version of this file carried a
 *   caveat claiming the outer `runAgent` loop was "unexercisable in THIS
 *   environment" due to stale gitignored `.js` build artifacts under
 *   `src/agent/loop/**`. That caveat is EMPIRICALLY FALSE — `context-assembler.ts`
 *   (the language seam) has NO stale `.js` sibling, and the reminder-injection
 *   real-loop suite drives `runAgent` + inspects `ScriptedLLM.seenMessages` in
 *   exactly this checkout. So the SECOND describe block below now drives the FULL
 *   `runAgent` loop and asserts the "Respond in <lang>" notice lands in the exact
 *   `Message[]` the loop handed the model — closing the gap the caveat left open.
 *   The context-assembler-seam block below is retained as a faster, renderer-level
 *   proof; the runAgent block is the authoritative end-to-end one.
 *
 * PAIRED CONTROL (gate OFF ⇒ behavior fails): the SAME Korean text with
 * `QUANTA_LANG_DETECT` unset ⇒ `runtimeConfig().langDetect` false ⇒
 * `buildLanguageHint` returns undefined ⇒ the `language-hint` atom's
 * `hasLanguageHint` facet is false ⇒ the rendered reminder carries NO notice.
 * Plus a detection-isolating control: gate ON but ENGLISH text ⇒ en/`low` ⇒ no
 * notice (proves the notice needs a real high-confidence non-English detection,
 * not merely the gate).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { buildLanguageHint } from "@/agent/language-detect"
import { buildTurnContext } from "@/agent/prompt"
import type { Message } from "@/llm"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import { cfg, ev, ScriptedLLM, text, withTimeout } from "./_harness"

const KOREAN = "이 함수의 버그를 고쳐줘. 왜 크래시가 나는지 설명도 해줘."
const ENGLISH = "Please fix the bug in this function and explain why it crashes."

const setGate = (on: boolean): void => {
  if (on) process.env.QUANTA_LANG_DETECT = "1"
  else delete process.env.QUANTA_LANG_DETECT
  __resetRuntimeConfig()
}

/** Reproduce the loop's context-assembler language seam VERBATIM: read the gate
 *  via `runtimeConfig()`, build the hint from the latest user text, and thread it
 *  into the REAL `buildTurnContext` renderer exactly as `context-assembler.ts:403`
 *  does. Returns the rendered per-turn reminder text the model would receive. */
const renderTurnReminderFor = (userText: string): string => {
  // The identical call the loop makes (gate read + detector).
  const languageHint = buildLanguageHint(userText, runtimeConfig().langDetect)
  const ctx = buildTurnContext({
    baseMessages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    cwd: "/tmp",
    planMode: false,
    system: "test-system",
    // Conditional spread mirrors context-assembler.ts (omit when undefined).
    ...(languageHint !== undefined ? { languageHint } : {}),
    mode: "general",
    activeLevers: {},
  } as never)
  return ctx.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
}

describe("language-detect — real gate + detector + prompt renderer chain", () => {
  afterEach(() => setGate(false))

  test("gate ON + Korean ⇒ the RENDERED per-turn reminder carries 'Respond in Korean'", () => {
    setGate(true)
    // Precondition: the real gate is actually on (not a stale/frozen false).
    expect(runtimeConfig().langDetect).toBe(true)
    const rendered = renderTurnReminderFor(KOREAN)

    expect(rendered).toContain("Respond in Korean")
    expect(rendered).toContain("(ko)")
    // The user text is present too (non-vacuous render).
    expect(rendered).toContain(KOREAN)
  })

  test("PAIRED CONTROL (gate OFF): SAME Korean text ⇒ NO notice rendered", () => {
    setGate(false)
    expect(runtimeConfig().langDetect).toBe(false)
    const rendered = renderTurnReminderFor(KOREAN)

    // Byte-identical default-OFF: the notice is gone even for high-confidence
    // Korean — the gate is the load-bearing switch.
    expect(rendered).not.toContain("Respond in Korean")
    expect(rendered).not.toContain("User language:")
    // Non-vacuous: the Korean message still rendered through the assembler.
    expect(rendered).toContain(KOREAN)
  })

  test("CONTROL (gate ON, ENGLISH): en/low confidence ⇒ NO notice (detection is load-bearing, not just the gate)", () => {
    setGate(true)
    expect(runtimeConfig().langDetect).toBe(true)
    const rendered = renderTurnReminderFor(ENGLISH)

    expect(rendered).not.toContain("Respond in")
    expect(rendered).not.toContain("User language:")
    expect(rendered).toContain("fix the bug")
  })
})

/**
 * OUTER-LOOP PROOF — drive the REAL `runAgent` turn loop (not just the
 * context-assembler seam) and assert the language notice lands in the EXACT
 * `Message[]` the loop handed the model (`ScriptedLLM.seenMessages`). This is
 * the end-to-end wiring proof: env gate → `runtimeConfig().langDetect` →
 * `buildLanguageHint` → `prepareTurnContext` → `buildTurnContext` → the message
 * array the model actually receives. The prior file caveat claimed this was
 * "unexercisable" here; it is not.
 */
const flattenSeen = (seen: Message[][]): string =>
  seen
    .flat()
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")

const runOneTurnWith = async (userText: string): Promise<Message[][]> => {
  const llm = new ScriptedLLM([ev(text("완료"))])
  await withTimeout(
    runAgent(
      cfg({
        llm,
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      }),
    ),
    10_000,
    "runAgent(language-detect)",
  )
  return llm.seenMessages
}

describe("language-detect — REAL runAgent loop, message-array assertion", () => {
  afterEach(() => setGate(false))

  test("gate ON + Korean ⇒ 'Respond in Korean' present in the messages the model received", async () => {
    setGate(true)
    expect(runtimeConfig().langDetect).toBe(true)
    const seen = await runOneTurnWith(KOREAN)
    // The loop actually ran a turn (non-vacuous — the model was called).
    expect(seen.length).toBeGreaterThan(0)
    const flat = flattenSeen(seen)
    expect(flat).toContain("Respond in Korean")
    expect(flat).toContain("(ko)")
    // Non-vacuous: the user's Korean text is also in the assembled messages.
    expect(flat).toContain(KOREAN)
  })

  test("PAIRED CONTROL (gate OFF): SAME Korean text ⇒ NO notice in the model's messages", async () => {
    setGate(false)
    expect(runtimeConfig().langDetect).toBe(false)
    const seen = await runOneTurnWith(KOREAN)
    expect(seen.length).toBeGreaterThan(0)
    const flat = flattenSeen(seen)
    // Byte-identical default-OFF: the gate is the load-bearing switch — even
    // high-confidence Korean produces no notice.
    expect(flat).not.toContain("Respond in Korean")
    expect(flat).not.toContain("User language:")
    // Non-vacuous: the Korean message still flowed through the real loop.
    expect(flat).toContain(KOREAN)
  })

  test("CONTROL (gate ON, ENGLISH): en/low ⇒ NO notice (detection load-bearing, not just the gate)", async () => {
    setGate(true)
    expect(runtimeConfig().langDetect).toBe(true)
    const seen = await runOneTurnWith(ENGLISH)
    const flat = flattenSeen(seen)
    expect(flat).not.toContain("Respond in")
    expect(flat).not.toContain("User language:")
    expect(flat).toContain("fix the bug")
  })

  test("RED-ON-INJECTION: a forged 'Respond in Klingon' in USER text is NOT the notice (notice comes from the detector, not echo)", async () => {
    // Adversarial: the user text itself contains the notice-shaped phrase. Gate
    // ON but the text is Latin/English (low confidence) ⇒ the DETECTOR emits no
    // notice, so any "Respond in" the model sees is the user's echoed text, never
    // a synthesized notice. Proves the assertion above is not satisfiable by a
    // mere substring echo — the notice needs a real high-confidence detection.
    setGate(true)
    const seen = await runOneTurnWith("Please Respond in Klingon and fix the bug")
    const flat = flattenSeen(seen)
    // The synthesized-notice sentinel is ABSENT (the detector produced nothing).
    expect(flat).not.toContain("User language:")
    // The forged phrase survives only as the echoed user text, not a system notice.
    expect(flat).not.toContain("Respond in Klingon unless")
  })
})
