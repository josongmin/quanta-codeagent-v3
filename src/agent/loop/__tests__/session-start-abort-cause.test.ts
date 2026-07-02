/**
 * HELLGATE — session-START abort CAUSE attribution (same class as FIX 2c
 * `parkSettleFinish`).
 *
 * `runSessionStartSequence` (session-lifecycle.ts) can return "aborted" from
 * TWO distinct causes, and `entry.ts` maps that single "aborted" to a stop
 * category:
 *
 *   1. a UserPromptSubmit HOOK DENY (session-lifecycle.ts ~:288) — a
 *      policy/system block on the prompt, NOT a user Ctrl+C. This MUST be
 *      attributed to the SYSTEM bucket (`system.abort`), exactly like the
 *      landed `parkSettleFinish` split (subagent-wake settle ⇒ "system").
 *
 *   2. an INTERRUPT submission op (handleSubmissionControlOp, via
 *      `isInterruptOp`) — the genuine user interrupt. This MUST stay attributed
 *      to the USER bucket (`user.interrupt`).
 *
 * Before the fix, entry.ts hard-coded `interruptedCategory("user")` for BOTH,
 * so the hook-deny case was MISLABELED as a user interrupt. This battery drives
 * the REAL `runAgent` loop end-to-end and asserts on the resulting
 * `outcome.stopCategory.reasonCode` — a real observable at the outcome
 * boundary, not a tautology over an internal flag.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { HookBus } from "@/agent/hooks"
import { STOP_REASON_CODE } from "@/agent/stop-category"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** An LLM that would complete a turn — used to PROVE the start-abort unwinds
 *  BEFORE any LLM call (the abort must pre-empt the loop, not ride through it). */
class CompletingLLM implements LLMPort {
  readonly seen: StreamInput[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input)
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class CollectStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const baseConfig = (llm: LLMPort, stream: StreamPort): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userMsg("do a thing")],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  sessionId: "sess-cause",
})

describe("session-START abort cause attribution (HELLGATE)", () => {
  test("UserPromptSubmit hook DENY start-abort ⇒ SYSTEM bucket, NOT user.interrupt", async () => {
    const llm = new CompletingLLM()
    const stream = new CollectStream()
    // A hook that DENIES the prompt submission ⇒ runSessionStartSequence returns
    // "aborted" from the hook-deny branch. This is a policy/system stop.
    const hooks = new HookBus()
    hooks.on("user_prompt_submit", () => ({ deny: "blocked by policy" }))

    const outcome = await runAgent({ ...baseConfig(llm, stream), hooks })

    expect(outcome.reason).toBe("aborted")
    // Pre-empts the loop: no LLM stream was opened.
    expect(llm.seen.length).toBe(0)
    expect(outcome.stopCategory?.kind).toBe("interrupted")
    // THE DISCRIMINATING ASSERTION: a hook/policy block is SYSTEM-originated,
    // never a user Ctrl+C.
    expect(outcome.stopCategory?.reasonCode).toBe(STOP_REASON_CODE.SYSTEM_ABORT)
    expect(outcome.stopCategory?.reasonCode).not.toBe(STOP_REASON_CODE.USER_INTERRUPT)
  })

  test("interrupt submission op start-abort ⇒ USER bucket (user.interrupt) — unchanged", async () => {
    const llm = new CompletingLLM()
    const stream = new CollectStream()

    const outcome = await runAgent({
      ...baseConfig(llm, stream),
      submission: { id: "i-1", op: { kind: "interrupt" } },
    })

    expect(outcome.reason).toBe("aborted")
    expect(llm.seen.length).toBe(0)
    expect(outcome.stopCategory?.kind).toBe("interrupted")
    // A genuine user interrupt stays USER-attributed.
    expect(outcome.stopCategory?.reasonCode).toBe(STOP_REASON_CODE.USER_INTERRUPT)
    expect(outcome.stopCategory?.reasonCode).not.toBe(STOP_REASON_CODE.SYSTEM_ABORT)
  })
})
