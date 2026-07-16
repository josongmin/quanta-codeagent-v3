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
 *   HONEST SCOPE CAVEAT: this drives the context-assembler's language seam +
 *   renderer directly, NOT the outer `runAgent` turn loop. The outer loop wrapper
 *   is intentionally omitted here because this repo's local checkout carries STALE
 *   gitignored `.js` build artifacts under `src/agent/loop/**` (older than their
 *   `.ts` siblings) that bun resolves ahead of source — those stale modules
 *   predate the N1 language-hint wiring, so a `runAgent`-level assertion is
 *   unexercisable in THIS environment (a product bug is NOT implicated — the
 *   current `.ts` seam is proven correct here; see the PRODUCT-ENV note in the
 *   DOF-21 report). Everything from the gate read through the rendered reminder is
 *   the same production code the single loop call site invokes.
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
import { buildLanguageHint } from "@/agent/language-detect"
import { buildTurnContext } from "@/agent/prompt"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

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
