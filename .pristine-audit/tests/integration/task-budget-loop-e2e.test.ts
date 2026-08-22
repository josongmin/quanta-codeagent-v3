/**
 * jun-02b — Soft task-budget multi-turn loop e2e (DETERMINISTIC).
 *
 * Drives `runAgent` with a `FakeLLM` that emits a FIXED `usage` event every
 * turn, then continues via a read-only tool, finally ending with a text turn.
 * The loop's `emitUsage` accumulates the observed tokens into the per-session
 * `taskSpend` box and `prepareTurnContext` forwards `{ tokens, spent }` into
 * `buildTurnContext`, so each turn's trailing `<system-reminder>` shows a
 * STRICTLY DECREASING remaining.
 *
 * Two invariants, both validated with NO arbitrary thresholds:
 *   1. `config.taskBudget` set ⇒ per-turn `<system-reminder>` shows a
 *      strictly-decreasing "~N tokens ... remain" AND the loop terminates
 *      normally (the soft budget NEVER stops it — even when it goes over).
 *   2. `config.taskBudget` ABSENT ⇒ the assembled dynamic context is
 *      BYTE-IDENTICAL to the same run with no budget (snapshot equality of the
 *      per-turn reminder tails), and carries no "Soft budget" text.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig, TaskBudget } from "@/agent"
import { runAgent } from "@/agent"
import type { Message, StreamEvent } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { baseConfig, FakeLLM, RecordingStream, text, toolUse } from "./_harness"

/** Fixed per-turn usage — deterministic spend accumulation. */
const usage = (inTok: number, outTok: number): StreamEvent => ({
  type: "usage",
  inputTokens: inTok,
  outputTokens: outTok,
  model: "scripted-test-model",
})

/** Pull the trailing `<system-reminder>` text of one assembled turn. */
const reminderOf = (messages: readonly Message[]): string => {
  const last = messages[messages.length - 1]
  const block = last?.content[0]
  return block?.type === "text" ? block.text : ""
}

/** Extract the rendered remaining ("~N tokens ... remain"), or undefined when
 *  the soft-budget line is absent. */
const remainingOf = (reminder: string): number | undefined => {
  const m = reminder.match(/~(\d+) tokens of your \d+-token task budget remain/)
  return m === null ? undefined : Number(m[1])
}

/** A FakeLLM scripting `turns-1` continue-turns (usage + read) followed by one
 *  terminal text turn (usage + end_turn). Each turn spends `in+out` tokens. */
const scriptedLLM = (turns: number, readPath: string, inTok: number, outTok: number): FakeLLM => {
  const scripts: StreamEvent[][] = []
  for (let i = 0; i < turns - 1; i++) {
    scripts.push([usage(inTok, outTok), ...toolUse(`r${i}`, "read", { path: readPath })])
  }
  scripts.push([usage(inTok, outTok), ...text("done")])
  return new FakeLLM(scripts)
}

const mkConfig = (
  llm: FakeLLM,
  stream: RecordingStream,
  dir: string,
  over: Partial<AgentConfig>,
): AgentConfig =>
  baseConfig({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream,
    permission: { mode: "acceptEdits" } as AgentConfig["permission"],
    cwd: dir,
    system: "test",
    maxTurns: 10,
    ...over,
  })

describe("soft task-budget — multi-turn loop e2e", () => {
  test("knob set ⇒ strictly-decreasing remaining across turns, loop NEVER terminated by soft budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-budget-e2e-"))
    try {
      const readPath = join(dir, "f.txt")
      writeFileSync(readPath, "hello\nworld\n")
      const TURNS = 4
      const IN = 4000
      const OUT = 1000 // 5000 tokens / turn
      const TOTAL = 12000 // intentionally smaller than 4*5000=20000 ⇒ goes OVER
      const llm = scriptedLLM(TURNS, readPath, IN, OUT)
      const stream = new RecordingStream()
      const budget: TaskBudget = { tokens: TOTAL }
      const outcome = await runAgent(mkConfig(llm, stream, dir, { taskBudget: budget }))

      // The loop ran all scripted turns and ended on the terminal text turn —
      // NOT cut short by the soft budget (it went over and still completed).
      expect(llm.calls).toBe(TURNS)
      // The soft budget NEVER aborts / exhausts the run — it completed normally.
      expect(outcome.reason).toBe("completed")

      // Each turn's reminder carries a remaining; collect them in turn order.
      // `spent` is accumulated from the PRIOR turns' usage, so turn 0 shows the
      // full budget and each later turn shows strictly less.
      const remainings = llm.seenMessages.map((m) => remainingOf(reminderOf(m)))
      // Every turn rendered the soft-budget line.
      expect(remainings.every((r) => r !== undefined)).toBe(true)
      const nums = remainings as number[]
      // Turn 0: nothing spent yet ⇒ full budget visible.
      expect(nums[0]).toBe(TOTAL)
      // Strictly decreasing while above zero, then clamped at 0 once over.
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i]).toBeLessThanOrEqual(nums[i - 1] as number)
      }
      // By the last turn the cumulative spend (3 prior turns * 5000 = 15000)
      // exceeds the 12000 budget ⇒ remaining clamps to exactly 0, and the
      // phrasing escalates to "wrap up" — but the run STILL completed.
      expect(nums[nums.length - 1]).toBe(0)
      const lastReminder = reminderOf(llm.seenMessages[llm.seenMessages.length - 1] as Message[])
      expect(lastReminder).toContain("wrap up")
      expect(lastReminder).toContain("guidance, not a hard limit")
      // Belt-and-braces: the strictly-decreasing prefix (before clamp) is real.
      // Turns 0..2 are 12000, 7000, 2000 (each minus 5000).
      expect(nums.slice(0, 3)).toEqual([12000, 7000, 2000])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("knob ABSENT ⇒ per-turn dynamic context byte-identical, no 'Soft budget' leak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-budget-e2e-off-"))
    try {
      const readPath = join(dir, "f.txt")
      writeFileSync(readPath, "hello\nworld\n")
      const TURNS = 4
      // Two identical runs, neither with a budget ⇒ the per-turn reminder tails
      // must be snapshot-equal (default-OFF byte-identical), and carry no
      // soft-budget text.
      const runOnce = async (): Promise<string[]> => {
        const llm = scriptedLLM(TURNS, readPath, 4000, 1000)
        await runAgent(mkConfig(llm, new RecordingStream(), dir, {}))
        return llm.seenMessages.map((m) => reminderOf(m))
      }
      const a = await runOnce()
      const b = await runOnce()
      expect(a).toEqual(b)
      for (const reminder of a) {
        expect(reminder).not.toContain("Soft budget")
        expect(reminder).not.toContain("task budget")
        expect(remainingOf(reminder)).toBeUndefined()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
