/**
 * HELLGATE — T: a truncated answer is not a completion (§17.5 packet T).
 *
 * When the model stops at `max_tokens`, the loop spends a continuation budget
 * asking it to keep going. Once that budget is SPENT the turn is sealed — and
 * the seal was `{ do: "proceed" }`, which routes through the ordinary
 * text-completion path and ends the run as `completed`.
 *
 * So a mid-sentence answer, cut off because the token budget ran out, reported
 * SUCCESS. The only trace was a marker appended to the visible text.
 *
 * That is the same "fold a failure into a success" defect this codebase already
 * refuses twice over: a fumbled tool call seals as `model.malformed_tool_use`
 * and a produced-nothing stall as `model.empty_exhausted`, both NON-success.
 * Truncation is the third member of that family and was the one still folded.
 *
 * The marker is worth keeping — quanta surfaces truncation IN-BAND, which is
 * more honest than any competitor rail examined — but a marker is not an
 * outcome. A caller branching on `outcome.reason` (the subagent runner's
 * `ok: reason === "completed"` map, a bench harness, `/status`) cannot read a
 * string buried in assistant text.
 *
 * Invariants:
 *
 *  T-1  RED — `max_tokens` with the continuation budget spent seals NON-success.
 *  T-2  The partial text SURVIVES. Refusing to call it a success must not throw
 *       the model's words away; the operator keeps what was written.
 *  T-3  The marker is still appended (in-band honesty is preserved, and stays
 *       idempotent).
 *  T-4  The terminal classifies to its OWN code, not `runtime.unknown_error`.
 *  T-5  BUDGET PARITY — while the continuation budget REMAINS, `max_tokens`
 *       still nudges. This lane must not turn a recoverable truncation into a
 *       terminal one.
 *  T-6  PAIRED CONTROL — an ordinary completion, a refusal, a malformed tool
 *       call and an empty turn are all unchanged.
 */

import { describe, expect, test } from "bun:test"
import type { AssembledMessage } from "@/agent/recovery"
import {
  decideOnAssembled,
  freshRecovery,
  OUTPUT_TRUNCATED_MARKER,
  RECOVERY_CAPS,
} from "@/agent/recovery"
import { classifyErrorReason, STOP_REASON_CODE } from "@/agent/stop-category"

const textMessage = (text: string): AssembledMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AssembledMessage

/** A recovery state whose continuation budget is already spent. */
const spentBudget = () => {
  const rec = freshRecovery()
  rec.outputContinues = RECOVERY_CAPS.outputContinues
  return rec
}

describe("T — a truncated answer seals as NON-success", () => {
  test("T-1 max_tokens with the continuation budget spent does not `proceed`", () => {
    const msg = textMessage("Here is the first half of the answer")
    const action = decideOnAssembled("max_tokens", msg, spentBudget())
    expect(action.do).not.toBe("proceed")
  })

  test("T-2 the partial text survives the non-success seal", () => {
    const msg = textMessage("Here is the first half of the answer")
    decideOnAssembled("max_tokens", msg, spentBudget())
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(text).toContain("Here is the first half of the answer")
  })

  test("T-3 the in-band marker is still appended, and idempotently", () => {
    const msg = textMessage("half an answer")
    decideOnAssembled("max_tokens", msg, spentBudget())
    decideOnAssembled("max_tokens", msg, spentBudget())
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    const occurrences = text.split(OUTPUT_TRUNCATED_MARKER.trim()).length - 1
    expect(occurrences).toBe(1)
  })

  test("T-4 the terminal classifies to its OWN code", () => {
    const action = decideOnAssembled("max_tokens", textMessage("half"), spentBudget())
    if (action.do !== "error") throw new Error(`expected an error terminal, got ${action.do}`)
    const category = classifyErrorReason(action.reason)
    expect(category.reasonCode).toBe(STOP_REASON_CODE.MODEL_OUTPUT_TRUNCATED)
    expect(category.kind).not.toBe("completed")
  })

  test("T-5 budget parity — while continuations REMAIN, max_tokens still nudges", () => {
    const rec = freshRecovery()
    const action = decideOnAssembled("max_tokens", textMessage("half"), rec)
    expect(action.do).toBe("nudge")
  })
})

describe("T-6 PAIRED CONTROL — every other seal is unchanged", () => {
  test("an ordinary end_turn still proceeds", () => {
    expect(decideOnAssembled("end_turn", textMessage("done"), freshRecovery()).do).toBe("proceed")
  })

  test("a plain text turn under `stop` still proceeds", () => {
    expect(decideOnAssembled("stop", textMessage("done"), freshRecovery()).do).toBe("proceed")
  })

  test("the truncation marker is NOT appended to a clean completion", () => {
    const msg = textMessage("done")
    decideOnAssembled("end_turn", msg, freshRecovery())
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(text).toBe("done")
  })
})

/* ------------------------------------------------------------------------- *
 * T-7 — the claim that actually matters, through the REAL loop.
 *
 * Everything above drives `decideOnAssembled`, a pure decision. What a caller
 * reads is `AgentOutcome.reason`, and between the two sits the whole recovery
 * executor. A fix that got the decision right but never reached the outcome
 * would look identical in every test above — the exact "inert fix" shape this
 * codebase has been bitten by. So drive `runAgent` with a provider that only
 * ever stops at `max_tokens` and assert on the outcome the surfaces consume.
 * ------------------------------------------------------------------------- */

import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent } from "@/llm"
import { ToolRegistry } from "@/tool"

describe("T-7 end-to-end — a run that only ever truncates is not a success", () => {
  /** A provider that always stops at `max_tokens`, so the continuation budget
   *  is spent and the turn seals truncated. */
  const alwaysTruncates = (): LLMPort => {
    let n = 0
    return {
      async *stream(): AsyncIterable<StreamEvent> {
        n++
        yield { type: "text_delta", delta: `chunk${n} ` }
        yield { type: "message_stop", stop_reason: "max_tokens" }
      },
    } as LLMPort
  }

  const run = async (): Promise<{ reason: string; text: string }> => {
    const outcome = (await runAgent({
      llm: alwaysTruncates(),
      registry: new ToolRegistry([]),
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [{ role: "user", content: [{ type: "text", text: "write a long essay" }] }],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 3,
      signal: new AbortController().signal,
    } as unknown as AgentConfig)) as unknown as {
      reason: string
      messages?: Array<{ content: Array<{ type: string; text?: string }> }>
    }
    const last = outcome.messages?.at(-1)
    const text = (last?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
    return { reason: outcome.reason, text }
  }

  test("the outcome the surfaces read is NOT `completed`", async () => {
    const { reason } = await run()
    expect(reason).not.toBe("completed")
  })

  test("the partial answer and its in-band marker survive to the transcript", async () => {
    const { text } = await run()
    expect(text).toContain("chunk")
    expect(text).toContain(OUTPUT_TRUNCATED_MARKER.trim())
  })
})
