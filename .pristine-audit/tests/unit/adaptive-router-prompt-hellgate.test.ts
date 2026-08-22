/**
 * Hellgate for the v5 router prompt scaffold (jun-22 Wave-1). The prompt must
 * present the COMPLETE closed action menu + gap taxonomy and restate the hard
 * authority rules, or the model can propose illegal output the parser then has to
 * reject. Drift-pinned against the action/gap sets so a new action can't silently
 * drop out of the menu.
 */

import { describe, expect, test } from "bun:test"
import {
  ACTION_DESCRIPTIONS,
  ADAPTIVE_ACTIONS,
  buildRouterInstruction,
  buildRouterPrompt,
  EVIDENCE_GAP_DESCRIPTIONS,
  EVIDENCE_GAPS,
} from "@/runner/batch/eval/adaptive-escalation"

describe("adaptive router prompt scaffold", () => {
  test("PROMPT-1: instruction lists EVERY action with a description (no menu gap)", () => {
    const text = buildRouterInstruction()
    for (const action of ADAPTIVE_ACTIONS) {
      expect(text, `menu must list ${action}`).toContain(action)
      expect(ACTION_DESCRIPTIONS[action].length).toBeGreaterThan(0)
    }
  })

  test("PROMPT-2: instruction lists EVERY evidence gap", () => {
    const text = buildRouterInstruction()
    for (const gap of EVIDENCE_GAPS) expect(text, `must list ${gap}`).toContain(gap)
  })

  test("PROMPT-3: the hard authority rules are stated in-prompt", () => {
    const text = buildRouterInstruction().toLowerCase()
    expect(text).toContain("exactly one")
    expect(text).toContain("cite only")
    expect(text).toContain("never name a preset")
    expect(text).toContain("knob value")
    expect(text).toContain("routing, not submitting")
  })

  test("DRIFT-5: ACTION_DESCRIPTIONS keys are EXACTLY the action set", () => {
    expect(Object.keys(ACTION_DESCRIPTIONS).sort()).toEqual([...ADAPTIVE_ACTIONS].sort())
  })

  test("DRIFT-6: EVIDENCE_GAP_DESCRIPTIONS keys are EXACTLY the gap set", () => {
    expect(Object.keys(EVIDENCE_GAP_DESCRIPTIONS).sort()).toEqual([...EVIDENCE_GAPS].sort())
  })

  test("PROMPT-4: buildRouterPrompt embeds the rendered packet after the instruction", () => {
    const prompt = buildRouterPrompt("<<PACKET-BODY>>")
    expect(prompt.startsWith(buildRouterInstruction())).toBe(true)
    expect(prompt).toContain("<<PACKET-BODY>>")
    expect(prompt.indexOf("<<PACKET-BODY>>")).toBeGreaterThan(prompt.indexOf("ACTIONS"))
  })

  test("PROMPT-5: no preset name leaks into the static instruction", () => {
    expect(buildRouterInstruction()).not.toContain("agentless-v")
  })
})
