/**
 * RFC-03 C2b — objective-visibility LOOP-CONSUMER wiring hellgate (the seam the
 * existing coverage does NOT reach).
 *
 * Two existing tests split the chain and both bypass the loop's call+thread:
 *   - `tests/unit/agent/loop/context-assembler.test.ts` unit-tests
 *     `resolveObjectiveThunk` in ISOLATION (never runs the assembler that CALLS it).
 *   - `tests/unit/agent/objective-prompt-visibility-hellgate.test.ts` HAND-BUILDS the
 *     objective thunk and feeds it straight into `buildTurnContext` — it proves the
 *     RENDERER but bypasses the two loop lines that actually wire the authority in.
 *
 * WHAT THIS DRIVES (the real consumer, authority → thunk → thread → model messages):
 *   The loop's context-assembler seam is EXACTLY two lines
 *   (`src/agent/loop/context-assembler.ts`):
 *
 *       const objectiveThunk = resolveObjectiveThunk(config)                 // :466 (CALL)
 *       ...(objectiveThunk !== undefined ? { objective: objectiveThunk } : {}) // :504 (THREAD)
 *
 *   Delete EITHER and the model never sees the goal, yet BOTH tests above stay
 *   green (the unit test still resolves the thunk; the render test still hand-feeds
 *   one). This drives the REAL `runAgent` loop with a live `config.objective` +
 *   `config.sessionId` and asserts the `## Current objective` block lands in the
 *   EXACT `Message[]` the loop handed the model (`ScriptedLLM.seenMessages`) — the
 *   end-to-end wire the two lines implement. Mirrors the language-detect
 *   turn-context consumer e2e (the sibling per-turn dynamic-tail feature).
 *
 * PAIRED CONTROL: same goal on the authority but NO `sessionId` ⇒
 * `resolveObjectiveThunk` returns undefined (gated) ⇒ the block is absent even
 * though the store holds the goal — proving the wire (not an unconditional render)
 * is load-bearing. Plus a no-authority control.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { Message } from "@/llm"
import { createObjectiveStore } from "@/objective"
import { cfg, ev, ScriptedLLM, text, withTimeout } from "./_harness"

const THREAD = "sess-objective-consumer-1"
const GOAL = "Ship the objective loop-consumer wiring proof"

const flattenSeen = (seen: Message[][]): string =>
  seen
    .flat()
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")

const runOneTurn = async (over: Partial<Parameters<typeof cfg>[0]>): Promise<Message[][]> => {
  const llm = new ScriptedLLM([ev(text("done"))])
  await withTimeout(
    runAgent(
      cfg({
        llm,
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        ...over,
      }),
    ),
    10_000,
    "runAgent(objective-consumer)",
  )
  return llm.seenMessages
}

describe("C2b — objective is threaded into the REAL loop's per-turn messages", () => {
  afterEach(() => {
    /* no env gate — config-level wire; nothing to reset */
  })

  test("live authority + sessionId ⇒ '## Current objective' + goal land in the model's messages", async () => {
    const objective = createObjectiveStore()
    objective.set(THREAD, { goal: GOAL })
    const seen = await runOneTurn({ objective, sessionId: THREAD })
    // The loop actually ran a turn (non-vacuous — the model was called).
    expect(seen.length).toBeGreaterThan(0)
    const flat = flattenSeen(seen)
    expect(flat).toContain("## Current objective")
    expect(flat).toContain(GOAL)
    expect(flat).toContain("status: active")
  })

  test("PAIRED CONTROL (no sessionId): SAME goal on the authority ⇒ NO block (the wire is gated, not unconditional)", async () => {
    const objective = createObjectiveStore()
    objective.set(THREAD, { goal: GOAL })
    // sessionId omitted ⇒ resolveObjectiveThunk returns undefined ⇒ thread skipped.
    const seen = await runOneTurn({ objective })
    expect(seen.length).toBeGreaterThan(0)
    const flat = flattenSeen(seen)
    expect(flat).not.toContain("## Current objective")
    expect(flat).not.toContain(GOAL)
  })

  test("CONTROL (no authority): sessionId but no objective ⇒ NO block (byte-identical default)", async () => {
    const seen = await runOneTurn({ sessionId: THREAD })
    const flat = flattenSeen(seen)
    expect(flat).not.toContain("## Current objective")
  })
})
