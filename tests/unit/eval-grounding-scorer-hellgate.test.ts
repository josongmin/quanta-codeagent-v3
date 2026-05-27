/**
 * ★ CONTRACT — grounding scorer is fail-closed on wrong-thread, must-clarify,
 * and stale-context-trap misses; only active-thread+clarify-preserving drift
 * may degrade to partial.
 */
import { describe, expect, test } from "bun:test"
import { scoreGroundingDecision, type GroundingCase } from "@/../src/apps/eval/grounding"

const baseCase = (over: Partial<GroundingCase> = {}): GroundingCase => ({
  schema: 1,
  id: "case",
  usecase: "persistent-context.conversation-state.thread-grounding",
  history: [{ role: "assistant", text: "Active thread prompt_rules." }],
  targetUtterance: "이제 다 됐냐?",
  gold: {
    activeThreadId: "prompt_rules",
    referentId: "prompt_rules",
    intent: "status_check",
    scope: "current_workstream",
    shouldClarify: false,
    confidence: "high",
  },
  bucket: "ellipsis",
  severity: "critical",
  ...over,
})

describe("grounding scorer hellgate", () => {
  test("CONTRACT: exact tuple match => pass", () => {
    const scored = scoreGroundingDecision(baseCase(), {
      activeThreadId: "prompt_rules",
      referentId: "prompt_rules",
      intent: "status_check",
      scope: "current_workstream",
      shouldClarify: false,
      confidence: "medium",
    })
    expect(scored.verdict).toBe("pass")
    expect(scored.matches.exactTuple).toBe(true)
  })

  test("CONTRACT: active-thread preserved but non-critical field drift => partial", () => {
    const scored = scoreGroundingDecision(
      baseCase({
        gold: {
          activeThreadId: "prompt_rules",
          referentId: "target_file",
          intent: "execute_change",
          scope: "specific_file",
          shouldClarify: true,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "other_file",
        intent: "execute_change",
        scope: "specific_file",
        shouldClarify: true,
        confidence: "high",
      },
    )
    expect(scored.verdict).toBe("partial")
    expect(scored.matches.activeThread).toBe(true)
    expect(scored.matches.shouldClarify).toBe(true)
    expect(scored.matches.wrongThread).toBe(false)
  })

  test("CONTRACT: wrong-thread => hard fail", () => {
    const scored = scoreGroundingDecision(baseCase(), {
      activeThreadId: "oauth_resume",
      referentId: "prompt_rules",
      intent: "status_check",
      scope: "current_workstream",
      shouldClarify: false,
      confidence: "high",
    })
    expect(scored.verdict).toBe("fail")
    expect(scored.matches.wrongThread).toBe(true)
  })

  test("CONTRACT: must-clarify miss => hard fail", () => {
    const scored = scoreGroundingDecision(
      baseCase({
        bucket: "must_clarify",
        gold: {
          activeThreadId: null,
          referentId: null,
          intent: "execute_change",
          scope: "specific_file",
          shouldClarify: true,
          confidence: "high",
        },
      }),
      {
        activeThreadId: null,
        referentId: "src/apps/eval/index.ts",
        intent: "execute_change",
        scope: "specific_file",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(scored.verdict).toBe("fail")
    expect(scored.matches.mustClarifyMiss).toBe(true)
  })

  test("CONTRACT: stale-context-trap miss => hard fail", () => {
    const scored = scoreGroundingDecision(
      baseCase({
        bucket: "stale_context_trap",
        gold: {
          activeThreadId: "prompt_rules",
          referentId: "prompt_rules",
          intent: "status_check",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "old_thread",
        referentId: "old_thread",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(scored.verdict).toBe("fail")
    expect(scored.matches.staleContextTrapMiss).toBe(true)
  })
})
