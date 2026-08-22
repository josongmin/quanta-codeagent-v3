import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import type { StreamEvent } from "@/llm"
import type { ApprovalDecision, ReviewContext, ReviewerPort, ToolActionKeyed } from "@/permission"
import { RulesStore } from "@/rules"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"
import { cfg, FakeLLM, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the ADR-0070 `allowlistEscalated` grant/revoke
 * cadence across the auto-review reviewer tier.
 *
 * WHAT THIS ACTUALLY COVERS (title honesty): NOT the ADR-0135
 * `createApprovalReviewer` periodic ledger — that pure data structure has NO
 * loop hookup (its own coverage is the unit suite in
 * `tests/unit/permission-pillars.test.ts`) and it is NEVER touched here. The
 * WIRED seam this drives is the run-scoped `allowlistEscalated` cache
 * (ADR-0070): the admissibility gate consults the auto-review reviewer for a
 * verdict, and a GRANT is remembered in that `Set<string>` so a re-issued
 * identical action is NOT re-reviewed — until the grant is REVOKED (cache
 * cleared), which forces a re-consult.
 *
 * THE GAP this closes: every guardian/auto-review test drives `reviewAction()` /
 * `runAdmissibilityGate` DIRECTLY (`runAgent == 0`). The behavior that MATTERS
 * across N tool calls — the reviewer grants, the `allowlistEscalated` grant
 * makes a re-issued action skip re-review, and, when that grant is REVOKED, the
 * gate re-consults and can DENY the next same call — was never exercised through
 * the real loop.
 *
 * This drives several tool calls through `runAgent` with an AUTO-tier reviewer
 * (`defaultReviewer: "auto_review"`) wired to a SCRIPTED verdict, and the
 * run-scoped `allowlistEscalated` cache (the mechanism that makes a grant
 * "stick" across calls). We assert, with GROUND TRUTH (did `execute()` run?):
 *
 *   1. CADENCE — the reviewer fires on the FIRST call of a distinct action.
 *   2. GRANT STICKS — a second identical call is NOT re-reviewed (the
 *      `allowlistEscalated` grant is honored) and still runs.
 *   3. REVOKE TAKES EFFECT — after the grant is revoked (cache cleared), the
 *      next identical call RE-CONSULTS the reviewer, whose scripted DENY BLOCKS
 *      the real `execute()`.
 *
 * The auto-review reviewer's verdict is what closes/opens the gate — proving the
 * `allowlistEscalated` grant/revoke cadence has teeth against real dispatch.
 */

const MARKER = "autoreview"

const makeProbeTool = (ran: string[]): Tool => {
  const tool: Tool = {
    name: "probe",
    description: "probe tool",
    inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* (input: unknown) {
      ran.push((input as { command?: string }).command ?? "")
      yield { type: "result", result: { ok: true, output: "probe ran" } }
    },
  }
  ;(tool as Tool & { extractShellCommand: (i: unknown) => string | null }).extractShellCommand = (
    i,
  ) => (i as { command?: string }).command ?? null
  return tool
}

const probeCall = (id: string, command: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "probe" },
  { type: "tool_use_end", id, input: { command } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** A ReviewerPort whose SCRIPTED `autoReview` returns a queued verdict per call
 *  and records EACH action it was consulted about (so we can prove the review
 *  cadence — it fired for call N but was skipped for the cached one). Other
 *  tiers THROW so a mis-route fails loudly. */
const scriptedAutoReviewPort = (
  verdicts: ("allow" | "deny")[],
): { port: ReviewerPort; consulted: string[] } => {
  const consulted: string[] = []
  const queue = [...verdicts]
  const port: ReviewerPort = {
    userReview: async () => {
      throw new Error("userReview must NOT fire when defaultReviewer=auto_review")
    },
    guardianReview: async () => {
      throw new Error("guardianReview must NOT fire when defaultReviewer=auto_review")
    },
    autoReview: async (action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision> => {
      consulted.push(String((action.input as { command?: string }).command ?? action.tool))
      const verdict = queue.shift() ?? queue[queue.length - 1]
      if (verdict === "allow") {
        return {
          reviewer: "auto_review",
          outcome: "config_allowed",
          riskLevel: "high",
          rationale: "scripted auto-review allow",
          decidedAt: ctx.decidedAt,
        }
      }
      return {
        reviewer: "auto_review",
        outcome: "user_denied",
        riskLevel: "high",
        rationale: "scripted auto-review deny (grant revoked)",
        decidedAt: ctx.decidedAt,
      }
    },
  }
  return { port, consulted }
}

interface DriveHooks {
  /** Invoked BEFORE the loop dispatches the given command (matched by suffix),
   *  so a test can mutate the shared cache mid-run (revoke a grant). */
  onBeforeCommand?: (command: string, cache: Set<string>) => void
}

const drive = async (
  verdicts: ("allow" | "deny")[],
  llmScripts: StreamEvent[][],
  hooks: DriveHooks = {},
): Promise<{ ran: string[]; reason: string; consulted: string[]; cache: Set<string> }> => {
  const ran: string[] = []
  const { port, consulted } = scriptedAutoReviewPort(verdicts)
  const rules = new RulesStore()
  rules.loadLayer("user", `ask ${MARKER}\n`, "user.rules")
  // The run-scoped grant cache — the mechanism that makes an auto-review grant
  // "stick" across subsequent identical calls (ADR-0070 allowlist_escalated).
  const cache = new Set<string>()

  // Wrap the probe tool so a test hook can fire immediately before a specific
  // command's dispatch (to model an out-of-band grant revocation).
  const baseTool = makeProbeTool(ran)
  const tool: Tool = {
    ...baseTool,
    execute: async function* (input: unknown, ctxArg) {
      const command = (input as { command?: string }).command ?? ""
      hooks.onBeforeCommand?.(command, cache)
      yield* baseTool.execute(input as never, ctxArg)
    },
  }
  ;(tool as Tool & { extractShellCommand: (i: unknown) => string | null }).extractShellCommand = (
    baseTool as Tool & { extractShellCommand: (i: unknown) => string | null }
  ).extractShellCommand

  const out = await withTimeout(
    runAgent(
      cfg({
        llm: new FakeLLM(llmScripts),
        stream: new RecordingStream(),
        registry: new ToolRegistry([tool]),
        permission: { mode: "bypass" },
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        maxTurns: 8,
        admissibility: {
          rulesStore: rules,
          reviewerPort: port,
          defaultReviewer: "auto_review",
          allowlistEscalated: cache,
          decidedAt: () => 1,
        },
      }),
    ),
    15_000,
    "auto-approval-review-real-loop",
  )
  return { ran, reason: out.reason, consulted, cache }
}

describe("ADR-0070 allowlistEscalated — real loop grant/revoke cadence gates execute()", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("CADENCE: the auto-reviewer fires on EACH distinct tool call across N calls; ALLOW/DENY gate each execute()", async () => {
    // Three DISTINCT actions ⇒ three distinct review rounds (the "review across
    // N tool calls" cadence). Scripted verdicts allow → deny → allow.
    const { ran, reason, consulted } = await drive(
      ["allow", "deny", "allow"],
      [
        probeCall("t1", `${MARKER} A`),
        probeCall("t2", `${MARKER} B`),
        probeCall("t3", `${MARKER} C`),
        text("done"),
      ],
    )
    // The reviewer fired on all three (cadence = per distinct action).
    expect(consulted).toEqual([`${MARKER} A`, `${MARKER} B`, `${MARKER} C`])
    // GROUND TRUTH: the two ALLOWs ran; the middle DENY blocked its execute().
    // A paired control in ONE run — the verdict, not the call order, decides.
    expect(ran).toEqual([`${MARKER} A`, `${MARKER} C`])
    expect(reason).toBe("completed")
  })

  test("GRANT STICKS: a second identical call is NOT re-reviewed but still runs", async () => {
    // Only ONE allow scripted; if the 2nd call re-consulted the reviewer the
    // queue would still serve allow, so the discriminator is `consulted.length`.
    const { ran, reason, consulted } = await drive(
      ["allow"],
      [probeCall("t1", `${MARKER} step`), probeCall("t2", `${MARKER} step`), text("done")],
    )
    // The reviewer was consulted EXACTLY ONCE across two identical calls — the
    // recorded grant is honored on the second (periodic-review cadence: a
    // remembered auto-grant is not re-prompted).
    expect(consulted).toEqual([`${MARKER} step`])
    // Both calls ran (the grant is real, not a one-shot).
    expect(ran).toEqual([`${MARKER} step`, `${MARKER} step`])
    expect(reason).toBe("completed")
  })

  test("REVOKE TAKES EFFECT: after the grant is revoked, the next same call re-prompts AND its DENY blocks execute()", async () => {
    // Two identical calls to the SAME action key.
    //   · call 1: reviewer ALLOWs ⇒ grant recorded in the cache ⇒ execute runs.
    //     DURING call 1's execute we REVOKE (clear the cache) — modeling the
    //     periodic review deciding the policy is no longer OK.
    //   · call 2: the stale grant is gone, so the gate RE-CONSULTS the reviewer,
    //     whose scripted DENY must BLOCK the real execute().
    // (Only 2 identical calls: a 3rd identical call is eaten by the loop's
    // repeated-tool-call suppression, which is orthogonal to the review gate —
    // see the distinct-command cadence test above for N>2.)
    let revoked = false
    const { ran, reason, consulted } = await drive(
      ["allow", "deny"],
      [probeCall("t1", `${MARKER} step`), probeCall("t2", `${MARKER} step`), text("done")],
      {
        onBeforeCommand: (_command, cache) => {
          // Fire during call 1's execute (the grant is already in the cache),
          // which runs BEFORE call 2's gate. Revoke exactly once.
          if (!revoked && cache.size > 0) {
            cache.clear()
            revoked = true
          }
        },
      },
    )
    // The reviewer was consulted TWICE for the SAME key: the initial grant, then
    // AGAIN after revocation. Without the revoke, call 2 would ride the cached
    // grant and the reviewer would fire only once (see GRANT STICKS above).
    expect(consulted).toEqual([`${MARKER} step`, `${MARKER} step`])
    // GROUND TRUTH: only the first (granted) call ran; the post-revocation DENY
    // blocked the second `execute()`. The reviewer's revoked verdict has teeth
    // against real dispatch.
    expect(ran).toEqual([`${MARKER} step`])
    expect(reason).toBe("completed")
  })
})
