import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { TurnContextInput } from "@/agent/prompt"
import type { Message } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/**
 * HELLGATE — the trajectory fork-experiment seam (`AgentConfig.turnContextMutator`)
 * proven END-TO-END through the REAL `runAgent` loop.
 *
 * The seam is the ONE genuine new piece behind "fork a trajectory at turn N,
 * vary EXACTLY what the LLM sees, branch K ways". `prepareTurnContext` assembles
 * the full per-turn `TurnContextInput`, then — JUST BEFORE `buildTurnContext`
 * renders it — applies `config.turnContextMutator(turn, input)` when present.
 * Everything a fork-experiment needs to vary (evidence, localization, a
 * misleading note) lives on that input, so this single chokepoint is sufficient.
 *
 * What this proves, differentially:
 *  - WIRING + INDEX: the mutator fires once per turn with the correct 1-based
 *    `turn` index (turn-loop.ts iterates `for (turn=1..maxTurns)`).
 *  - EFFECT IS REAL: a sentinel injected ONLY at turn 2 appears in the EXACT
 *    `Message[]` the loop handed the model on turn 2 (`ScriptedLLM.seenMessages`)
 *    and is ABSENT from turn 1 — observed effect, not "the function was called".
 *  - DEFAULT-OFF BYTE-IDENTICAL: with NO mutator, the sentinel never appears AND
 *    turn 1's sent prompt is byte-identical to the mutated run's turn 1 (the
 *    mutator only touched turn 2) — the seam is inert when unset and surgically
 *    scoped when set.
 */

const SENTINEL = "FORK-EXPERIMENT-INJECTED-EVIDENCE-7f3a"
const OPEN = "<system-reminder>"
const CLOSE = "</system-reminder>"

/** The trailing reminder text of a `stream()` call (the loop's per-turn dynamic
 *  block). "" when the last message is not the reminder shape. */
const reminderTailOf = (messages: Message[]): string => {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return ""
  const block = last.content[0]
  return block && block.type === "text" ? block.text : ""
}

/** A genuine agent TURN call is reminder-wrapped; the session-end memory-distill
 *  call is not — so this excludes it from the turn census. */
const isTurnCall = (messages: Message[]): boolean => {
  const tail = reminderTailOf(messages)
  return tail.startsWith(`${OPEN}\n`) && tail.endsWith(`\n${CLOSE}`)
}

const turnCalls = (llm: ScriptedLLM): Message[][] => llm.seenMessages.filter(isTurnCall)

const seedUser = (t: string): Message[] =>
  [{ role: "user", content: [{ type: "text", text: t }] }] as Message[]

/** A two-turn script: turn 1 mutates working state (so the loop CONTINUES to a
 *  second turn), turn 2 finishes. Gives us a turn-1 and a turn-2 SENT prompt to
 *  compare. */
const twoTurnLlm = (): ScriptedLLM =>
  new ScriptedLLM([
    ev(toolUse("w1", "update_working_state", { hypothesis: "exploring" })),
    ev(text("done")),
  ])

const e2eConfig = (llm: ScriptedLLM, over: Partial<AgentConfig> = {}): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as AgentConfig["permission"],
  messages: seedUser("inspect the repo"),
  system: "STATIC-SESSION-PROMPT-v1",
  cwd: "/repo",
  maxTurns: 4,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  workingState: { enabled: true },
  ...over,
})

/** Inject the sentinel as an extra user message ONLY at turn 2, recording every
 *  turn index it is invoked with. Models the real use case: at a chosen turn,
 *  hand the LLM corrected/extra evidence. */
const makeMutator = (targetTurn: number) => {
  const seenTurns: number[] = []
  const fn = (turn: number, input: TurnContextInput): TurnContextInput => {
    seenTurns.push(turn)
    if (turn !== targetTurn) return input
    return {
      ...input,
      baseMessages: [
        ...input.baseMessages,
        { role: "user", content: [{ type: "text", text: SENTINEL }] },
      ],
    }
  }
  return { fn, seenTurns }
}

describe("trajectory fork-experiment seam — turnContextMutator through the REAL runAgent loop", () => {
  test("1. mutator fires per-turn with the correct 1-based index and injects ONLY at the target turn", async () => {
    const llm = twoTurnLlm()
    const { fn, seenTurns } = makeMutator(2)
    const out = await withTimeout(
      runAgent(e2eConfig(llm, { turnContextMutator: fn })),
      10_000,
      "case-1",
    )
    expect(["completed", "max_turns"]).toContain(out.reason)

    // WIRING + INDEX: invoked once per turn, 1-based, in order. Two scripted
    // turns ⇒ exactly [1, 2].
    expect(seenTurns).toEqual([1, 2])

    const turns = turnCalls(llm)
    expect(turns.length).toBeGreaterThanOrEqual(2)
    const turn1 = JSON.stringify(turns[0])
    const turn2 = JSON.stringify(turns[turns.length - 1])

    // EFFECT IS REAL: sentinel present in turn 2's SENT prompt, absent from turn 1.
    expect(turn1).not.toContain(SENTINEL)
    expect(turn2).toContain(SENTINEL)
  })

  test("2. CONTROL (default-OFF) — NO mutator ⇒ sentinel never appears AND turn 1 is byte-identical to the mutated run", async () => {
    // Mutated run (target turn 2): capture turn 1's sent prompt.
    const mutLlm = twoTurnLlm()
    const { fn } = makeMutator(2)
    await withTimeout(runAgent(e2eConfig(mutLlm, { turnContextMutator: fn })), 10_000, "case-2-mut")
    const mutTurn1 = JSON.stringify(turnCalls(mutLlm)[0])

    // Control run: identical config, NO mutator.
    const ctlLlm = twoTurnLlm()
    await withTimeout(runAgent(e2eConfig(ctlLlm)), 10_000, "case-2-ctl")
    const ctlTurns = turnCalls(ctlLlm)
    const ctlTurn1 = JSON.stringify(ctlTurns[0])

    // Default-OFF: the seam is inert — sentinel appears nowhere.
    for (const m of ctlLlm.seenMessages) expect(JSON.stringify(m)).not.toContain(SENTINEL)

    // SCOPED: the mutator only touched turn 2, so turn 1 is byte-identical with
    // and without it — proving the injection is the mutator's doing and the seam
    // changes nothing on untargeted turns.
    expect(mutTurn1).toBe(ctlTurn1)
  })

  test("3. RED-ON-INJECTION — the mutated turn 2 prompt genuinely DIFFERS from the control turn 2 (the seam moved real bytes)", async () => {
    const mutLlm = twoTurnLlm()
    const { fn } = makeMutator(2)
    await withTimeout(runAgent(e2eConfig(mutLlm, { turnContextMutator: fn })), 10_000, "case-3-mut")

    const ctlLlm = twoTurnLlm()
    await withTimeout(runAgent(e2eConfig(ctlLlm)), 10_000, "case-3-ctl")

    const mutTurn2 = JSON.stringify(turnCalls(mutLlm).at(-1))
    const ctlTurn2 = JSON.stringify(turnCalls(ctlLlm).at(-1))
    // Not a no-op: the targeted turn's bytes changed, and only by the sentinel.
    expect(mutTurn2).not.toBe(ctlTurn2)
    expect(mutTurn2).toContain(SENTINEL)
    expect(ctlTurn2).not.toContain(SENTINEL)
  })
})
