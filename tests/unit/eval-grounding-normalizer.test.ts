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
    expect(out.decision.referentId).toBe("prompt_rules")
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
    expect(out.decision.activeThreadId).toBe("screenshot_send")
    expect(out.decision.referentId).toBe("latest_capture_failure")
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
    expect(out.decision.intent).toBe("execute_change")
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
    expect(rerun.decision.intent).toBe("execute_change")

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
    expect(lookup.decision.intent).toBe("fact_lookup")
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
    expect(clarify.decision.intent).toBe("clarify_request")
    expect(clarify.decision.scope).toBe("specific_file")
    expect(clarify.decision.activeThreadId).toBe("prompt_rules")

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
    expect(overview.decision.scope).toBe("entire_session")
    expect(overview.decision.activeThreadId).toBeNull()
    expect(overview.decision.referentId).toBeNull()

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
    expect(step.decision.scope).toBe("specific_subthread")
    expect(step.decision.referentId).toBe("prompt_rules_step_2")
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
    expect(ambiguousThreads.decision.shouldClarify).toBe(true)
    expect(ambiguousThreads.decision.activeThreadId).toBeNull()
    expect(ambiguousThreads.decision.referentId).toBeNull()

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
    expect(ambiguousFiles.decision.shouldClarify).toBe(true)
    expect(ambiguousFiles.decision.scope).toBe("specific_file")
    expect(ambiguousFiles.decision.referentId).toBeNull()
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
    expect(out.decision.intent).toBe("execute_change")
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
    expect(explicit.decision.scope).toBe("specific_file")
    expect(explicit.decision.referentId).toBe("src/agent/prompt.ts")

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
    expect(ownerShortlist.decision.scope).toBe("specific_file")
    expect(ownerShortlist.decision.referentId).toBe("src/apps/eval/index.ts")
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
    expect(subthread.decision.scope).toBe("specific_subthread")
    expect(subthread.decision.referentId).toBe("stale_refresh_token_path")
    expect(subthread.decision.intent).toBe("execute_change")

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
    expect(approval.decision.intent).toBe("approval_request")
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
    expect(out.decision.scope).toBe("current_workstream")
    expect(out.decision.intent).toBe("status_check")
  })

  test("canonicalizes current_workstream referents back to the active thread", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            text: "Active thread prompt_rules has a patch ready for merge.",
          },
        ],
        targetUtterance: "그럼 이거 머지해도 되냐?",
        gold: {
          activeThreadId: "prompt_rules",
          referentId: "prompt_rules",
          intent: "approval_request",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "patch_ready_for_merge",
        intent: "approval_request",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      "structural",
    )
    expect(out.decision.referentId).toBe("prompt_rules")
    expect(out.decision.activeThreadId).toBe("prompt_rules")
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
    expect(out.decision.scope).toBe("specific_subthread")
    expect(out.decision.referentId).toBe("current_runner_log")
    expect(out.decision.intent).toBe("execute_change")
  })

  test("repairs over-clarified current workstream predictions when one active thread is authoritative", () => {
    const out = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "context_grounding",
            text: "Active thread context_grounding chose a structured probe instead of a prose judge.",
          },
        ],
        targetUtterance: "이거 왜 이렇게 설계했는지 설명해.",
        gold: {
          activeThreadId: "context_grounding",
          referentId: "context_grounding",
          intent: "explain",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: null,
        referentId: null,
        intent: "explain",
        scope: "current_workstream",
        shouldClarify: true,
        confidence: "low",
      },
      "structural",
    )
    expect(out.decision.activeThreadId).toBe("context_grounding")
    expect(out.decision.referentId).toBe("context_grounding")
    expect(out.decision.shouldClarify).toBe(false)
    expect(out.decision.intent).toBe("explain")
  })

  test("demotes unsupported latest_tool_result scope without lexical intent repair in structural mode", () => {
    const latest = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "doc_sync",
            referentId: "doc_sync_recent_change",
            text: "Active thread doc_sync last changed the persistent-context section and added the thread-grounding row.",
          },
        ],
        targetUtterance: "방금 뭘 바꿨지?",
        gold: {
          activeThreadId: "doc_sync",
          referentId: "doc_sync_recent_change",
          intent: "fact_lookup",
          scope: "specific_subthread",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "doc_sync",
        referentId: "doc_sync_recent_change",
        intent: "explain",
        scope: "latest_tool_result",
        shouldClarify: false,
        confidence: "high",
      },
      "structural",
    )
    expect(latest.decision.intent).toBe("explain")
    expect(latest.decision.scope).toBe("specific_subthread")

    const explain = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "responses_migration",
            referentId: "gpt-4.1",
            text: "Active thread responses_migration switched the evaluator model from gpt-4o to gpt-4.1.",
          },
        ],
        targetUtterance: "그 모델 기준으로 다시 설명해.",
        gold: {
          activeThreadId: "responses_migration",
          referentId: "gpt-4.1",
          intent: "explain",
          scope: "specific_subthread",
          shouldClarify: false,
          confidence: "high",
        },
      }),
      {
        activeThreadId: "responses_migration",
        referentId: "gpt-4.1",
        intent: "explain",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      "structural",
    )
    expect(explain.decision.scope).toBe("specific_subthread")
    expect(explain.decision.intent).toBe("explain")
  })

  test("raw/structural/heuristic normalization profiles stay separated", () => {
    const groundingCase = baseCase({
      targetUtterance: "그거 다시 돌려봐",
      stateContract: { activeThreadId: "oauth_abort_flow" },
      gold: {
        activeThreadId: "oauth_abort_flow",
        referentId: "oauth_abort_flow",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    })
    const decision = {
      activeThreadId: "oauth_abort_flow",
      referentId: null,
      intent: "status_check" as const,
      scope: "current_workstream" as const,
      shouldClarify: false,
      confidence: "high" as const,
    }

    const raw = normalizeGroundingDecision(groundingCase, decision, "none")
    expect(raw.decision).toEqual(decision)
    expect(raw.applied).toBe(false)

    const structural = normalizeGroundingDecision(groundingCase, decision, "structural")
    expect(structural.decision.referentId).toBe("oauth_abort_flow")
    expect(structural.decision.intent).toBe("status_check")

    const heuristic = normalizeGroundingDecision(groundingCase, decision, "heuristic")
    expect(heuristic.decision.referentId).toBe("oauth_abort_flow")
    expect(heuristic.decision.intent).toBe("execute_change")
  })

  test("structural mode does not upgrade approval or explain intents from lexical cues", () => {
    const approval = normalizeGroundingDecision(
      baseCase({
        targetUtterance: "그럼 이거 그냥 올리자.",
      }),
      {
        activeThreadId: "workflow_gate",
        referentId: "workflow_gate",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
      "structural",
    )
    expect(approval.decision.intent).toBe("execute_change")

    const explain = normalizeGroundingDecision(
      baseCase({
        targetUtterance: "왜 그랬는지 설명해.",
      }),
      {
        activeThreadId: "context_grounding",
        referentId: "context_grounding",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
      "structural",
    )
    expect(explain.decision.intent).toBe("status_check")

    const threshold = normalizeGroundingDecision(
      baseCase({
        targetUtterance: "현재 기준선이 뭐였지?",
      }),
      {
        activeThreadId: "context_grounding",
        referentId: "context_grounding",
        intent: "explain",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
      "structural",
    )
    expect(threshold.decision.intent).toBe("explain")
  })

  test("structural mode refuses session-wide, step-number, and prose ambiguity lifts", () => {
    const sessionWide = normalizeGroundingDecision(
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
      "structural",
    )
    expect(sessionWide.decision.scope).toBe("current_workstream")

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
      "structural",
    )
    expect(step.decision.scope).toBe("current_workstream")
    expect(step.decision.referentId).toBe("prompt_rules")

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
      "structural",
    )
    expect(ambiguousThreads.decision.shouldClarify).toBe(false)
    expect(ambiguousThreads.decision.activeThreadId).toBe("prompt_rules")
  })

  test("structural mode uses authoritative ambiguityClass and candidate sets to force clarify", () => {
    const ambiguousThread = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            mentionedThreadIds: ["prompt_rules", "feature_catalog"],
            text: "Two open threads remain: prompt_rules and feature_catalog.",
          },
        ],
        candidateThreadIds: ["prompt_rules", "feature_catalog"],
        ambiguityClass: "thread",
        stateContract: {
          activeThreadId: null,
          visibleThreadIds: ["feature_catalog", "prompt_rules"],
        },
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "execute_change",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "medium",
      },
      "structural",
    )
    expect(ambiguousThread.decision.activeThreadId).toBeNull()
    expect(ambiguousThread.decision.referentId).toBeNull()
    expect(ambiguousThread.decision.shouldClarify).toBe(true)

    const ambiguousFile = normalizeGroundingDecision(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "prompt_rules",
            mentionedFileIds: ["src/agent/prompt.ts", "src/agent/loop.ts"],
            text: "Active thread prompt_rules is touching src/agent/prompt.ts and src/agent/loop.ts.",
          },
        ],
        ambiguityClass: "file",
        stateContract: {
          activeThreadId: "prompt_rules",
          candidateFileIds: ["src/agent/loop.ts", "src/agent/prompt.ts"],
        },
      }),
      {
        activeThreadId: "prompt_rules",
        referentId: "src/agent/prompt.ts",
        intent: "execute_change",
        scope: "specific_file",
        shouldClarify: false,
        confidence: "medium",
      },
      "structural",
    )
    expect(ambiguousFile.decision.scope).toBe("specific_file")
    expect(ambiguousFile.decision.referentId).toBeNull()
    expect(ambiguousFile.decision.shouldClarify).toBe(true)
  })
})
