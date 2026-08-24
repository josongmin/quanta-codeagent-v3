/**
 * Characterization tests for the plan-exit prompt STATE MACHINE — added with
 * the god-function split of `createCliPlanExitPort.request` (44 → under cap).
 *
 * Injection-verified gaps in the existing `session-host-ports` suite: giving
 * the feedback loop its OWN budget, making `/back` terminal, an off-by-one on
 * the budget threshold, making blank feedback free, and dropping the outer
 * `/cancel` guard ALL left that suite GREEN. These pin the rules instead:
 *
 *   R1  The unusable budget is SHARED by the choice loop and the feedback
 *       loop — 5 unusable answers TOTAL, however they are distributed.
 *   R2  The budget threshold is exactly 5: the 5th unusable answer rejects,
 *       the 4th does not.
 *   R3  `/back` returns to the choice prompt and costs NOTHING.
 *   R4  `/cancel` fail-closes to REJECTED at BOTH prompts.
 *   R5  Blank feedback spends budget; non-blank feedback is carried verbatim.
 */
import { describe, expect, test } from "bun:test"
import { createCliPlanExitPort } from "@/apps/cli/repl/session-host-ports"

/** Replays `answers`, then repeats `tail` forever. Hard-capped so an unbounded
 *  loop surfaces as a thrown OVERRUN rather than hanging the test runner. */
const ask = (answers: readonly string[], tail?: string) => {
  const prompts: string[] = []
  let i = 0
  return {
    prompts,
    /** Prompts that offered the FEEDBACK form (vs the choice form). */
    get feedbackPrompts() {
      return prompts.filter((p) => p.includes("Requested changes selected."))
    },
    get choicePrompts() {
      return prompts.filter((p) => p.includes("Approve [a], reject [r]"))
    },
    fn: async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      if (prompts.length > 200) throw new Error("OVERRUN: prompt loop is unbounded")
      const a = answers[i]
      i += 1
      if (a !== undefined) return a
      if (tail !== undefined) return tail
      throw new Error("SCRIPT-EXHAUSTED (loop asked more than the case scripted)")
    },
  }
}

const run = (answers: readonly string[], tail?: string) => {
  const io = ask(answers, tail)
  return { io, outcome: createCliPlanExitPort({ ask: io.fn }).request("PLAN") }
}

describe("plan-exit prompt — shared unusable budget", () => {
  test("R1: 2 bad choices + 3 blank feedbacks exhausts the SINGLE shared budget", async () => {
    const { io, outcome } = run(["zz", "yy", "c", "", "", "", "THIS SHOULD NEVER BE READ"])
    expect(await outcome).toEqual({ decision: "rejected" })
    // 2 (choice) + 3 (feedback) = 5 -> rejected on the 5th, so the 7th
    // scripted answer is never consumed.
    expect(io.prompts).toHaveLength(6)
    expect(io.choicePrompts).toHaveLength(3)
    expect(io.feedbackPrompts).toHaveLength(3)
  })

  test("R1: 4 bad choices then 1 blank feedback also exhausts it", async () => {
    const { io, outcome } = run(["a1", "b1", "c1", "d1", "c", "", "unreachable"])
    expect(await outcome).toEqual({ decision: "rejected" })
    expect(io.feedbackPrompts).toHaveLength(1)
  })

  test("R2: the 4th unusable answer does NOT reject — a valid 5th still lands", async () => {
    const { io, outcome } = run(["z1", "z2", "z3", "z4", "a"])
    expect(await outcome).toEqual({ decision: "approved" })
    expect(io.prompts).toHaveLength(5)
  })

  test("R2: the 5th unusable answer rejects (paired control for the case above)", async () => {
    const { io, outcome } = run(["z1", "z2", "z3", "z4", "z5", "a"])
    expect(await outcome).toEqual({ decision: "rejected" })
    // The valid "a" is never reached — the budget ran out first.
    expect(io.prompts).toHaveLength(5)
  })

  test("R2: a dead source feeding endless blanks terminates at exactly 5 prompts", async () => {
    const { io, outcome } = run([], "")
    expect(await outcome).toEqual({ decision: "rejected" })
    expect(io.prompts).toHaveLength(5)
  })
})

describe("plan-exit prompt — /back is free and non-terminal", () => {
  test("R3: /back returns to the choice prompt and spends NO budget", async () => {
    // 5 round-trips through /back — more than the whole budget — then approve.
    const script = ["c", "/back", "c", "/back", "c", "/back", "c", "/back", "c", "/back", "a"]
    const { io, outcome } = run(script)
    expect(await outcome).toEqual({ decision: "approved" })
    expect(io.feedbackPrompts).toHaveLength(5)
    expect(io.choicePrompts).toHaveLength(6)
  })

  test("R3: /back is matched case-insensitively and after trimming", async () => {
    const { io, outcome } = run(["c", "  /BACK  ", "r"])
    expect(await outcome).toEqual({ decision: "rejected" })
    // Re-asked the CHOICE prompt after /back (not the feedback prompt).
    expect(io.prompts[2]).toContain("Approve [a], reject [r]")
  })
})

describe("plan-exit prompt — cancellation and feedback capture", () => {
  test("R4: /cancel at the choice prompt fail-closes to REJECTED immediately", async () => {
    const { io, outcome } = run(["/cancel", "a"])
    expect(await outcome).toEqual({ decision: "rejected" })
    expect(io.prompts).toHaveLength(1)
  })

  test("R4: /cancel at the feedback prompt fail-closes to REJECTED too", async () => {
    const { io, outcome } = run(["c", "/cancel", "a"])
    expect(await outcome).toEqual({ decision: "rejected" })
    expect(io.prompts).toHaveLength(2)
  })

  test("R4: /cancel is matched case-insensitively and after trimming", async () => {
    const { outcome } = run(["  /CANCEL "])
    expect(await outcome).toEqual({ decision: "rejected" })
  })

  test("R5: blank feedback re-asks, then non-blank feedback is carried VERBATIM", async () => {
    const { io, outcome } = run(["c", "", "  \t ", "  keep   my   spacing  "])
    // Verbatim: no trim, no collapse — only the blank TEST is trimmed.
    expect(await outcome).toEqual({
      decision: "changes_requested",
      feedback: "  keep   my   spacing  ",
    })
    expect(io.feedbackPrompts).toHaveLength(3)
  })

  test("R5: each of the three changes_requested aliases reaches the feedback prompt", async () => {
    for (const alias of ["c", "change", "changes", "changes_requested"]) {
      const { outcome } = run([alias, "fb"])
      expect(await outcome).toEqual({ decision: "changes_requested", feedback: "fb" })
    }
  })
})
