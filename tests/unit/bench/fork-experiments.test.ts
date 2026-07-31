/**
 * Hellgate — fork-experiment named REGISTRY (trajectory fork troubleshooting).
 *
 * The registry turns `QUANTA_FORK_EXPERIMENT` into concrete `turnContextMutator`
 * arms over the agent loop's ONE pure per-turn seam. Teeth pin the contract
 * that makes the seam safe to A/B:
 *   - DEFAULT-OFF: unset / "" / "0" ⇒ no experiments (paired with the byte-
 *     identical loop posture — caller wires nothing).
 *   - UNKNOWN name THROWS (no silent baseline) — paired with a known name that
 *     does NOT throw, so the assertion has a control and isn't vacuous.
 *   - `baseline` is identity (the A/B control arm).
 *   - `inject` is RED-ON-INJECTION at the chosen turn and a turn-SCOPED no-op
 *     elsewhere (paired turn-2 / turn-4 controls prove it isn't blanket).
 *   - `inject` is PURE: it never mutates the caller's `baseMessages`.
 *   - `inject` SCREENS answer-key markers at construction time (loud throw).
 *
 * Every assertion is preceded by an unconditional sanity assert then narrowed,
 * and each positive case is paired with a negative control so a mutant that
 * "always injects" / "never injects" / "swallows unknown names" is caught.
 */
import { describe, expect, test } from "bun:test"
import type { TurnContextInput } from "../../../src/agent/prompt"
import {
  describeForkExperiments,
  FORK_EXPERIMENTS,
  type ForkExperiment,
  resolveForkExperiments,
} from "../../../src/apps/bench/eval/fork-experiments"
import { PacketBlindnessViolation } from "../../../src/runner/batch/eval/llm-evidence-packet"

/** Build a minimal real `TurnContextInput`. Only `baseMessages` is exercised by
 *  the mutators; the rest is cast to satisfy TS without dragging the full type. */
const fakeInput = (texts: readonly string[]): TurnContextInput =>
  ({
    baseMessages: texts.map((text) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text }],
    })),
    cwd: "/repo",
  }) as TurnContextInput

/** Concatenate every text block across all messages — lets a test assert that a
 *  specific injected string is (or is not) present in the turn the model sees. */
const allText = (input: TurnContextInput): string =>
  input.baseMessages
    .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
    .join("\n")

const only = (experiments: ForkExperiment[]): ForkExperiment => {
  expect(experiments.length).toBe(1)
  const exp = experiments[0]
  if (exp === undefined) throw new Error("unreachable: length checked")
  return exp
}

describe("resolveForkExperiments — DEFAULT-OFF", () => {
  test("unset env ⇒ [] (no mutator wired)", () => {
    const result = resolveForkExperiments({})
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  test('"" and "0" are also OFF', () => {
    expect(resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "" })).toEqual([])
    expect(resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "   " })).toEqual([])
    expect(resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "0" })).toEqual([])
  })
})

describe("resolveForkExperiments — name resolution", () => {
  test("UNKNOWN name throws and names the bad input (paired with a known name that does NOT throw)", () => {
    // Control: a registered name resolves without throwing.
    let known: ForkExperiment[] | undefined
    expect(() => {
      known = resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "baseline" })
    }).not.toThrow()
    expect(known?.length).toBe(1)
    expect(known?.[0]?.name).toBe("baseline")

    // Treatment: an unregistered name throws, and the message names it.
    expect(() => resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "totally-bogus" })).toThrow(
      /totally-bogus/,
    )
    // The throw must NOT silently degrade to baseline.
    expect(() => resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "totally-bogus" })).toThrow()
  })

  test('comma list "baseline,inject" ⇒ two experiments in order', () => {
    const result = resolveForkExperiments({
      QUANTA_FORK_EXPERIMENT: "baseline,inject",
      QUANTA_FORK_INJECT_TURN: "1",
      QUANTA_FORK_INJECT_TEXT: "hello",
    })
    expect(result.length).toBe(2)
    expect(result.map((e) => e.name)).toEqual(["baseline", "inject"])
    expect(typeof result[0]?.mutator).toBe("function")
    expect(typeof result[1]?.mutator).toBe("function")
  })

  test("whitespace and empty segments are trimmed/dropped, order preserved", () => {
    const result = resolveForkExperiments({
      QUANTA_FORK_EXPERIMENT: " baseline , , inject ",
      QUANTA_FORK_INJECT_TURN: "5",
      QUANTA_FORK_INJECT_TEXT: "x",
    })
    expect(result.map((e) => e.name)).toEqual(["baseline", "inject"])
  })

  test("registry exposes exactly the seed experiments (no baked-in heuristics)", () => {
    expect(Object.keys(FORK_EXPERIMENTS).sort()).toEqual(["baseline", "inject"])
  })
})

describe("baseline mutator — identity (A/B control arm)", () => {
  test("returns the SAME input reference for several turn values", () => {
    const exp = only(resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "baseline" }))
    expect(exp.name).toBe("baseline")
    const input = fakeInput(["seed user message"])
    for (const turn of [1, 2, 3, 7, 42]) {
      const out = exp.mutator(turn, input)
      // Strongest possible identity assertion: same reference, no copy.
      expect(out).toBe(input)
    }
    // Control: length is unchanged (no append snuck in).
    expect(input.baseMessages.length).toBe(1)
  })
})

