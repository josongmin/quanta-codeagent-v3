import { describe, expect, test } from "bun:test"
import { type GroundingCase, resolveGroundingReferentContext } from "@/../src/apps/eval/grounding"

const baseCase = (overrides: Partial<GroundingCase> = {}): GroundingCase => ({
  schema: 2,
  id: "case",
  usecase: "persistent-context.conversation-state.thread-grounding",
  history: [{ role: "assistant", text: "Active thread prompt_rules." }],
  targetUtterance: "그거 다시 돌려봐.",
  gold: {
    activeThreadId: "prompt_rules",
    referentId: "stale_refresh_token_path",
    intent: "execute_change",
    scope: "specific_subthread",
    shouldClarify: false,
    confidence: "high",
  },
  bucket: "reference",
  severity: "medium",
  ...overrides,
})

describe("grounding referent context", () => {
  test("prefers the latest structured referent for generic subthread cues", () => {
    const resolved = resolveGroundingReferentContext(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "oauth_resume",
            referentId: "stale_refresh_token_path",
            text: "Remaining issue is the stale refresh token path.",
          },
        ],
      }),
    )
    expect(resolved.primaryReferentId).toBe("stale_refresh_token_path")
    expect(resolved.resolvedReferentId).toBe("stale_refresh_token_path")
    expect(resolved.suggestsSpecificSubthread).toBe(true)
  })

  test("detects ambiguous subthread candidate sets", () => {
    const resolved = resolveGroundingReferentContext(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "session_transport",
            mentionedReferentIds: ["websocket_resume", "sse_fallback"],
            text: "Two subthreads remain: websocket_resume and sse_fallback.",
          },
        ],
        targetUtterance: "그 서브스레드부터 닫아.",
        gold: {
          activeThreadId: "session_transport",
          referentId: null,
          intent: "execute_change",
          scope: "specific_subthread",
          shouldClarify: true,
          confidence: "high",
        },
      }),
    )
    expect(resolved.isAmbiguous).toBe(true)
    expect(resolved.resolvedReferentId).toBeNull()
  })

  test("canonicalizes context-change and memory referents", () => {
    const mode = resolveGroundingReferentContext(
      baseCase({
        history: [{ role: "assistant", text: "Switched to review mode." }],
        targetUtterance: "지금 뭐 기준으로 봐야 해?",
        contextChanges: [{ field: "mode", prev: "default", next: "review" }],
      }),
    )
    expect(mode.resolvedReferentId).toBe("review_mode")

    const memory = resolveGroundingReferentContext(
      baseCase({
        history: [
          { role: "assistant", text: "Active thread grounding_gate is tuning thresholds." },
        ],
        memoryContext: "Remember: fail_closed_policy means wrong_thread must stay 0.",
        targetUtterance: "그 제약 아직 유지하냐?",
        gold: {
          activeThreadId: "grounding_gate",
          referentId: "fail_closed_policy",
          intent: "status_check",
          scope: "specific_subthread",
          shouldClarify: false,
          confidence: "medium",
        },
      }),
    )
    expect(memory.resolvedReferentId).toBe("fail_closed_policy")
  })
})
