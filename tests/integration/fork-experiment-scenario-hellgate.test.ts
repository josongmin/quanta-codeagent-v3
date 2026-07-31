import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { resolveForkExperiments } from "@/apps/bench/eval/fork-experiments"
import type { Message } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/**
 * HELLGATE — the FULL fork-experiment scenario, end-to-end, the way an LLM/agent
 * operator actually triggers it: ENV → `resolveForkExperiments` → the resolved
 * `turnContextMutator` → the REAL `runAgent` loop → the bytes the model receives.
 *
 * The unit suites prove the registry resolves names and the seam fires in
 * isolation; the replay suite proves per-branch cassette isolation. This suite
 * composes them into the operator's actual workflow and pins each scenario:
 *
 *   A. INJECT arm from env: `QUANTA_FORK_EXPERIMENT=inject` + turn/text ⇒ the
 *      text appears in turn N's SENT prompt and NOWHERE else (turn-scoped).
 *   B. BASELINE arm from env: the control arm changes nothing — no sentinel in
 *      any sent prompt (proves the A/B control is genuinely inert).
 *   C. TWO-ARM fan-out input (`baseline,inject`): one env yields two DISTINCT
 *      mutators; driven through the loop, baseline stays clean while inject
 *      injects — the side-by-side an experiment run compares.
 *   D. DEFAULT-OFF: no env ⇒ `resolveForkExperiments` returns [] ⇒ no mutator ⇒
 *      the sent prompt is byte-identical to a plain run.
 *
 * Inspecting `ScriptedLLM.seenMessages` ties the assertion to the EXACT prompt
 * the loop handed the model — not "the function was called".
 */

const SENTINEL = "FORK-SCENARIO-INJECTED-HINT-9b2e"
const OPEN = "<system-reminder>"
const CLOSE = "</system-reminder>"

const reminderTailOf = (messages: Message[]): string => {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return ""
  const block = last.content[0]
  return block && block.type === "text" ? block.text : ""
}
const isTurnCall = (messages: Message[]): boolean => {
  const tail = reminderTailOf(messages)
  return tail.startsWith(`${OPEN}\n`) && tail.endsWith(`\n${CLOSE}`)
}
const turnCalls = (llm: ScriptedLLM): Message[][] => llm.seenMessages.filter(isTurnCall)
const containsSentinel = (messages: Message[]): boolean =>
  JSON.stringify(messages).includes(SENTINEL)

const seedUser = (t: string): Message[] =>
  [{ role: "user", content: [{ type: "text", text: t }] }] as Message[]

/** Two-turn script so there is a turn 1 and a turn 2 to distinguish. */
const twoTurnLlm = (): ScriptedLLM =>
  new ScriptedLLM([
    ev(toolUse("w1", "update_working_state", { hypothesis: "exploring" })),
    ev(text("done")),
  ])

const baseConfig = (llm: ScriptedLLM, over: Partial<AgentConfig> = {}): AgentConfig => ({
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

/** Resolve the named experiment from an env snapshot exactly as the bench wiring
 *  does, returning its mutator (or undefined for the OFF case). */
const mutatorFor = (
  env: Record<string, string>,
  name: string,
): AgentConfig["turnContextMutator"] | undefined =>
  resolveForkExperiments(env).find((e) => e.name === name)?.mutator

const runWith = async (
  mutator: AgentConfig["turnContextMutator"] | undefined,
  label: string,
): Promise<ScriptedLLM> => {
  const llm = twoTurnLlm()
  const over = mutator !== undefined ? { turnContextMutator: mutator } : {}
  const out = await withTimeout(runAgent(baseConfig(llm, over)), 10_000, label)
  expect(["completed", "max_turns"]).toContain(out.reason)
  return llm
}

describe("fork-experiment full scenario — env → registry → runAgent loop", () => {
  test("A. INJECT arm from env injects the text at the configured turn and nowhere else", async () => {
    const inject = mutatorFor(
      {
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "2",
        QUANTA_FORK_INJECT_TEXT: SENTINEL,
      },
      "inject",
    )
    expect(inject).toBeDefined()

    const llm = await runWith(inject, "scenario-A")
    const turns = turnCalls(llm)
    expect(turns.length).toBeGreaterThanOrEqual(2)
    // turn 1 clean, turn 2 carries the injected hint — observed in the SENT prompt.
    expect(containsSentinel(turns[0] as Message[])).toBe(false)
    expect(containsSentinel(turns[turns.length - 1] as Message[])).toBe(true)
  })

  test("B. BASELINE arm from env changes nothing — sentinel never appears", async () => {
    // baseline ignores inject params; wire it and confirm it is a true control.
    const baseline = mutatorFor(
      {
        QUANTA_FORK_EXPERIMENT: "baseline",
        QUANTA_FORK_INJECT_TURN: "2",
        QUANTA_FORK_INJECT_TEXT: SENTINEL,
      },
      "baseline",
    )
    expect(baseline).toBeDefined()

    const llm = await runWith(baseline, "scenario-B")
    for (const m of llm.seenMessages) expect(JSON.stringify(m)).not.toContain(SENTINEL)
  })

  test("C. ONE env yields TWO distinct arms (baseline,inject); baseline stays clean, inject injects", async () => {
    // The exact fan-out input an operator gives: compare two arms side by side.
    const env = {
      QUANTA_FORK_EXPERIMENT: "baseline,inject",
      QUANTA_FORK_INJECT_TURN: "2",
      QUANTA_FORK_INJECT_TEXT: SENTINEL,
    }
    const arms = resolveForkExperiments(env)
    expect(arms.map((a) => a.name)).toEqual(["baseline", "inject"])
    // Distinct mutators — not the same function reused.
    expect(arms[0]?.mutator).not.toBe(arms[1]?.mutator)

    const baselineLlm = await runWith(arms[0]?.mutator, "scenario-C-baseline")
    const injectLlm = await runWith(arms[1]?.mutator, "scenario-C-inject")

    // baseline branch: clean everywhere. inject branch: turn 2 carries the hint.
    for (const m of baselineLlm.seenMessages) expect(JSON.stringify(m)).not.toContain(SENTINEL)
    const injTurns = turnCalls(injectLlm)
    expect(containsSentinel(injTurns[injTurns.length - 1] as Message[])).toBe(true)
    // DIVERGENCE proof: the two branches' turn-2 prompts genuinely differ.
    const baseTurns = turnCalls(baselineLlm)
    expect(JSON.stringify(injTurns.at(-1))).not.toBe(JSON.stringify(baseTurns.at(-1)))
  })

  test("D. DEFAULT-OFF: no env ⇒ resolveForkExperiments [] ⇒ no mutator ⇒ byte-identical turn 1", async () => {
    expect(resolveForkExperiments({})).toEqual([])

    // A run with the resolved (absent) mutator vs a plain run: turn 1 identical,
    // and the sentinel appears nowhere (the feature is fully inert when unset).
    const offLlm = await runWith(undefined, "scenario-D-off")
    const plainLlm = await runWith(undefined, "scenario-D-plain")
    for (const m of offLlm.seenMessages) expect(JSON.stringify(m)).not.toContain(SENTINEL)
    expect(JSON.stringify(turnCalls(offLlm)[0])).toBe(JSON.stringify(turnCalls(plainLlm)[0]))
  })
})
