/**
 * HELLGATE — the ci-bot heartbeat does not call a failure "completed"
 * (aug-23 §13 / audit follow-up, misreport site #4)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13 named three
 * success-misreport sites; the adversarial audit found a FOURTH.
 * `src/apps/agent/mode-presets/ci-bot.ts` builds its fallback PR comment as
 * `quanta ci-bot: completed (turns=N, reason=X)` at three call sites — the word
 * "completed" is hardcoded regardless of `reason`, so a run that hit the turn
 * limit, was refused, or died on a provider error posts "completed" to the pull
 * request. A reviewer skimming the comment reads success.
 *
 * Invariants:
 *
 *  H1  A non-success reason does NOT produce the word "completed" as the verb.
 *  H2  PAIRED CONTROL — a genuine completion still says completed, so the fix
 *      is not "always say failed".
 *  H3  THE REASON SURVIVES — the machine-readable `reason=` is still present;
 *      this changes the human verb, not the payload.
 *  H4  TURNS SURVIVE — the existing `turns=` field is untouched.
 *  H5  UNKNOWN sentinel (slice 1c) does not read as a completion.
 */

import { describe, expect, test } from "bun:test"
import { ciBotHeartbeatLine } from "@/apps/agent/mode-presets/ci-bot"

describe("H1 — a non-success reason is not called completed", () => {
  test.each([
    ["error"],
    ["refusal"],
    ["max_turns"],
    ["budget_exhausted"],
    ["awaiting_approval"],
  ])("%s does not claim completion", (reason) => {
    const line = ciBotHeartbeatLine({ turns: 4, reason })
    expect(line).not.toContain("ci-bot: completed")
  })
})

describe("H2 — paired control", () => {
  test("a genuine completion still says completed", () => {
    expect(ciBotHeartbeatLine({ turns: 4, reason: "completed" })).toContain("ci-bot: completed")
  })
})

describe("H3/H4 — the payload is preserved", () => {
  test("reason and turns are still reported", () => {
    const line = ciBotHeartbeatLine({ turns: 7, reason: "max_turns" })
    expect(line).toContain("reason=max_turns")
    expect(line).toContain("turns=7")
  })
})

describe("H5 — the unknown sentinel is not a completion", () => {
  test("unknown does not claim completion", () => {
    expect(ciBotHeartbeatLine({ turns: 1, reason: "unknown" })).not.toContain("ci-bot: completed")
  })
})
