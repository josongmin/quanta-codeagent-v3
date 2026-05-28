import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildGroundingReplayDraft,
  promoteGroundingReplayDraft,
  readGroundingReplayDraft,
  writeGroundingReplayDraft,
  writePromotedGroundingReplayCase,
} from "@/../src/apps/eval/grounding"

const writeReplaySource = (root: string): { source: string; snapshot: string } => {
  const source = join(root, "session.jsonl")
  const snapshot = join(root, "snapshot.json")
  writeFileSync(
    source,
    [
      {
        schema: "quanta.trajectory.v1",
        v: 1,
        seq: 1,
        ts: 1,
        ctx: { runId: "session-1" },
        producer: { name: "test", version: "1" },
        redaction: { policy: "secrets.v1", applied: true },
        kind: "turn_start",
        data: {},
      },
      {
        schema: "quanta.trajectory.v1",
        v: 1,
        seq: 2,
        ts: 2,
        ctx: { runId: "session-1" },
        producer: { name: "test", version: "1" },
        redaction: { policy: "secrets.v1", applied: true },
        kind: "assistant_text",
        data: { delta: "Active thread prompt_rules is still open." },
      },
      {
        schema: "quanta.trajectory.v1",
        v: 1,
        seq: 3,
        ts: 3,
        ctx: { runId: "session-1" },
        producer: { name: "test", version: "1" },
        redaction: { policy: "secrets.v1", applied: true },
        kind: "tool_result",
        data: { name: "capture_image", ok: false, stderrTail: "upload aborted" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  )
  writeFileSync(
    `${source}.meta.json`,
    JSON.stringify({
      schema: 1,
      userPrompt: "프롬프트 규칙 쪽 계속해.",
      cwd: "/repo",
      producer: { name: "test", version: "1" },
      recordedAt: "2026-05-28T00:00:00.000Z",
    }),
  )
  writeFileSync(
    snapshot,
    JSON.stringify({
      sessionId: "session-1",
      revision: 1,
      seq: 10,
      state: {
        status: "idle",
        draftInput: "",
        permissionMode: "default",
        messageCount: 2,
        lastUserText: "프롬프트 규칙 쪽 계속해.",
        lastAssistantText: "Active thread prompt_rules is still open.",
        lastLlmRequest: {
          model: "gpt-4.1",
          policy: {
            mode: "default",
            baseSystem: "default",
            systemLayout: "four_section",
            repoRulesPresent: true,
            sessionCtxPresent: false,
            userAppendPresent: false,
            selectedGlobRuleNames: ["prompt-rules"],
            activeSkillNames: ["grounding"],
            workingStatePresent: false,
            memoryContextPresent: false,
            contextChangeCount: 0,
            mentionInjectionCount: 0,
            hookContext: "none",
            summaryPrefix: "none",
            toolChoice: "auto",
            promptCacheKeyPresent: true,
          },
        },
      },
      capabilities: {
        approvals: "none",
        tools: false,
        memory: false,
        artifacts: false,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        transport: "inproc",
      },
      pendingApproval: null,
      openArtifacts: [],
    }),
  )
  return { source, snapshot }
}

describe("grounding replay draft/promote pipeline", () => {
  test("builds and writes a gold-blind replay draft from trajectory + session snapshot truth", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-replay-draft-"))
    const { source, snapshot } = writeReplaySource(root)
    const out = join(root, "draft.json")

    const draft = buildGroundingReplayDraft({
      source,
      sessionSnapshotPath: snapshot,
      id: "replay-fixture",
      targetUtterance: "야 이제 다 해결됐냐?",
      bucket: "ellipsis",
      severity: "critical",
      candidateThreadIds: ["prompt_rules"],
    })
    expect(draft.sourceProvenance).toEqual({
      kind: "session_freeze",
      sessionId: "session-1",
      seqRange: [1, 3],
    })
    expect(draft.humanAudit).toEqual({ status: "none" })
    expect(draft.history[0]).toEqual({ role: "user", text: "프롬프트 규칙 쪽 계속해." })
    expect(draft.history.some((entry) => entry.kind === "tool_result")).toBe(true)
    expect(draft.stateContract?.policyMarkers).toEqual([
      "glob:prompt-rules",
      "mode:default",
      "skill:grounding",
      "summary:none",
    ])
    expect("gold" in draft).toBe(false)
    expect("corpus" in draft).toBe(false)
    expect("blockingEligible" in draft).toBe(false)

    const written = writeGroundingReplayDraft({
      source,
      sessionSnapshotPath: snapshot,
      id: "replay-fixture",
      targetUtterance: "야 이제 다 해결됐냐?",
      bucket: "ellipsis",
      severity: "critical",
      candidateThreadIds: ["prompt_rules"],
      outPath: out,
    })
    expect(written.draft.id).toBe("replay-fixture")
    expect(readFileSync(out, "utf8")).toBe(written.draftText)
    expect(readGroundingReplayDraft(out)).toEqual(written.draft)
  })

  test("draft output is invariant under different gold labels and promotion round-trips cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-replay-promote-"))
    const { source, snapshot } = writeReplaySource(root)
    const draft = buildGroundingReplayDraft({
      source,
      sessionSnapshotPath: snapshot,
      id: "replay-fixture",
      targetUtterance: "야 이제 다 해결됐냐?",
      bucket: "ellipsis",
      severity: "critical",
      candidateThreadIds: ["prompt_rules"],
    })

    const promotedA = promoteGroundingReplayDraft({
      draft,
      corpus: "replay_critical",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
    })
    const promotedB = promoteGroundingReplayDraft({
      draft,
      corpus: "replay_critical",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: null,
        intent: "clarify_request",
        scope: "specific_file",
        shouldClarify: true,
        confidence: "medium",
      },
    })
    expect(draft.id).toBe("replay-fixture")
    expect(promotedA.id).toBe(draft.id)
    expect(promotedB.id).toBe(draft.id)
    expect(promotedA.gold.intent).toBe("status_check")
    expect(promotedB.gold.intent).toBe("clarify_request")

    const out = join(root, "fixture.json")
    const written = writePromotedGroundingReplayCase({
      draft,
      corpus: "replay_critical",
      gold: promotedA.gold,
      outPath: out,
    })
    expect(readFileSync(out, "utf8")).toBe(written.fixtureText)
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      id: "replay-fixture",
      corpus: "replay_critical",
      gold: promotedA.gold,
      blockingEligible: false,
    })
  })

  test("draft generation does not populate stateContract fields missing from source truth", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-replay-minimal-"))
    const source = join(root, "session.jsonl")
    writeFileSync(
      source,
      JSON.stringify({
        schema: "quanta.trajectory.v1",
        v: 1,
        seq: 1,
        ts: 1,
        ctx: { runId: "session-2" },
        producer: { name: "test", version: "1" },
        redaction: { policy: "secrets.v1", applied: true },
        kind: "assistant_text",
        data: { delta: "No structured thread metadata here." },
      }),
    )
    writeFileSync(
      `${source}.meta.json`,
      JSON.stringify({
        schema: 1,
        userPrompt: "그거 정리해.",
        cwd: "/repo",
        producer: { name: "test", version: "1" },
        recordedAt: "2026-05-28T00:00:00.000Z",
      }),
    )
    const draft = buildGroundingReplayDraft({
      source,
      id: "replay-minimal",
      targetUtterance: "그거 정리해.",
      bucket: "ellipsis",
      severity: "medium",
    })
    expect(draft.stateContract).toBeUndefined()
  })
})
