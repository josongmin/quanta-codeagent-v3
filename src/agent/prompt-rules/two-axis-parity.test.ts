/**
 * 2-AXIS parity guard (jul-4): env posture and task pack are now INDEPENDENT slots that
 * `buildSystemPrompt` composes as `renderPostureBase(posture) + renderTaskRules(pack)`. This pins
 * that every LEGACY single-axis combination is byte-identical to the prior `*_PACK` constant — so
 * the XOR→2-axis refactor cannot silently shift a rendered prompt. RED-on-injection: reorder the
 * slots or drop a rule and a case below fails.
 */
import { describe, expect, test } from "bun:test"
import {
  ASSISTANT_PACK,
  BENCHMARK_PACK,
  CORE_RULES,
  OWNED_RULES,
  PR_AGENT_PACK,
  renderOwnedRules,
  renderPackByMode,
  renderPostureBase,
  renderTaskRules,
  TASK_RUNNER_PACK,
} from "./index"

const lines = (rules: readonly { lines: readonly string[] }[]): string[] =>
  rules.flatMap((r) => r.lines)

describe("2-axis parity — frozen posture-base + task rules == legacy *_PACK (byte-identical)", () => {
  test("frozen + interactive == ASSISTANT_PACK (== CORE, no task rules)", () => {
    expect([...renderPostureBase("frozen"), ...renderTaskRules("interactive")]).toEqual(
      lines(ASSISTANT_PACK),
    )
    expect(renderTaskRules("interactive")).toEqual([]) // interactive has NO task rules
  })
  test("frozen + batch == BENCHMARK_PACK (CORE + batch task rule)", () => {
    expect([...renderPostureBase("frozen"), ...renderTaskRules("batch")]).toEqual(
      lines(BENCHMARK_PACK),
    )
  })
  test("frozen + headless == TASK_RUNNER_PACK", () => {
    expect([...renderPostureBase("frozen"), ...renderTaskRules("headless")]).toEqual(
      lines(TASK_RUNNER_PACK),
    )
  })
  test("frozen + ci-bot == PR_AGENT_PACK", () => {
    expect([...renderPostureBase("frozen"), ...renderTaskRules("ci-bot")]).toEqual(
      lines(PR_AGENT_PACK),
    )
  })
  test("owned posture-base == OWNED_RULES (== renderOwnedRules legacy entry)", () => {
    expect(renderPostureBase("owned")).toEqual(lines(OWNED_RULES))
    expect(renderPostureBase("owned")).toEqual(renderOwnedRules())
  })
  test("frozen posture-base == CORE_RULES", () => {
    expect(renderPostureBase("frozen")).toEqual(lines(CORE_RULES))
  })
  test("renderPackByMode legacy entry == frozen base + task (unchanged for mode-only callers)", () => {
    for (const m of ["interactive", "headless", "batch", "ci-bot", "ide", "daemon"] as const) {
      expect(renderPackByMode(m)).toEqual([...renderPostureBase("frozen"), ...renderTaskRules(m)])
    }
  })

  test("XOR removed: owned + a task pack now COMPOSES (was impossible before)", () => {
    // The new capability the refactor unlocks — an owned surface can carry a task pack. Byte
    // shape = owned base THEN the task rules (no legacy baseline; this combination never existed).
    const ownedBatch = [...renderPostureBase("owned"), ...renderTaskRules("batch")]
    expect(ownedBatch).toEqual([...lines(OWNED_RULES), ...renderTaskRules("batch")])
    expect(ownedBatch.length).toBeGreaterThan(renderPostureBase("owned").length) // task rules appended
  })
})
