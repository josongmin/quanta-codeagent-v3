import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadGroundingCases, parseGroundingCase } from "@/../src/apps/eval/grounding"

describe("grounding schema", () => {
  const writeCase = (dir: string, name: string, body: unknown): void => {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(body, null, 2), "utf8")
  }

  const pairState = (overrides: Record<string, unknown> = {}) => ({
    activeThreadId: "prompt_rules",
    visibleThreadIds: ["oauth_abort_flow", "prompt_rules"],
    pausedThreadIds: ["oauth_abort_flow"],
    candidateFileIds: ["src/agent/loop.ts", "src/agent/prompt.ts"],
    primaryFileId: "src/agent/prompt.ts",
    policyMarkers: ["closeout"],
    ...overrides,
  })

  const minimalCase = (overrides: Record<string, unknown> = {}) => ({
    schema: 2,
    id: "sample",
    usecase: "persistent-context.conversation-state.thread-grounding",
    history: [
      {
        role: "assistant",
        kind: "message",
        text: "Active thread prompt_rules.",
        threadId: "prompt_rules",
      },
    ],
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
    ...overrides,
  })

  test("parses a valid minimal case", () => {
    const parsed = parseGroundingCase(minimalCase())
    expect(parsed.id).toBe("sample")
    expect(parsed.gold.intent).toBe("status_check")
  })

  test("parses structured history metadata and stateContract", () => {
    const parsed = parseGroundingCase(
      minimalCase({
        history: [
          {
            role: "assistant",
            kind: "summary",
            text: "Conversation summary: prompt_rules is active.",
            threadId: "prompt_rules",
            mentionedFileIds: ["src/agent/prompt.ts"],
            mentionedReferentIds: ["prompt_rules_step_2"],
            mentionedThreadIds: ["oauth_abort_flow"],
            policyMarkers: ["closeout"],
          },
        ],
        stateContract: pairState(),
        pairId: "pair-1",
        pairRole: "summary",
        bucket: "summary_equivalence",
      }),
    )
    expect(parsed.history[0]).toMatchObject({
      kind: "summary",
      threadId: "prompt_rules",
      mentionedFileIds: ["src/agent/prompt.ts"],
      mentionedReferentIds: ["prompt_rules_step_2"],
      mentionedThreadIds: ["oauth_abort_flow"],
      policyMarkers: ["closeout"],
    })
    expect(parsed.stateContract).toEqual(pairState())
  })

  test("rejects malformed cases fail-closed", () => {
    expect(() =>
      parseGroundingCase({
        schema: 2,
        id: "broken",
        usecase: "persistent-context.conversation-state.thread-grounding",
        history: "not-an-array",
        targetUtterance: "x",
        gold: {},
        bucket: "ellipsis",
        severity: "critical",
      }),
    ).toThrow("history must be an array")

    expect(() =>
      parseGroundingCase({
        schema: 2,
        id: "broken-2",
        usecase: "persistent-context.conversation-state.thread-grounding",
        history: [],
        targetUtterance: "x",
        gold: {
          activeThreadId: null,
          referentId: null,
          intent: "status_check",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
        bucket: "bogus",
        severity: "critical",
      }),
    ).toThrow("bucket must be one of")

    expect(() =>
      parseGroundingCase({
        ...minimalCase(),
        pairId: "pair-1",
        pairRole: "raw",
      }),
    ).toThrow("pairId requires stateContract")
  })

  // isRecord array-handling safety: a JSON array IS `typeof "object"` and
  // not null, so a naive narrower would let it through as a "record". The
  // `!Array.isArray` guard makes an array root correctly fail-closed with
  // the same "must be an object" error a scalar produces.
  test("rejects an array root (array is not an object)", () => {
    expect(() => parseGroundingCase([])).toThrow("grounding case must be an object")
    expect(() => parseGroundingCase([minimalCase()])).toThrow("grounding case must be an object")
  })

  test("still accepts a normal object root", () => {
    expect(parseGroundingCase(minimalCase()).id).toBe("sample")
  })

  test("governed corpora stay at canary=28 and nightly=52", () => {
    expect(loadGroundingCases({ suite: "canary" })).toHaveLength(28)
    expect(loadGroundingCases({ suite: "nightly" })).toHaveLength(52)
  })

  test("loader rejects malformed summary pair contracts fail-closed", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-pair-"))
    try {
      const canary = join(root, "canary")
      mkdirSync(canary, { recursive: true })
      writeCase(
        canary,
        "pair-raw",
        minimalCase({
          id: "pair-raw",
          bucket: "summary_equivalence",
          pairId: "pair-1",
          pairRole: "raw",
          stateContract: pairState(),
        }),
      )
      writeCase(
        canary,
        "pair-summary",
        minimalCase({
          id: "pair-summary",
          bucket: "summary_equivalence",
          pairId: "pair-1",
          pairRole: "summary",
          gold: {
            activeThreadId: "other_thread",
            referentId: "other_thread",
            intent: "status_check",
            scope: "current_workstream",
            shouldClarify: false,
            confidence: "high",
          },
          stateContract: pairState({
            activeThreadId: "other_thread",
            visibleThreadIds: ["oauth_abort_flow", "other_thread"],
          }),
        }),
      )
      writeCase(
        canary,
        "must-clarify",
        minimalCase({ id: "must-clarify", bucket: "must_clarify" }),
      )
      writeCase(
        canary,
        "stale",
        minimalCase({ id: "stale", bucket: "stale_context_trap" }),
      )
      writeCase(
        canary,
        "wrong-thread",
        minimalCase({ id: "wrong-thread", bucket: "wrong_thread_adversarial" }),
      )
      expect(() => loadGroundingCases({ suite: "canary", casesRoot: root })).toThrow(
        "raw/summary contract mismatch",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loader rejects specific_file cases that cannot resolve a unique file authority", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-specific-file-"))
    try {
      const nightly = join(root, "nightly")
      mkdirSync(nightly, { recursive: true })
      writeCase(
        nightly,
        "bad-file",
        minimalCase({
          id: "bad-file",
          history: [{ role: "assistant", text: "Active thread prompt_rules touched prompt files." }],
          targetUtterance: "그 파일부터 손봐.",
          gold: {
            activeThreadId: "prompt_rules",
            referentId: "src/agent/prompt.ts",
            intent: "execute_change",
            scope: "specific_file",
            shouldClarify: false,
            confidence: "high",
          },
          severity: "medium",
        }),
      )
      expect(() => loadGroundingCases({ suite: "nightly", casesRoot: root })).toThrow(
        "specific_file authority must resolve gold.referentId",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loader accepts raw/source bucket pairs as long as summary role is canonical", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-pair-source-"))
    try {
      const canary = join(root, "canary")
      mkdirSync(canary, { recursive: true })
      writeCase(
        canary,
        "pair-raw",
        minimalCase({
          id: "pair-raw",
          bucket: "tool_noise",
          pairId: "pair-1",
          pairRole: "raw",
          stateContract: pairState(),
        }),
      )
      writeCase(
        canary,
        "pair-summary",
        minimalCase({
          id: "pair-summary",
          bucket: "summary_equivalence",
          pairId: "pair-1",
          pairRole: "summary",
          history: [
            {
              role: "assistant",
              kind: "summary",
              text: "Conversation summary: prompt_rules is active.",
              threadId: "prompt_rules",
              mentionedThreadIds: ["oauth_abort_flow"],
              policyMarkers: ["closeout"],
            },
          ],
          stateContract: pairState(),
        }),
      )
      writeCase(
        canary,
        "must-clarify",
        minimalCase({ id: "must-clarify", bucket: "must_clarify" }),
      )
      writeCase(
        canary,
        "stale",
        minimalCase({ id: "stale", bucket: "stale_context_trap" }),
      )
      writeCase(
        canary,
        "wrong-thread",
        minimalCase({ id: "wrong-thread", bucket: "wrong_thread_adversarial" }),
      )
      const loaded = loadGroundingCases({ suite: "canary", casesRoot: root })
      expect(loaded).toHaveLength(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loader rejects summary role cases outside summary_equivalence bucket", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-pair-summary-bucket-"))
    try {
      const canary = join(root, "canary")
      mkdirSync(canary, { recursive: true })
      writeCase(
        canary,
        "pair-raw",
        minimalCase({
          id: "pair-raw",
          bucket: "tool_noise",
          pairId: "pair-1",
          pairRole: "raw",
          stateContract: pairState(),
        }),
      )
      writeCase(
        canary,
        "pair-summary",
        minimalCase({
          id: "pair-summary",
          bucket: "reference",
          pairId: "pair-1",
          pairRole: "summary",
          history: [
            {
              role: "assistant",
              kind: "summary",
              text: "Conversation summary: prompt_rules is active.",
              threadId: "prompt_rules",
              mentionedThreadIds: ["oauth_abort_flow"],
              policyMarkers: ["closeout"],
            },
          ],
          stateContract: pairState(),
        }),
      )
      writeCase(
        canary,
        "must-clarify",
        minimalCase({ id: "must-clarify", bucket: "must_clarify" }),
      )
      writeCase(
        canary,
        "stale",
        minimalCase({ id: "stale", bucket: "stale_context_trap" }),
      )
      writeCase(
        canary,
        "wrong-thread",
        minimalCase({ id: "wrong-thread", bucket: "wrong_thread_adversarial" }),
      )
      expect(() => loadGroundingCases({ suite: "canary", casesRoot: root })).toThrow(
        "summary case must use summary_equivalence bucket",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loader rejects corpora missing critical canary bucket classes", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-critical-"))
    try {
      const canary = join(root, "canary")
      mkdirSync(canary, { recursive: true })
      writeCase(canary, "ellipsis-only", minimalCase())
      expect(() => loadGroundingCases({ suite: "canary", casesRoot: root })).toThrow(
        "missing critical must_clarify case",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loader rejects paired cases without structured history metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-pair-metadata-"))
    try {
      const canary = join(root, "canary")
      mkdirSync(canary, { recursive: true })
      writeCase(
        canary,
        "pair-raw",
        {
          ...minimalCase({
            id: "pair-raw",
            bucket: "tool_noise",
            pairId: "pair-1",
            pairRole: "raw",
            stateContract: pairState(),
          }),
          history: [{ role: "assistant", text: "Active thread prompt_rules." }],
        },
      )
      writeCase(
        canary,
        "pair-summary",
        {
          ...minimalCase({
            id: "pair-summary",
            bucket: "summary_equivalence",
            pairId: "pair-1",
            pairRole: "summary",
            stateContract: pairState(),
          }),
          history: [{ role: "assistant", text: "Conversation summary: prompt_rules is active." }],
        },
      )
      writeCase(
        canary,
        "must-clarify",
        minimalCase({ id: "must-clarify", bucket: "must_clarify" }),
      )
      writeCase(
        canary,
        "stale",
        minimalCase({ id: "stale", bucket: "stale_context_trap" }),
      )
      writeCase(
        canary,
        "wrong-thread",
        minimalCase({ id: "wrong-thread", bucket: "wrong_thread_adversarial" }),
      )
      expect(() => loadGroundingCases({ suite: "canary", casesRoot: root })).toThrow(
        "must expose structured history metadata",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("loader rejects blocking replay/adversarial fixtures without reviewed human audit", () => {
    const root = mkdtempSync(join(tmpdir(), "grounding-blocking-governance-"))
    try {
      const replay = join(root, "replay_critical")
      mkdirSync(replay, { recursive: true })
      writeCase(
        replay,
        "replay-blocking",
        minimalCase({
          id: "replay-blocking",
          corpus: "replay_critical",
          blockingEligible: true,
          sourceProvenance: {
            kind: "trajectory_freeze",
            sessionId: "session-1",
          },
          humanAudit: { status: "none" },
        }),
      )
      expect(() => loadGroundingCases({ corpus: "replay_critical", casesRoot: root })).toThrow(
        "blocking replay/adversarial fixtures require humanAudit.status=reviewed",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
