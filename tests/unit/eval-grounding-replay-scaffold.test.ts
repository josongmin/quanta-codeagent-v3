import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildGroundingReplayScaffold, writeGroundingReplayScaffold } from "@/../src/apps/eval/grounding"

describe("grounding replay scaffold", () => {
  test("builds and writes a stable replay scaffold from trajectory + session snapshot truth", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-replay-scaffold-"))
    const source = join(root, "session.jsonl")
    const snapshot = join(root, "snapshot.json")
    const out = join(root, "fixture.json")
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

    const fixture = buildGroundingReplayScaffold({
      source,
      sessionSnapshotPath: snapshot,
      id: "replay-fixture",
      corpus: "replay_critical",
      targetUtterance: "야 이제 다 해결됐냐?",
      bucket: "ellipsis",
      severity: "critical",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      candidateThreadIds: ["prompt_rules"],
    })
    expect(fixture.sourceProvenance).toEqual({
      kind: "session_freeze",
      sessionId: "session-1",
      seqRange: [1, 3],
    })
    expect(fixture.humanAudit).toEqual({ status: "none" })
    expect(fixture.blockingEligible).toBe(false)
    expect(fixture.history[0]).toEqual({ role: "user", text: "프롬프트 규칙 쪽 계속해." })
    expect(fixture.history.some((entry) => entry.kind === "tool_result")).toBe(true)
    expect(fixture.stateContract?.policyMarkers).toEqual([
      "glob:prompt-rules",
      "mode:default",
      "skill:grounding",
      "summary:none",
    ])

    const written = writeGroundingReplayScaffold({
      source,
      sessionSnapshotPath: snapshot,
      id: "replay-fixture",
      corpus: "replay_critical",
      targetUtterance: "야 이제 다 해결됐냐?",
      bucket: "ellipsis",
      severity: "critical",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      candidateThreadIds: ["prompt_rules"],
      outPath: out,
    })
    expect(written.fixture.id).toBe("replay-fixture")
    expect(readFileSync(out, "utf8")).toBe(written.fixtureText)
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      id: "replay-fixture",
      corpus: "replay_critical",
      blockingEligible: false,
    })
  })
})
