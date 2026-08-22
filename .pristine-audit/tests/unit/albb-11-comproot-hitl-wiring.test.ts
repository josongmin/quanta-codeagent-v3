/**
 * ALBB-11 — HITL admissibility PRODUCTION WIRING hellgate.
 *
 * Two inert wires activated (both default-OFF / absent ⇒ byte-identical legacy):
 *
 *   (1) `allowlistEscalated` is never minted by the LIVE producer. Every dedup /
 *       coalesce guard in hitl.ts is `?.`/`!== undefined`-gated on the Set's
 *       PRESENCE, so with the Set absent the reviewer re-prompts on every
 *       structurally-equivalent escalation. The SOLE live producer of the
 *       `config.admissibility` bundle is `buildAdmissibility`
 *       (runtime-context-compose.ts). This test drives the REAL producer (NOT a
 *       hand-passed Set) and asserts the mint + the coalesce effect.
 *
 *   (2) The approval-state-machine (ASM) is attached to TOP-LEVEL `config`
 *       (observability-wire.ts) but `dispatch.ts` spread only the `admissibility`
 *       sub-bundle, and the bundle type omits ASM — so `opts.approvalStateMachine`
 *       was always undefined on the live dispatch path and `request`/`settle`
 *       never fired. This test dispatches a real tool through a config carrying a
 *       spy ASM and asserts it fires once per escalation.
 *
 * RED-ON-INJECTION (proof the assertions are load-bearing, not vacuous):
 *   - (a) delete `const allowlistEscalated = new Set()` in buildAdmissibility ⇒
 *         `bundle.allowlistEscalated` is undefined ⇒ two concurrent same-key
 *         callers pop TWO reviewer prompts ⇒ test fails.
 *   - (b) remove the `dispatch.ts` ASM spread ⇒ `opts.approvalStateMachine` is
 *         undefined ⇒ the ASM spy is never called ⇒ test fails.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import type { ApprovalRequest, ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import { dispatchTool } from "@/agent/dispatch"
import { buildAdmissibility } from "@/apps/cli/repl/runtime-context-compose"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { ToolUseBlock } from "@/llm"
import type {
  PermissionContext,
  ReviewContext,
  ApprovalDecision as ReviewerApprovalDecision,
  ReviewerPort,
  ToolActionKeyed,
} from "@/permission"
import { RulesStore } from "@/rules"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// ── fakes (mirror admissibility-gate-coalesce-r4-followup-hellgate.test.ts) ──
const bashSchema = z.object({ command: z.string() })

const bashRO: Tool = {
  name: "bash",
  description: "bash tool",
  inputSchema: bashSchema as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
}
;(bashRO as Tool & { extractShellCommand: (input: unknown) => string | null }).extractShellCommand =
  (input) => (input as { command: string }).command

const call = (input: unknown, id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "bash",
  input,
})

const askGitStore = (): RulesStore => {
  const s = new RulesStore()
  s.loadLayer("user", "ask git\n", "user.rules")
  return s
}

const actionOf = (input: unknown): AdmissibilityAction => ({
  tool: "bash",
  input,
  isReadOnly: true,
})

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    sessionId: "sess-1",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "bypass" } as PermissionContext,
    registry: new ToolRegistry([bashRO]),
    ...over,
  }) as AgentConfig

// A DEFERRED reviewer that parks until released — counts prompts so we can hold
// two callers in-flight simultaneously and prove the coalesce.
const mkDeferredReviewer = (outcome: ReviewerApprovalDecision["outcome"]) => {
  let prompts = 0
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const port: ReviewerPort = {
    userReview: async (
      action: ToolActionKeyed,
      _ctx: ReviewContext,
    ): Promise<ReviewerApprovalDecision> => {
      prompts += 1
      await gate
      return {
        reviewer: "user",
        outcome,
        riskLevel: "high",
        rationale: `reviewed ${action.actionKey}`,
        decidedAt: 1,
      }
    },
    autoReview: async () => {
      throw new Error("autoReview should not be called")
    },
    guardianReview: async () => {
      throw new Error("guardianReview should not be called")
    },
  }
  return { port, release: () => release(), prompts: () => prompts }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0))
}

// Minimal boot stub: buildAdmissibility (all knobs default-OFF) touches only
// sessionId, mode, abort.signal, and — via a materializeReviewerAgent that
// returns undefined — never invokes the guardian-create factories.
const bootStub = (): SessionBootstrapResult =>
  ({
    sessionId: "sess-1",
    mode: "bypass",
    abort: new AbortController(),
    createSubagentBackedGuardianReview: () => {
      throw new Error("guardian review factory should not be called")
    },
    createSubagentBackedGuardianAssess: () => {
      throw new Error("guardian assess factory should not be called")
    },
  }) as unknown as SessionBootstrapResult

describe("ALBB-11 — comp-root HITL wiring (allowlistEscalated + ASM)", () => {
  test("(a) buildAdmissibility mints a Set ⇒ two concurrent same-key escalations coalesce to ONE prompt", async () => {
    const reviewer = mkDeferredReviewer("user_approved")
    // Drive the REAL live producer. The Set is minted by production code here,
    // NOT hand-passed by the test.
    const bundle = buildAdmissibility({
      boot: bootStub(),
      onConfirm: async () => true,
      sandboxProfile: "workspace-write" as never,
      permissionStore: undefined,
      autoReview: undefined,
      materializeReviewerAgent: () => undefined,
    })

    // The bundle type (RuntimeContextSnapshot["admissibility"]) is optional; the
    // live producer always returns one. Narrow so the field reads below typecheck.
    expect(bundle).toBeDefined()
    if (bundle === undefined) throw new Error("buildAdmissibility returned undefined")

    // Assertion 1 (red-on-injection: delete the mint ⇒ this is undefined).
    expect(bundle.allowlistEscalated).toBeInstanceOf(Set)

    // Fire two structurally-equivalent (same actionKey `bash|git status`) gate
    // calls concurrently, THROUGH the production bundle's Set. The reviewerPort
    // is our prompt-counting deferred spy (the bundle's own reviewer is the
    // onConfirm-backed one; we override it here so we can count prompts).
    const input = { command: "git status" }
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: askGitStore(),
      reviewerPort: reviewer.port,
      defaultReviewer: "user",
      decidedAt: () => 1,
      ...(bundle.allowlistEscalated !== undefined
        ? { allowlistEscalated: bundle.allowlistEscalated }
        : {}),
    }
    const c = cfg()

    const a = runAdmissibilityGate(
      call(input, "c1"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )
    const b = runAdmissibilityGate(
      call(input, "c2"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )

    await settle()
    // Assertion 2 (red-on-injection: undefined Set ⇒ legacy path ⇒ 2 prompts).
    expect(reviewer.prompts()).toBe(1)

    reviewer.release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBeNull()
    expect(rb).toBeNull()
    expect(reviewer.prompts()).toBe(1)
    // The production Set recorded the approved key exactly once.
    expect([...(bundle.allowlistEscalated ?? [])]).toEqual(["bash|git status"])
  })

  test("(b) ASM threaded through dispatch ⇒ request+settle fire once per reviewer escalation", async () => {
    const requests: ApprovalRequest[] = []
    const settles: Array<{ id: string; decision: string }> = []
    let seq = 0
    const asmSpy: ApprovalStateMachinePort = {
      request: (req) => {
        const rec = {
          id: `appr-${++seq}`,
          threadId: req.threadId,
          kind: req.kind,
          reason: req.reason,
          proposedAction: req.proposedAction,
          resumeStep: req.resumeStep,
          status: "pending",
          createdAt: 1,
        } as ApprovalRequest
        requests.push(rec)
        return rec
      },
      settle: (id, decision) => {
        settles.push({ id, decision })
        return null
      },
      expire: () => null,
      cancel: () => null,
      get: () => null,
      list: () => [],
      pending: () => [],
      toSnapshot: () => ({ approvals: [] }),
      fromSnapshot: () => {},
    }

    const reviewer = mkDeferredReviewer("user_approved")
    // A rule-`ask git` escalation reaches reviewAndDecide → createApprovalGate.
    // ASM lives on TOP-LEVEL config; dispatch must thread it into the gate opts.
    const c = cfg({
      approvalStateMachine: asmSpy,
      admissibility: {
        rulesStore: askGitStore(),
        reviewerPort: reviewer.port,
        defaultReviewer: "user",
        decidedAt: () => 1,
      },
    } as Partial<AgentConfig>)

    const input = { command: "git status" }
    const p = dispatchTool(call(input, "c1"), c, { mode: "bypass" })
    // Deferred reviewer parked ⇒ request() already fired, settle() pending.
    await settle()
    // request fires BEFORE the reviewer resolves.
    expect(requests.length).toBe(1)
    reviewer.release()
    const res = await p

    // Approved ⇒ tool executes ⇒ ok result.
    expect(res.ok).toBe(true)
    // Assertion (red-on-injection: remove the dispatch spread ⇒ opts ASM is
    // undefined ⇒ createApprovalGate no-op ⇒ zero fires).
    expect(requests.length).toBe(1)
    expect(settles.length).toBe(1)
    expect(settles[0]?.decision).toBe("approve")
    expect(requests[0]?.proposedAction).toBe("bash|git status")
  })
})
