/**
 * ROUND-4 concurrency hellgate (follow-up) — admissibility-gate reviewer
 * coalescing per `actionKey`.
 *
 * THE BUG (round-4 audit finding, report-only until this fix):
 * `reviewAndDecide` did a check-then-act on the caller-owned per-run
 * `allowlistEscalated` Set ACROSS the `await gate.open(...)` (reviewer prompt)
 * boundary:
 *     miss `has(actionKey)`  →  await reviewer prompt  →  `add(actionKey)`
 * Two structurally-equivalent tool calls with the SAME `actionKey`, dispatched
 * concurrently (a concurrency-safe tool that escalates via a rule-ask /
 * always-confirm tier early-dispatches in-flight — see streaming-dispatch),
 * BOTH pass the `has` miss before either reaches `add`, so BOTH pop a reviewer
 * prompt — defeating the dedup the Set is supposed to provide.
 *
 * THE FIX (Approach A — pending-promise map keyed in a WeakMap on the run's
 * `allowlistEscalated` Set): the first caller for an actionKey stores the
 * reviewer promise BEFORE awaiting; concurrent siblings await the SAME promise.
 *
 * RED (pre-fix): 2 reviewer prompts for 2 concurrent same-key callers.
 * GREEN (post-fix): EXACTLY 1 prompt; both callers get the same decision; on
 * approve the allowlist holds the key once.
 *
 * Negative control: two concurrent callers with DIFFERENT actionKeys ⇒ 2
 * prompts (no false coalesce).
 *
 * Source under test: src/agent/admissibility-gate.ts (runAdmissibilityGate →
 * reviewAndDecide). Helpers/fakes mirror admissibility-hellgate.test.ts
 * (intentionally duplicated — those are test files, not modules).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { createRunLedger } from "@/agent/run-ledger"
import type { ToolUseBlock } from "@/llm"
import { createObjectiveStore } from "@/objective"
import type {
  ApprovalDecision,
  PermissionContext,
  ReviewContext,
  ReviewerPort,
  ToolActionKeyed,
} from "@/permission"
import { RulesStore } from "@/rules"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// ── tool / config fakes (mirror admissibility-hellgate.test.ts) ──────────────
const bashSchema = z.object({ command: z.string() })

const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    extractShellCommand?: (input: unknown) => string | null
  } = {},
): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }
  if (opts.extractShellCommand) {
    ;(
      tool as Tool & { extractShellCommand: (input: unknown) => string | null }
    ).extractShellCommand = opts.extractShellCommand
  }
  return tool
}

// A read-only (concurrency-safe) bash-like tool whose actionKey is
// `bash|<command>` — the exact reachable shape from the audit finding (a
// concurrency-safe tool that escalates via always-confirm on an identical key).
const bashRO = makeTool("bash", {
  readOnly: true,
  schema: bashSchema,
  extractShellCommand: (input) => (input as { command: string }).command,
})

const call = (input: unknown, id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "bash",
  input,
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

// A rule store with `ask git` — the rule-DSL `ask` arm routes to
// `reviewAndDecide(origin="rule")`, the exact escalation path the audit
// flagged for a concurrency-safe tool. Even under bypass mode the reviewer is
// consulted (rule beats mode policy).
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

// ── a DEFERRED reviewer that parks until the test releases it ────────────────
// Counts userReview invocations (== reviewer prompts) and lets the test hold
// two callers in-flight simultaneously before any resolves.
const mkDeferredReviewer = (outcome: ApprovalDecision["outcome"]) => {
  let prompts = 0
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const port: ReviewerPort = {
    userReview: async (action: ToolActionKeyed, _ctx: ReviewContext): Promise<ApprovalDecision> => {
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

const waveOf = (
  reviewer: ReturnType<typeof mkDeferredReviewer>,
  allowlistEscalated: Set<string> | undefined,
): AdmissibilityWaveAOptions => ({
  rulesStore: askGitStore(),
  reviewerPort: reviewer.port,
  defaultReviewer: "user",
  decidedAt: () => 1,
  ...(allowlistEscalated !== undefined ? { allowlistEscalated } : {}),
})

describe("ROUND-4 admissibility — concurrent reviewer coalescing per actionKey", () => {
  test("two concurrent SAME-key callers ⇒ EXACTLY ONE reviewer prompt (approve)", async () => {
    const reviewer = mkDeferredReviewer("user_approved")
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const input = { command: "git status" }
    const wave = waveOf(reviewer, allowlistEscalated)

    // Two structurally-equivalent calls (same actionKey `bash|git status`),
    // dispatched concurrently — both reach reviewAndDecide before either settles.
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
    // GREEN: the coalesce holds the second caller on the SAME in-flight promise.
    // (Pre-fix this was 2 — both popped a prompt.)
    expect(reviewer.prompts()).toBe(1)

    reviewer.release()
    const [ra, rb] = await Promise.all([a, b])

    // Both admitted (null = pass to execute). Same decision for both callers.
    expect(ra).toBeNull()
    expect(rb).toBeNull()
    // Still exactly one prompt after settle.
    expect(reviewer.prompts()).toBe(1)
    // Allowlist holds the key exactly once (Set idempotency under both adds).
    expect([...allowlistEscalated]).toEqual(["bash|git status"])
  })

  test("two concurrent SAME-key callers ⇒ ONE prompt; both DENIED identically", async () => {
    const reviewer = mkDeferredReviewer("user_denied")
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const input = { command: "git commit -m wip" }
    const wave = waveOf(reviewer, allowlistEscalated)

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
    expect(reviewer.prompts()).toBe(1)

    reviewer.release()
    const [ra, rb] = await Promise.all([a, b])

    // Both denied (non-null result). Denial must NOT poison the allowlist.
    expect(ra).not.toBeNull()
    expect(rb).not.toBeNull()
    expect(ra?.block.content).toContain("User declined")
    expect(rb?.block.content).toContain("User declined")
    expect(reviewer.prompts()).toBe(1)
    expect(allowlistEscalated.size).toBe(0)
  })

  test("negative control: two concurrent DIFFERENT-key callers ⇒ TWO prompts (no false coalesce)", async () => {
    const reviewer = mkDeferredReviewer("user_approved")
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const inA = { command: "git status" }
    const inB = { command: "git diff" }
    const wave = waveOf(reviewer, allowlistEscalated)

    const a = runAdmissibilityGate(
      call(inA, "c1"),
      c,
      { mode: "bypass" },
      actionOf(inA),
      undefined,
      wave,
    )
    const b = runAdmissibilityGate(
      call(inB, "c2"),
      c,
      { mode: "bypass" },
      actionOf(inB),
      undefined,
      wave,
    )

    await settle()
    // Distinct actionKeys ⇒ no coalesce ⇒ two prompts.
    expect(reviewer.prompts()).toBe(2)

    reviewer.release()
    await Promise.all([a, b])
    expect(reviewer.prompts()).toBe(2)
    expect([...allowlistEscalated].sort()).toEqual(["bash|git diff", "bash|git status"])
  })

  test("LATER post-settle SAME-key call behaves as today (escalation cache hit ⇒ no prompt)", async () => {
    const reviewer = mkDeferredReviewer("user_approved")
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const input = { command: "git status" }
    const wave = waveOf(reviewer, allowlistEscalated)

    // First call fully settles (reviewer runs once, key recorded).
    const a = runAdmissibilityGate(
      call(input, "c1"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )
    await settle()
    reviewer.release()
    expect(await a).toBeNull()
    expect(reviewer.prompts()).toBe(1)

    // A LATER call for the same key now hits the allowlistEscalated cache and is
    // admitted WITHOUT a new prompt — byte-identical to the pre-fix dedup intent.
    const later = await runAdmissibilityGate(
      call(input, "c3"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )
    expect(later).toBeNull()
    expect(reviewer.prompts()).toBe(1)
  })

  test("abort during a coalesced review propagates to ALL waiters", async () => {
    // The reviewer throws — both the originator and the coalesced sibling must
    // see the SAME rejection (no waiter silently resolves to an allow).
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let prompts = 0
    const port: ReviewerPort = {
      userReview: async (): Promise<ApprovalDecision> => {
        prompts += 1
        await gate
        throw new Error("aborted-mid-review")
      },
      autoReview: async () => {
        throw new Error("unused")
      },
      guardianReview: async () => {
        throw new Error("unused")
      },
    }
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const input = { command: "git status" }
    const wave: AdmissibilityWaveAOptions = {
      rulesStore: askGitStore(),
      reviewerPort: port,
      defaultReviewer: "user",
      decidedAt: () => 1,
      allowlistEscalated,
    }

    // Attach the settle-capture eagerly (BEFORE release) so neither rejection is
    // ever momentarily unhandled — both waiters share the one rejecting promise.
    const aSettled = runAdmissibilityGate(
      call(input, "c1"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    ).then(
      () => ({ ok: true }) as const,
      (e: unknown) => ({ ok: false, msg: (e as Error).message }) as const,
    )
    const bSettled = runAdmissibilityGate(
      call(input, "c2"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    ).then(
      () => ({ ok: true }) as const,
      (e: unknown) => ({ ok: false, msg: (e as Error).message }) as const,
    )
    await settle()
    expect(prompts).toBe(1)
    release()

    const ra = await aSettled
    const rb = await bSettled
    expect(ra.ok).toBe(false)
    expect(rb.ok).toBe(false)
    expect(ra.ok === false && ra.msg).toContain("aborted-mid-review")
    expect(rb.ok === false && rb.msg).toContain("aborted-mid-review")
    // Throw must NOT poison the allowlist, and the in-flight entry must clear so
    // a retry re-prompts.
    expect(allowlistEscalated.size).toBe(0)
    const retry = mkDeferredReviewer("user_approved")
    const retryWave = waveOf(retry, allowlistEscalated)
    const r = runAdmissibilityGate(
      call(input, "c4"),
      c,
      { mode: "bypass" },
      actionOf(input),
      undefined,
      retryWave,
    )
    await settle()
    expect(retry.prompts()).toBe(1)
    retry.release()
    expect(await r).toBeNull()
  })

  test("pending reviewer is visible in the live approval, objective, and ledger projections", async () => {
    const objective = createObjectiveStore()
    const ledger = createRunLedger()
    const approvalStateMachine = createApprovalStateMachine({ objective, ledger })
    objective.create("sess-1", { goal: "complete safely" })
    const reviewer = mkDeferredReviewer("user_approved")
    const input = { command: "git status" }
    const wave = { ...waveOf(reviewer, undefined), approvalStateMachine }
    const p = runAdmissibilityGate(
      call(input, "approval-live"),
      cfg({ approvalStateMachine }),
      { mode: "bypass" },
      actionOf(input),
      undefined,
      wave,
    )

    await settle()

    // ★ CONTRACT: request precedes the unresolved reviewer promise.
    const pending = approvalStateMachine.pending()
    expect(pending).toHaveLength(1)
    const approval = pending[0]
    expect(approval?.status).toBe("pending")
    expect(objective.get("sess-1")?.blockers).toHaveLength(1)
    expect(ledger.waiting()).toHaveLength(1)
    expect(ledger.get(approval?.id ?? "")?.status).toBe("waiting")

    reviewer.release()
    expect(await p).toBeNull()

    // ★ CONTRACT: terminal approval settles the same record and clears both projections.
    expect(approvalStateMachine.get(approval?.id ?? "")?.status).toBe("approved")
    expect(objective.get("sess-1")?.blockers).toHaveLength(0)
    expect(ledger.get(approval?.id ?? "")?.status).toBe("completed")
  })
})