describe("inject mutator — RED-ON-INJECTION, turn-scoped", () => {
  const resolveInject = (turn: string, text: string): ForkExperiment =>
    only(
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: turn,
        QUANTA_FORK_INJECT_TEXT: text,
      }),
    )

  test("at the target turn appends +1 message containing the text; off-turns unchanged (paired control)", () => {
    const TEXT = "consider the cache layer"
    const exp = resolveInject("3", TEXT)
    const input = fakeInput(["base-0", "base-1"])

    // Treatment: turn 3 injects.
    const atTarget = exp.mutator(3, input)
    expect(atTarget.baseMessages.length).toBe(input.baseMessages.length + 1)
    expect(allText(atTarget)).toContain(TEXT)
    // The injected message is a trailing user-role text message.
    const last = atTarget.baseMessages[atTarget.baseMessages.length - 1]
    expect(last?.role).toBe("user")
    expect(last?.content?.[0]).toEqual({ type: "text", text: TEXT })

    // Paired controls: turn 2 and turn 4 are untouched (turn-SCOPED, not blanket).
    for (const offTurn of [2, 4]) {
      const off = exp.mutator(offTurn, input)
      expect(off.baseMessages.length).toBe(input.baseMessages.length)
      expect(allText(off)).not.toContain(TEXT)
    }
  })

  test("PURITY: calling the mutator does not mutate the original input.baseMessages", () => {
    const exp = resolveInject("2", "injected")
    const input = fakeInput(["a", "b"])
    const originalLen = input.baseMessages.length
    const originalArrayRef = input.baseMessages

    const out = exp.mutator(2, input)
    // Original array is untouched: same length, same reference, fresh result array.
    expect(input.baseMessages.length).toBe(originalLen)
    expect(input.baseMessages).toBe(originalArrayRef)
    expect(out.baseMessages).not.toBe(input.baseMessages)
    expect(out.baseMessages.length).toBe(originalLen + 1)
  })

  test("AI-OPERABILITY: a missing/invalid required param FAILS LOUD with guidance (not a silent no-op)", () => {
    // Control: fully-configured inject resolves fine.
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "1",
        QUANTA_FORK_INJECT_TEXT: "ok",
      }),
    ).not.toThrow()

    // Missing TEXT ⇒ throws naming the env var (an agent driver sees what to fix).
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "3",
        // QUANTA_FORK_INJECT_TEXT absent
      }),
    ).toThrow(/QUANTA_FORK_INJECT_TEXT/)

    // Missing TURN ⇒ throws naming the env var.
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TEXT: "hint",
        // QUANTA_FORK_INJECT_TURN absent
      }),
    ).toThrow(/QUANTA_FORK_INJECT_TURN/)

    // Non-positive / non-1-based TURN ⇒ throws (turn 1 is the first turn).
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "0",
        QUANTA_FORK_INJECT_TEXT: "hint",
      }),
    ).toThrow(/QUANTA_FORK_INJECT_TURN/)
  })
})

describe("describeForkExperiments — self-describing catalog (for an LLM driver)", () => {
  test("lists every registered experiment, its env params, and required-ness", () => {
    const catalog = describeForkExperiments()
    // Names the env switch so an agent knows the entrypoint.
    expect(catalog).toContain("QUANTA_FORK_EXPERIMENT")
    // Every registered experiment appears (no silent omission).
    for (const name of Object.keys(FORK_EXPERIMENTS)) {
      expect(catalog).toContain(name)
    }
    // inject's params are documented with their required flag, so the agent can
    // configure it without reading source.
    expect(catalog).toContain("QUANTA_FORK_INJECT_TURN")
    expect(catalog).toContain("QUANTA_FORK_INJECT_TEXT")
    expect(catalog).toContain("required")
  })

  test("the unknown-name error embeds the catalog (discoverability on misuse)", () => {
    // An agent that typos a name gets the full catalog back in the error — the
    // tool teaches itself rather than failing opaquely.
    try {
      resolveForkExperiments({ QUANTA_FORK_EXPERIMENT: "nope" })
      throw new Error("expected throw")
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain("nope")
      expect(msg).toContain("QUANTA_FORK_EXPERIMENT")
      expect(msg).toContain("inject") // catalog body is present
    }
  })
})

describe("inject mutator — ANSWER-KEY GUARD", () => {
  test("text containing FAIL_TO_PASS ⇒ resolve THROWS (blindness violation)", () => {
    // Control: a clean text resolves fine.
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "1",
        QUANTA_FORK_INJECT_TEXT: "a benign hint",
      }),
    ).not.toThrow()

    // Treatment: a dataset marker is rejected LOUDLY at factory construction.
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "1",
        QUANTA_FORK_INJECT_TEXT: "pass test FAIL_TO_PASS now",
      }),
    ).toThrow(PacketBlindnessViolation)

    // PASS_TO_PASS is likewise screened.
    expect(() =>
      resolveForkExperiments({
        QUANTA_FORK_EXPERIMENT: "inject",
        QUANTA_FORK_INJECT_TURN: "1",
        QUANTA_FORK_INJECT_TEXT: "leak PASS_TO_PASS here",
      }),
    ).toThrow(PacketBlindnessViolation)
  })
})
