import { describe, expect, test } from "bun:test"
import { normalizeGroundingDecision, type GroundingCase } from "@/../src/apps/eval/grounding"

const baseCase = (overrides: Partial<GroundingCase> = {}): GroundingCase => ({
  schema: 2,
  id: "case",
  usecase: "persistent-context.conversation-state.thread-grounding",
  history: [{ role: "assistant", text: "Active thread prompt_rules." }],
  targetUtterance: "야 이제 다 해결됐냐?",
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
  ...overrides,
})

describe("grounding decision normalizer", () => {
  test("fills referentId from activeThreadId for current_workstream defaults", () => {
    const out = normalizeGroundingDecision(baseCase(), {
      activeThreadId: "prompt_rules",
      referentId: null,
      intent: "status_check",
      scope: "current_workstream",
      shouldClarify: false,
      confidence: "high",
    })
    expect(out.referentId).toBe("prompt_rules")
  })

  test("fills missing activeThreadId and latest tool result from stateContract", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        bucket: "summary_equivalence",
        stateContract: {
          activeThreadId: "screenshot_send",
          latestToolResultId: "latest_capture_failure",
          latestToolName: "capture_image",
        },
        gold: {
          activeThreadId: "screenshot_send",
          referentId: "latest_capture_failure",
          intent: "explain",
          scope: "latest_tool_result",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: null,
        referentId: null,
        intent: "explain",
        scope: "latest_tool_result",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(out.activeThreadId).toBe("screenshot_send")
    expect(out.referentId).toBe("latest_capture_failure")
  })

  test("preserves latent intent when the model asks for clarification", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        bucket: "must_clarify",
        gold: {
          activeThreadId: "prompt_rules",
          referentId: null,
          intent: "execute_change",
          scope: "specific_file",
          shouldClarify: true,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: null,
        intent: "clarify_request",
        scope: "specific_file",
        shouldClarify: true,
        confidence: "medium",
      },
    )
    expect(out.intent).toBe("execute_change")
  })

  test("promotes rerun and threshold lookup cues to the correct intent", () => {
    const rerun = normalizeGroundingDecision(
      baseCase({
        targetUtterance: "그거 다시 돌려봐",
        stateContract: { activeThreadId: "oauth_abort_flow" },
      }),
      {
        activeThreadId: "oauth_abort_flow",
        referentId: "oauth_abort_flow",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(rerun.intent).toBe("execute_change")

    const lookup = normalizeGroundingDecision(
      baseCase({
        targetUtterance: "현재 기준선이 뭐였지?",
      }),
      {
        activeThreadId: "context_grounding",
        referentId: "context_grounding",
        intent: "explain",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(lookup.intent).toBe("fact_lookup")
  })

  test("detects explicit clarify, entire-session, and subthread cues", () => {
    const clarify = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            text: "Active thread prompt_rules still has two candidate files: src/agent/prompt.ts and src/agent/loop.ts.",
          },
        ],
        targetUtterance: "애매하면 먼저 물어봐.",
      }),
      {
        activeThreadId: null,
        referentId: null,
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
    )
    expect(clarify.intent).toBe("clarify_request")
    expect(clarify.scope).toBe("specific_file")
    expect(clarify.activeThreadId).toBe("prompt_rules")

    const overview = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            text: "prompt_rules is near closeout, feature_catalog is mid-flight, oauth_abort_flow is paused.",
          },
        ],
        targetUtterance: "지금 전체적으로 뭐 남았냐?",
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
    )
    expect(overview.scope).toBe("entire_session")
    expect(overview.activeThreadId).toBeNull()
    expect(overview.referentId).toBeNull()

    const step = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            text: "Active thread prompt_rules plan: prompt_rules_step_1 = add payload, prompt_rules_step_2 = add scorer hellgate.",
          },
        ],
        targetUtterance: "2번부터 해.",
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: null,
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(step.scope).toBe("specific_subthread")
    expect(step.referentId).toBe("prompt_rules_step_2")
  })

  test("forces clarify on generic ambiguous thread or file references", () => {
    const ambiguousThreads = normalizeGroundingDecision(
      baseCase({
        history: [
          { role: "assistant", text: "Two open threads remain: prompt_rules and feature_catalog." },
          { role: "assistant", text: "Both are unfinished and both were mentioned in the last status pass." },
        ],
        targetUtterance: "그거 먼저 끝내.",
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
    )
    expect(ambiguousThreads.shouldClarify).toBe(true)
    expect(ambiguousThreads.activeThreadId).toBeNull()
    expect(ambiguousThreads.referentId).toBeNull()

    const ambiguousFiles = normalizeGroundingDecision(
      baseCase({
        history: [
          { role: "assistant", text: "Active thread prompt_rules is touching src/agent/prompt.ts and src/agent/loop.ts." },
          { role: "assistant", text: "Both files still have open edits." },
        ],
        targetUtterance: "그 파일만 건드려.",
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
    )
    expect(ambiguousFiles.shouldClarify).toBe(true)
    expect(ambiguousFiles.scope).toBe("specific_file")
    expect(ambiguousFiles.referentId).toBeNull()
  })

  test("promotes imperative subthread cues to execute_change", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            text: "Active thread session_transport has two subthreads: ws_reuse and sse_fallback.",
          },
        ],
        targetUtterance: "ws_reuse 쪽만 더 파.",
      }),
      {
        activeThreadId: "session_transport",
        referentId: "ws_reuse",
        intent: "fact_lookup",
        scope: "specific_subthread",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(out.intent).toBe("execute_change")
  })

  test("resolves specific_file referents from explicit paths and owner authority", () => {
    const explicit = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "prompt_rules",
            mentionedFileIds: ["src/agent/prompt.ts"],
            text: "Active thread prompt_rules is narrowing to src/agent/prompt.ts for the next patch.",
          },
        ],
        targetUtterance: "src/agent/prompt.ts만 손봐.",
        gold: {
          activeThreadId: "prompt_rules",
          referentId: "src/agent/prompt.ts",
          intent: "execute_change",
          scope: "specific_file",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(explicit.scope).toBe("specific_file")
    expect(explicit.referentId).toBe("src/agent/prompt.ts")

    const ownerShortlist = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "prompt_cache_resume",
            mentionedFileIds: ["src/apps/eval/index.ts", "src/apps/eval/grounding/report.ts"],
            text: "Owner shortlist currently ranks src/apps/eval/index.ts first, then src/apps/eval/grounding/report.ts.",
          },
        ],
        targetUtterance: "그 파일부터 손봐.",
        workingState: {
          ownerShortlist: [
            { file: "src/apps/eval/index.ts", reason: "primary owner" },
            { file: "src/apps/eval/grounding/report.ts", reason: "metric rendering" },
          ],
          blockers: [],
          nextStepQueue: [],
          deferredValidation: [],
        },
        gold: {
          activeThreadId: "prompt_cache_resume",
          referentId: "src/apps/eval/index.ts",
          intent: "execute_change",
          scope: "specific_file",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "prompt_cache_resume",
        referentId: "prompt_cache_resume",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(ownerShortlist.scope).toBe("specific_file")
    expect(ownerShortlist.referentId).toBe("src/apps/eval/index.ts")
  })

  test("resolves structured subthread referents and ship-it approval cues", () => {
    const subthread = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "oauth_resume",
            referentId: "stale_refresh_token_path",
            text: "Back on oauth_resume, the remaining issue is the stale refresh token path.",
          },
        ],
        targetUtterance: "그거 다시 돌려봐.",
        gold: {
          activeThreadId: "oauth_resume",
          referentId: "stale_refresh_token_path",
          intent: "execute_change",
          scope: "specific_subthread",
          shouldClarify: false,
          confidence: "medium",
        },
      }),
      {
        activeThreadId: "oauth_resume",
        referentId: "oauth_resume",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
    )
    expect(subthread.scope).toBe("specific_subthread")
    expect(subthread.referentId).toBe("stale_refresh_token_path")
    expect(subthread.intent).toBe("execute_change")

    const approval = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            text: "Active thread workflow_gate now has only the canary threshold step left.",
          },
        ],
        targetUtterance: "그럼 이거 그냥 올리자.",
        gold: {
          activeThreadId: "workflow_gate",
          referentId: "workflow_gate",
          intent: "approval_request",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "medium",
        },
      }),
      {
        activeThreadId: "workflow_gate",
        referentId: "workflow_gate",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
    )
    expect(approval.intent).toBe("approval_request")
  })

  test("does not over-promote current workstream cases that only restate the active thread", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "prompt_rules",
            referentId: "prompt_rules",
            text: "Current thread prompt_rules is still active. oauth_abort_flow is explicitly paused.",
          },
        ],
        targetUtterance: "현재 작업 기준으로 뭐 남았어?",
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(out.scope).toBe("current_workstream")
    expect(out.intent).toBe("status_check")
  })

  test("demotes non-file specific_file predictions back to specific_subthread", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            referentId: "old_runner_log",
            text: "Archived log old_runner_log is from last week.",
          },
          {
            role: "assistant",
            threadId: "runner_rca",
            referentId: "current_runner_log",
            text: "Current active thread runner_rca is reading current_runner_log for today's failure.",
          },
        ],
        targetUtterance: "그 로그부터 읽어.",
        gold: {
          activeThreadId: "runner_rca",
          referentId: "current_runner_log",
          intent: "execute_change",
          scope: "specific_subthread",
          shouldClarify: false,
          confidence: "medium",
        },
      }),
      {
        activeThreadId: "runner_rca",
        referentId: "current_runner_log",
        intent: "status_check",
        scope: "specific_file",
        shouldClarify: false,
        confidence: "high",
      },
    )
    expect(out.scope).toBe("specific_subthread")
    expect(out.referentId).toBe("current_runner_log")
    expect(out.intent).toBe("execute_change")
  })
})
