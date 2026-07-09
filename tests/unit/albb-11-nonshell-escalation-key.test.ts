/**
 * ALBB-11 (HITL over-approval) P1-SECURITY regression hellgate — the NON-SHELL
 * escalation-key collapse.
 *
 * THE HOLE (3-round adversarial audit finding):
 * `reviewActionKeyOf` returns `${tool}|${shellCommand}` for a SHELL tool, but
 * for a NON-SHELL mutating tool (edit/write/apply_patch — no extractable shell
 * command) it returned the BARE tool name. ALBB-11 activated the run-scoped
 * `allowlistEscalated` Set. Flow: for an always-confirm tool with a wired
 * reviewer, after the user approves ONE `write {path:A}`, `add('write')`
 * records the bare key; the NEXT `write {path:B}` (a DIFFERENT action) hits
 * `has('write')` and SKIPS the reviewer entirely — a real HITL bypass. Only the
 * non-shell collapse over-approves; the shell path (`bash|<command>`) is fine.
 *
 * FIX: the escalation dedup key is now SPECIFIC for non-shell tools too — it
 * captures the mutating target/input identity via a canonical (key-order
 * independent) serialization, so two DIFFERENT non-shell actions produce
 * DIFFERENT keys (re-prompt) while two IDENTICAL ones still coalesce (one
 * prompt).
 *
 * RED (pre-fix): approve `write {path:A}` ⇒ dispatch `write {path:B}` is
 * SILENTLY admitted (reviewer NOT re-prompted).
 * GREEN (post-fix): the reviewer IS re-prompted for `write {path:B}`.
 * Paired control: identical `write {path:A}` twice ⇒ coalesced (one prompt).
 *
 * Source under test: src/agent/admissibility-gate/shared.ts::reviewActionKeyOf
 * + src/agent/admissibility-gate/hitl.ts::reviewAndDecide (allowlistEscalated).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import type {
  ApprovalDecision,
  PermissionContext,
  ReviewContext,
  ReviewerPort,
  ToolActionKeyed,
} from "@/permission"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// A NON-SHELL, mutating (non-readonly) tool declared always-confirm. It exposes
// NO `extractShellCommand`, so `resolvedShellCommand` returns null — the exact
// shape whose actionKey collapsed to the bare tool name pre-fix.
const writeTool: Tool = {
  name: "write",
  description: "write tool",
  inputSchema: z.object({ path: z.string(), contents: z.string().optional() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (): "always-confirm" => "always-confirm",
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "wrote" } }
  },
}

const call = (input: unknown, id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "write",
  input,
})

const cfg = (): AgentConfig =>
  ({
    cwd: "/repo",
    sessionId: "sess-1",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "bypass" } as PermissionContext,
    // Opt into HITL so an always-confirm tool with a wired reviewer routes to
    // reviewAndDecide (the escalation path that consults allowlistEscalated).
    hitl: { enabled: true },
    registry: new ToolRegistry([writeTool]),
  }) as AgentConfig

const actionOf = (input: unknown): AdmissibilityAction => ({
  tool: "write",
  input,
  isReadOnly: false,
})

// A reviewer that counts prompts (== HITL escalations reaching the user) and
// always approves. Every prompt is a real human-in-the-loop consultation.
const mkCountingReviewer = () => {
  let prompts = 0
  const port: ReviewerPort = {
    userReview: async (action: ToolActionKeyed, _ctx: ReviewContext): Promise<ApprovalDecision> => {
      prompts += 1
      return {
        reviewer: "user",
        outcome: "user_approved",
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
  return { port, prompts: () => prompts }
}

const waveOf = (
  reviewer: ReturnType<typeof mkCountingReviewer>,
  allowlistEscalated: Set<string>,
): AdmissibilityWaveAOptions => ({
  reviewerPort: reviewer.port,
  defaultReviewer: "user",
  decidedAt: () => 1,
  allowlistEscalated,
})

const dispatch = (
  c: AgentConfig,
  input: unknown,
  id: string,
  wave: AdmissibilityWaveAOptions,
) => runAdmissibilityGate(call(input, id), c, { mode: "bypass" }, actionOf(input), undefined, wave)

describe("ALBB-11 — non-shell escalation key must be target-specific (HITL over-approval)", () => {
  test("approving write{path:A} does NOT auto-admit write{path:B} — reviewer re-prompted", async () => {
    const reviewer = mkCountingReviewer()
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const wave = waveOf(reviewer, allowlistEscalated)

    // Approve write {path:A} — records A's key in the allowlist.
    const a = await dispatch(c, { path: "A", contents: "x" }, "c1", wave)
    expect(a).toBeNull() // admitted
    expect(reviewer.prompts()).toBe(1)

    // Dispatch write {path:B} — a DIFFERENT mutating target. Pre-fix the bare
    // 'write' key already in the allowlist SKIPPED the reviewer (silent bypass).
    // Post-fix B's distinct key MUST re-prompt.
    const b = await dispatch(c, { path: "B", contents: "y" }, "c2", wave)
    expect(b).toBeNull() // still admitted (reviewer approves) — but only AFTER a prompt
    expect(reviewer.prompts()).toBe(2)

    // Two distinct keys recorded (never the bare tool name alone).
    expect(allowlistEscalated.size).toBe(2)
    expect([...allowlistEscalated]).not.toContain("write")
  })

  test("paired control: identical write{path:A} twice ⇒ coalesced (one prompt)", async () => {
    const reviewer = mkCountingReviewer()
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const wave = waveOf(reviewer, allowlistEscalated)

    const a1 = await dispatch(c, { path: "A", contents: "x" }, "c1", wave)
    expect(a1).toBeNull()
    expect(reviewer.prompts()).toBe(1)

    // Identical action — key coalesces, allowlist cache hit ⇒ no second prompt.
    const a2 = await dispatch(c, { path: "A", contents: "x" }, "c2", wave)
    expect(a2).toBeNull()
    expect(reviewer.prompts()).toBe(1)
    expect(allowlistEscalated.size).toBe(1)
  })

  test("key is key-order independent: same fields, different order ⇒ still coalesce", async () => {
    const reviewer = mkCountingReviewer()
    const allowlistEscalated = new Set<string>()
    const c = cfg()
    const wave = waveOf(reviewer, allowlistEscalated)

    await dispatch(c, { path: "A", contents: "x" }, "c1", wave)
    expect(reviewer.prompts()).toBe(1)
    // Same semantic action, keys enumerated in a different order — canonical
    // serialization must treat these as identical (no re-prompt).
    await dispatch(c, { contents: "x", path: "A" }, "c2", wave)
    expect(reviewer.prompts()).toBe(1)
    expect(allowlistEscalated.size).toBe(1)
  })
})
