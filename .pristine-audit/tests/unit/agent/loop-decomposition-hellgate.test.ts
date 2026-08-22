/**
 * Structural hellgate — `loop.ts` must remain a thin facade.
 *
 * Prevents re-inlining the extracted loop modules back into the monolith.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../..")
const loopSrc = readFileSync(join(ROOT, "src/agent/loop.ts"), "utf8")
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")

describe("loop decomposition hellgate", () => {
  test("facade stays thin and public surface is preserved", () => {
    expect(loopSrc).toContain('from "./recovery"')
    expect(loopSrc).toContain('from "./turn-context"')
    expect(loopSrc).toContain('from "./loop/entry"')
    expect(loopSrc.split(/\r?\n/).length).toBeLessThanOrEqual(20)
    expect(loopSrc).not.toMatch(/const runAgent\s*=/)
  })

  test("phase-1 modules remain extracted", () => {
    expect(read("src/agent/loop/turn-gate.ts")).toContain("export const classifyTurnAbort")
    expect(read("src/agent/loop/turn-outcome.ts")).toContain("export const resolveTurnLoopOutcome")
    const typesSrc = read("src/agent/loop/types.ts")
    expect(typesSrc).toContain("export type TurnResult")
    expect(typesSrc).toContain("export type TurnLoopResolution")
  })

  test("phase-2 modules remain extracted", () => {
    expect(read("src/agent/loop/emit-helpers.ts")).toContain("export const emitUsage")
    expect(read("src/agent/loop/skill-gate.ts")).toContain("export const buildSkillGate")
    expect(read("src/agent/loop/stream-consume.ts")).toContain("export const streamConsume")
    expect(read("src/agent/loop/compaction-wire.ts")).toContain("export const maybeCompact")
    expect(read("src/agent/loop/closeout-critic-wire.ts")).toContain(
      "export const maybeRunCloseoutCritic",
    )
    expect(read("src/agent/loop/context-assembler.ts")).toContain("export const prepareTurnContext")
    expect(read("src/agent/loop/recovery-executor.ts")).toContain(
      "export const applyNonSuccessRecoveryAction",
    )
    expect(read("src/agent/recovery.ts")).toContain("export const buildRefusalFallbackInput")
    expect(read("src/agent/recovery.ts")).toContain("export const resolveTurnAction")
    expect(read("src/agent/loop/recovery-executor.ts")).not.toContain(
      "export const resolveTurnAction",
    )
    expect(read("src/agent/loop/same-turn-engine.ts")).toContain("export const runTurn")
    expect(read("src/agent/loop/session-hooks.ts")).toContain(
      "export const emitUserPromptSubmitHook",
    )
    expect(read("src/agent/loop/session-snapshots.ts")).toContain(
      "export const restoreFollowUpQueueSnapshot",
    )
    expect(read("src/agent/loop/session-lifecycle.ts")).toContain("export const finishAgentSession")
    expect(read("src/agent/loop/control-poll.ts")).toContain("export const pollFollowUpQueue")
    expect(read("src/agent/loop/turn-iteration.ts")).toContain("export const prepareTurnIteration")
    expect(read("src/agent/loop/session-bootstrap.ts")).toContain(
      "export const createRunAgentContext",
    )
    expect(read("src/agent/loop/turn-loop.ts")).toContain("export const runAgentTurnLoop")
    expect(read("src/agent/loop/entry.ts")).toContain("export const runAgent")
  })

  test("monolith bodies do not reappear in loop.ts", () => {
    for (const pattern of [
      /const emitUsage\s*=/,
      /const buildSkillGate\s*=/,
      /async function teeUsage\b/,
      /const streamConsume\s*=/,
      /const maybeCompact\s*=/,
      /const prepareTurnContext\s*=/,
      /const applyNonSuccessRecoveryAction\s*=/,
      /const runTurn\s*=/,
      /const emitUserPromptSubmitHook\s*=/,
      /const persistFinalMessages\s*=/,
      /const pollFollowUpQueue\s*=/,
      /const prepareTurnIteration\s*=/,
      /const createRunAgentContext\s*=/,
      /const executeTurnWithObservability\s*=/,
      /const runAgentInnerWithEgressProxy\s*=/,
      /const runAgentInner\s*=/,
    ]) {
      expect(loopSrc).not.toMatch(pattern)
    }
  })
})
