/**
 * 2-AXIS parity guard (jul-4): env posture and task pack are now INDEPENDENT slots that
 * `buildSystemPrompt` composes as `renderPostureBase(posture) + renderTaskRules(pack)`. This pins
 * that every LEGACY single-axis combination is byte-identical to the prior `*_PACK` constant — so
 * the XOR→2-axis refactor cannot silently shift a rendered prompt. RED-on-injection: reorder the
 * slots or drop a rule and a case below fails.
 */
import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../prompt"
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
  renderVerifyStrategy,
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

// The cases above pin the RENDER helpers. This one pins the COMPOSER (buildSystemPrompt) itself —
// the slot ORDER lives in prompt.ts (posture → task → verify), NOT in these helpers, so a swap
// there would slip past every helper-level assertion. Assert the three axes appear in that order in
// the actually-rendered prompt. RED-on-injection: reorder the spreads in prompt.ts and this fails.
describe("3-axis COMPOSER order — posture BEFORE task BEFORE verify in the real rendered prompt", () => {
  test("buildSystemPrompt(owned + batch + reproduce-first) emits the axes in slot order", () => {
    const prompt = buildSystemPrompt("/w", {
      envPosture: "owned",
      promptPack: "batch",
      verifyStrategy: "reproduce-first",
    })
    // Each axis's rendered lines are spliced contiguously, so the joined block is a
    // substring of the prompt — its position marks where that slot landed.
    const iPosture = prompt.indexOf(renderPostureBase("owned").join("\n"))
    const iTask = prompt.indexOf(renderTaskRules("batch").join("\n"))
    const iVerify = prompt.indexOf(renderVerifyStrategy("reproduce-first").join("\n"))
    expect(iPosture).toBeGreaterThanOrEqual(0)
    expect(iTask).toBeGreaterThanOrEqual(0)
    expect(iVerify).toBeGreaterThanOrEqual(0)
    expect(iPosture).toBeLessThan(iTask) // posture slot precedes task slot
    expect(iTask).toBeLessThan(iVerify) // task slot precedes verify slot
  })

  // jul-9 audit (Finding 4): the helper-order test above pins the THREE axes relative to each
  // OTHER, but not the axis block relative to the surrounding BODY. The authority ladder is
  // load-bearing (core.ts: "R-ENV/R-STOP-ENV are the most load-bearing — keep them first";
  // the policy stack declares L1–L9 override authority), so the body↔axis boundary order is a
  // security invariant. Pin it: policy-stack body precedes the axis block; the after-pack body
  // (vision/honesty/reporting rails) follows it. RED-on-injection: move the posture spread above
  // BODY_AFTER_PERSONA in prompt.ts and this fails.
  test("body↔axis boundary: policy-stack precedes the axes; after-pack body follows them", () => {
    const prompt = buildSystemPrompt("/w", {
      envPosture: "owned",
      promptPack: "batch",
      verifyStrategy: "reproduce-first",
    })
    const iPolicyStack = prompt.indexOf("Policy stack (highest to lowest priority")
    const iPosture = prompt.indexOf(renderPostureBase("owned").join("\n"))
    const iVerify = prompt.indexOf(renderVerifyStrategy("reproduce-first").join("\n"))
    const iAfterPack = prompt.indexOf("Vision priority: when the user attaches")
    expect(iPolicyStack).toBeGreaterThanOrEqual(0)
    expect(iAfterPack).toBeGreaterThanOrEqual(0)
    expect(iPolicyStack).toBeLessThan(iPosture) // authority ladder ABOVE the axes
    expect(iVerify).toBeLessThan(iAfterPack) // after-pack rails BELOW the axes
  })
})
