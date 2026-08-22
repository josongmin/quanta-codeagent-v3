import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import type { StreamEvent } from "@/llm"
import {
  type ActionAssessment,
  type ReviewContext,
  type ReviewerPort,
  structuredDenyReason,
  type ToolActionKeyed,
} from "@/permission"
import { RulesStore } from "@/rules"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"
import { cfg, FakeLLM, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `guardian-per-action-assessment` (ADR-0497,
 * feature 03/0497-guardian-per-action-assessment).
 *
 * THE GAP: the feature's own "e2e" hellgate
 * (`guardian-per-action-assessor-e2e-hellgate.test.ts`) drives `reviewAction()`
 * DIRECTLY — it never enters `runAgent`, so it never proves the typed verdict
 * gates a REAL tool `execute()`. `guardian-gate-wiring-hellgate.test.ts` calls
 * `runAdmissibilityGate` directly (still `runAgent == 0`). So the load-bearing
 * chain
 *
 *   scripted LLM emits tool_use
 *     → runAgent → dispatch → admissibility gate (rules `ask` + guardian tier)
 *       → reviewAction → dispatchFresh knob-branch → port.guardianAssess (SCRIPTED)
 *         → collapseAssessment → allow/deny
 *           → the tool's execute() runs, or is BLOCKED
 *
 * is unverified against the real loop. This suite closes it with GROUND TRUTH:
 * a probe tool whose `execute()` flips a flag. A guardian DENY must leave the
 * flag false (execute NEVER ran); a guardian ALLOW must set it (execute ran) —
 * a paired control that also proves the assession actually reached the loop.
 *
 * The assessor knob `QUANTA_GUARDIAN_ASSESSOR` is set ON so the guardian tier
 * routes through `port.guardianAssess` (the typed ActionAssessment path) rather
 * than the binary `guardianReview`.
 */

const MARKER = "guardianprobe"

/** A probe tool. `execute()` is observable ground-truth: it appends to `ran`
 *  ONLY when the loop actually dispatched it. `extractShellCommand` exposes the
 *  command so a rules `ask <marker>` rule matches (routing to the reviewer). */
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

/** A ReviewerPort whose SCRIPTED `guardianAssess` returns a queued typed
 *  ActionAssessment per call. `userReview`/`autoReview`/`guardianReview` THROW
 *  so any mis-route (wrong tier, knob off) fails LOUDLY instead of silently
 *  allowing. Records how many times the assessor actually fired. */
const scriptedAssessorPort = (
  assessments: ActionAssessment[],
): { port: ReviewerPort; calls: () => number } => {
  let n = 0
  const queue = [...assessments]
  const port: ReviewerPort = {
    userReview: async () => {
      throw new Error("userReview must NOT fire on the guardian-assessor path")
    },
    autoReview: async () => {
      throw new Error("autoReview must NOT fire on the guardian-assessor path")
    },
    guardianReview: async () => {
      throw new Error("binary guardianReview must NOT fire when the assessor knob is ON")
    },
    guardianAssess: async (_action: ToolActionKeyed, _ctx: ReviewContext) => {
      n += 1
      const next = queue.shift() ?? queue[queue.length - 1]
      if (next === undefined) throw new Error("assessor script exhausted")
      return next
    },
  }
  return { port, calls: () => n }
}

const allow = (): ActionAssessment => ({
  kind: "allow",
  rationale: "probe is safe in this test",
  riskLevel: "low",
})

const deny = (): ActionAssessment => ({
  kind: "deny",
  rationale: "probe denied by scripted guardian",
  denyReason: structuredDenyReason({ layer: "reviewer", safeReason: "scripted guardian deny" }),
})

const drive = async (
  assessments: ActionAssessment[],
  llmScripts: StreamEvent[][],
): Promise<{ ran: string[]; reason: string; assessorCalls: number }> => {
  const ran: string[] = []
  const { port, calls } = scriptedAssessorPort(assessments)
  const rules = new RulesStore()
  rules.loadLayer("user", `ask ${MARKER}\n`, "user.rules")
  const out = await withTimeout(
    runAgent(
      cfg({
        llm: new FakeLLM(llmScripts),
        stream: new RecordingStream(),
        registry: new ToolRegistry([makeProbeTool(ran)]),
        // bypass mode: no mode-policy deny — the ONLY gate that decides the
        // probe is the rules `ask` → guardian assessor path we are testing.
        permission: { mode: "bypass" },
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        maxTurns: 6,
        admissibility: {
          rulesStore: rules,
          reviewerPort: port,
          defaultReviewer: "guardian_subagent",
          decidedAt: () => 1,
        },
      }),
    ),
    15_000,
    "guardian-assessment-real-loop",
  )
  return { ran, reason: out.reason, assessorCalls: calls() }
}

describe("guardian per-action assessment — real loop, typed verdict gates execute()", () => {
  beforeEach(() => {
    process.env.QUANTA_GUARDIAN_ASSESSOR = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_GUARDIAN_ASSESSOR
    __resetRuntimeConfig()
  })

  test("guardian ALLOW ⇒ the tool's execute() ACTUALLY RUNS (ground truth)", async () => {
    const { ran, reason, assessorCalls } = await drive(
      [allow()],
      [probeCall("t1", `${MARKER} do-thing`), text("done")],
    )
    // The typed assessor fired inside the real loop (not a shim).
    expect(assessorCalls).toBe(1)
    // GROUND TRUTH: the probe's execute() ran, exactly once, with our command.
    expect(ran).toEqual([`${MARKER} do-thing`])
    expect(reason).toBe("completed")
  })

  test("guardian DENY ⇒ the tool's execute() is BLOCKED — never runs (paired control)", async () => {
    const { ran, reason, assessorCalls } = await drive(
      [deny()],
      [probeCall("t1", `${MARKER} do-thing`), text("done")],
    )
    // The assessor still fired — the deny came from the VERDICT, not from the
    // guardian being skipped.
    expect(assessorCalls).toBe(1)
    // GROUND TRUTH: execute() NEVER ran. This is the load-bearing gate assertion
    // — a DENY verdict actually stops the real dispatch, not merely a decision.
    expect(ran).toEqual([])
    expect(reason).toBe("completed")
  })

  test("DENY-then-ALLOW across two calls ⇒ only the ALLOWED call's execute() runs (non-vacuous)", async () => {
    // Two distinct commands so the allowlist-escalation cache (absent here) can
    // never mask the second review; each call re-consults the scripted guardian.
    const { ran, reason, assessorCalls } = await drive(
      [deny(), allow()],
      [
        probeCall("t1", `${MARKER} first-denied`),
        probeCall("t2", `${MARKER} second-allowed`),
        text("done"),
      ],
    )
    expect(assessorCalls).toBe(2)
    // The denied command's execute() never ran; the allowed one's did.
    expect(ran).toEqual([`${MARKER} second-allowed`])
    expect(reason).toBe("completed")
  })

  test("KNOB OFF ⇒ the typed assessor is NEVER reached; execute() stays blocked even for an ALLOW assessment (byte-identical binary path)", async () => {
    // Turn the knob OFF for this case only. `dispatchFresh` must route the
    // guardian tier to the BINARY `guardianReview` (which our port throws on),
    // NOT the typed assessor — so even a scripted `allow()` cannot loosen the
    // gate. The throw fails CLOSED, blocking execute(). This is the OFF
    // byte-identity + red-on-injection guard in ONE assertion, at the loop level.
    delete process.env.QUANTA_GUARDIAN_ASSESSOR
    __resetRuntimeConfig()
    const { ran, reason, assessorCalls } = await drive(
      [allow()],
      [probeCall("t1", `${MARKER} do-thing`), text("done")],
    )
    // The typed assessor was PROVABLY never invoked (the knob gates it).
    expect(assessorCalls).toBe(0)
    // GROUND TRUTH: execute() never ran — the binary path fail-closed (its
    // servicer threw), so the "allow" assessment had no effect.
    expect(ran).toEqual([])
    expect(reason).toBe("completed")
  })
})
