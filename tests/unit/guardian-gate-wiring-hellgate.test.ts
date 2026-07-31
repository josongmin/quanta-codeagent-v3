/**
 * WIRING-PROOF — T03 guardian reviewer through the REAL admissibility gate
 * (feature `03-guardian-auto-approval-reviewer`).
 *
 * The unit hellgates pin `reviewAction`/`selectDefaultReviewer` in isolation.
 * This proves the LINK that makes the feature non-inert: a gate opts
 * `defaultReviewer: "guardian_subagent"` (what `compose` derives from
 * `QUANTA_AUTO_REVIEW` / the ladder) actually reaches `ctx.configReviewer` so the
 * gate dispatches to `guardianReview` — NOT `userReview` — and admits the call
 * when the guardian approves. It also proves the dispatch `call.id` reaches
 * `ctx.toolCallId`, so the delta-3 auto-review notice keys to the right tool call.
 *
 * (Mirrors the helper fakes in `admissibility-hellgate.test.ts` — intentionally
 * duplicated, not imported; those are test files, not modules.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import {
  __resetAutoApprovalReviewObserver,
  __resetDefaultPermissionStore,
  type AutoApprovalReviewEvent,
  type PermissionContext,
  type ReviewContext,
  type ReviewerPort,
  setAutoApprovalReviewObserver,
  type ToolActionKeyed,
} from "@/permission"
import { RulesStore } from "@/rules"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

const bashSchema = z.object({ command: z.string() })

const bashWithShell: Tool = {
  name: "bash",
  description: "bash tool",
  inputSchema: bashSchema as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
}
;(
  bashWithShell as Tool & { extractShellCommand: (i: unknown) => string | null }
).extractShellCommand = (i) => (i as { command: string }).command

const call = (input: unknown, id = "cWIRE"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "bash",
  input,
})

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "bypass" } as PermissionContext,
    ...over,
  }) as AgentConfig

const actionOf = (input: unknown): AdmissibilityAction => ({
  tool: "bash",
  input,
  isReadOnly: false,
})

const loadedStore = (lines: string): RulesStore => {
  const s = new RulesStore()
  s.loadLayer("user", lines, "user.rules")
  return s
}

/** A reviewer port whose guardianReview records + decides; userReview/autoReview
 *  THROW so any mis-route fails loudly rather than silently passing. */
const recordingGuardianPort = (
  approve: boolean,
): { port: ReviewerPort; guardianCalls: () => number } => {
  let n = 0
  const port: ReviewerPort = {
    userReview: async () => {
      throw new Error("userReview must NOT be called when defaultReviewer=guardian_subagent")
    },
    autoReview: async () => {
      throw new Error("autoReview must NOT be called")
    },
    guardianReview: async (_action: ToolActionKeyed, ctx: ReviewContext) => {
      n += 1
      return {
        reviewer: "guardian_subagent" as const,
        outcome: approve ? ("guardian_approved" as const) : ("guardian_denied" as const),
        riskLevel: "low" as const,
        rationale: approve ? "safe" : "unsafe",
        decidedAt: ctx.decidedAt,
      }
    },
  }
  return { port, guardianCalls: () => n }
}

beforeEach(() => {
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  __resetAutoApprovalReviewObserver()
})
afterEach(() => {
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  __resetAutoApprovalReviewObserver()
})

describe("WIRING — opts.defaultReviewer='guardian_subagent' routes the gate to the guardian", () => {
  test("guardian approves ⇒ gate ADMITS (null), guardianReview called, userReview never", async () => {
    const { port, guardianCalls } = recordingGuardianPort(true)
    const input = { command: "git push --tags" }
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "guardian_subagent",
      decidedAt: () => 1,
    }
    const res = await runAdmissibilityGate(
      call(input),
      cfg({ registry: new ToolRegistry([bashWithShell]) }),
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )
    expect(guardianCalls()).toBe(1) // ← opts.defaultReviewer reached ctx.configReviewer
    expect(res).toBeNull() // guardian approval ⇒ admit, dispatch proceeds
  })

  test("guardian denies ⇒ gate BLOCKS (deny result), still via guardianReview", async () => {
    const { port, guardianCalls } = recordingGuardianPort(false)
    const input = { command: "git push --tags" }
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "guardian_subagent",
      decidedAt: () => 1,
    }
    const res = await runAdmissibilityGate(
      call(input),
      cfg({ registry: new ToolRegistry([bashWithShell]) }),
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )
    expect(guardianCalls()).toBe(1)
    expect(res).not.toBeNull() // a deny result short-circuits dispatch
  })

  test("the dispatch call.id reaches the auto-review notice (delta-3 gate wiring)", async () => {
    const events: AutoApprovalReviewEvent[] = []
    setAutoApprovalReviewObserver({ observe: (e) => events.push(e) })
    const { port } = recordingGuardianPort(true)
    const input = { command: "git push --tags" }
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: loadedStore("ask git push\n"),
      reviewerPort: port,
      defaultReviewer: "guardian_subagent",
      decidedAt: () => 1,
    }
    await runAdmissibilityGate(
      call(input, "call_specific_42"),
      cfg({ registry: new ToolRegistry([bashWithShell]) }),
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.every((e) => e.toolCallId === "call_specific_42")).toBe(true)
    expect(events.map((e) => e.phase)).toContain("completed")
  })
})
