/**
 * ★ CONTRACT — A3: src/agent/recovery.ts per-kind caps (stream≤3 / output≤3 /
 *   malformed≤1 / empty≤2) are EXACT off-by-one bounded; loop.ts:1557 turn-1
 *   accounting → recovery does NOT consume a turn slot; no refund across types.
 *   Each assertion labeled CONTRACT (invariant) vs CHARACTERIZATION (observed).
 *
 * A3 — RecoveryAction budget-exhaustion BOUNDARY hell-gate.
 *
 * These tests pin the EXACT boundary of every same-turn recovery budget by
 * driving the pure FSM (`decideOnStreamError` / `decideOnAssembled`) directly,
 * plus an integrated `runAgent` pass for the maxTurns / PTL invariants.
 *
 * Budgets (from src/agent/recovery.ts):
 *   MAX_TURN_STREAM_RETRIES = 3   → backoff on attempts 0,1,2 then 4th call errors
 *   MAX_OUTPUT_CONTINUES    = 3   → nudge ×3 then proceed/complete
 *   MAX_MALFORMED_RETRIES   = 1   → nudge ×1 then completed-via-exhaustion
 *   MAX_CONSECUTIVE_EMPTIES = 2   → nudge ×2 then completed-via-exhaustion
 *
 * INVARIANTS PROVEN HERE:
 *   1. Off-by-one boundary: the Nth retry is allowed, the (N+1)th is terminal.
 *   2. Interleaving: a SUCCESSFUL proceed turn resets `consecutiveEmpties` but
 *      does NOT reset the other three counters (documented below — this is what
 *      the code actually does).
 *   3. maxTurns: a turn that backoffs N times then succeeds consumes exactly
 *      ONE turn slot.
 *   4. PTL → reactive compaction does NOT count as a normal turn.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import {
  decideOnAssembled,
  decideOnStreamError,
  freshRecovery,
  type RecoveryState,
} from "@/agent/loop"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ─── House fakes (mirror tests/integration/agent-recovery-e2e.test.ts) ──────

const assistant = (...content: Message["content"]): Message => ({ role: "assistant", content })
const textMsg = (text: string): Message => assistant({ type: "text", text })
const toolMsg = (id: string): Message =>
  assistant({ type: "tool_use", id, name: "read", input: { path: "/x" } })
const empty = (): Message => assistant()

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const ev of step.events) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]
const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const retryable = (): LLMError => new LLMError("503 service unavailable")

// ─────────────────────────────────────────────────────────────────────────
// 1. EXACT-BOUNDARY: stream backoff — 1,2,3 allowed; 4th is a HARD error
// ─────────────────────────────────────────────────────────────────────────

describe("A3 boundary — stream-error backoff budget (=3)", () => {
  test("attempts 0,1,2 backoff; the 4th decision is a hard error (NOT a 4th backoff)", () => {
    const rec = freshRecovery()
    const e = retryable()
    // attempt counter is the PRE-increment value, so backoffs are 0,1,2.
    expect(decideOnStreamError(e, "503", rec)).toEqual({ do: "backoff", attempt: 0 })
    expect(rec.streamRetries).toBe(1)
    expect(decideOnStreamError(e, "503", rec)).toEqual({ do: "backoff", attempt: 1 })
    expect(rec.streamRetries).toBe(2)
    expect(decideOnStreamError(e, "503", rec)).toEqual({ do: "backoff", attempt: 2 })
    expect(rec.streamRetries).toBe(3)
    // 4th: budget (3) is now exhausted — must be a terminal error, NOT backoff.
    const fourth = decideOnStreamError(e, "503-d", rec)
    expect(fourth.do).toBe("error")
    if (fourth.do === "error") expect(fourth.reason.toLowerCase()).toContain("retries")
    // The error decision must NOT have consumed a 4th retry slot.
    expect(rec.streamRetries).toBe(3)
  })

  test("the hard-error decision is idempotent at the boundary (no further drift)", () => {
    const rec = freshRecovery()
    const e = retryable()
    for (let i = 0; i < 3; i++) decideOnStreamError(e, "503", rec)
    const a = decideOnStreamError(e, "503", rec)
    const b = decideOnStreamError(e, "503", rec)
    expect(a).toEqual(b)
    expect(rec.streamRetries).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. EXACT-BOUNDARY: empty (≤2) — 3rd completes; malformed (≤1) — 2nd exhausts
// ─────────────────────────────────────────────────────────────────────────

describe("A3 boundary — empty-turn budget (=2)", () => {
  test("nudge,nudge,(3rd) completed — the 3rd empty is exhaustion, not a 3rd nudge", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    expect(rec.consecutiveEmpties).toBe(1)
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    expect(rec.consecutiveEmpties).toBe(2)
    // 3rd: budget exhausted ⇒ completed (terminal), counter does NOT go to 3.
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("completed")
    expect(rec.consecutiveEmpties).toBe(2)
  })
})

describe("A3 boundary — malformed-tool budget (=1)", () => {
  test("nudge,(2nd) completed — the 2nd malformed is exhaustion, not a 2nd nudge", () => {
    const rec = freshRecovery()
    // stop_reason "tool_use" but the message carries NO tool_use block.
    const a1 = decideOnAssembled("tool_use", textMsg("oops"), rec)
    expect(a1.do).toBe("nudge")
    expect(rec.malformedRetries).toBe(1)
    const a2 = decideOnAssembled("tool_use", textMsg("still oops"), rec)
    expect(a2.do).toBe("completed")
    expect(rec.malformedRetries).toBe(1)
  })
})

describe("A3 boundary — output-continue budget (=3)", () => {
  test("nudge ×3 at attempts <3; the 4th max_tokens falls through to proceed (text)", () => {
    const rec = freshRecovery()
    for (let i = 0; i < 3; i++) {
      expect(decideOnAssembled("max_tokens", textMsg(`p${i}`), rec).do).toBe("nudge")
    }
    expect(rec.outputContinues).toBe(3)
    // 4th: budget spent → max_tokens with text content is treated as a normal
    // (proceed) turn, NOT a hard error and NOT a 4th nudge.
    expect(decideOnAssembled("max_tokens", textMsg("done"), rec).do).toBe("proceed")
    expect(rec.outputContinues).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. INTERLEAVING: does a successful turn RESET the budget? (document reality)
// ─────────────────────────────────────────────────────────────────────────

describe("A3 interleaving — what a successful `proceed` turn resets (DOCUMENTED)", () => {
  test("DOCUMENTED: a proceed turn RESETS consecutiveEmpties to 0 (the only counter it touches)", () => {
    const rec = freshRecovery()
    // Spend 2 empties (budget=2, now at the cap).
    decideOnAssembled("end_turn", empty(), rec)
    decideOnAssembled("end_turn", empty(), rec)
    expect(rec.consecutiveEmpties).toBe(2)
    // A successful real tool turn → proceed; decideOnAssembled resets empties.
    expect(decideOnAssembled("tool_use", toolMsg("t1"), rec).do).toBe("proceed")
    expect(rec.consecutiveEmpties).toBe(0)
    // Therefore a subsequent empty run gets the FULL budget again: nudge twice.
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("completed")
  })

  test("DOCUMENTED: a proceed turn does NOT reset outputContinues / malformedRetries", () => {
    const rec = freshRecovery()
    // Spend the full output budget (3) and the malformed budget (1).
    for (let i = 0; i < 3; i++) decideOnAssembled("max_tokens", textMsg(`p${i}`), rec)
    decideOnAssembled("tool_use", textMsg("oops"), rec) // malformed nudge #1
    expect(rec.outputContinues).toBe(3)
    expect(rec.malformedRetries).toBe(1)
    // A successful proceed turn — these two counters are UNTOUCHED by it.
    expect(decideOnAssembled("tool_use", toolMsg("t1"), rec).do).toBe("proceed")
    expect(rec.outputContinues).toBe(3) // NOT reset
    expect(rec.malformedRetries).toBe(1) // NOT reset
    // So the next max_tokens proceeds (budget already spent) and the next
    // malformed completes (budget already spent) — no fresh allowance.
    expect(decideOnAssembled("max_tokens", textMsg("x"), rec).do).toBe("proceed")
    expect(decideOnAssembled("tool_use", textMsg("y"), rec).do).toBe("completed")
  })

  test("DOCUMENTED: streamRetries is never reset by decideOnAssembled (only fresh turns reset)", () => {
    // The stream-retry counter is owned by decideOnStreamError; decideOnAssembled
    // never reads or writes it. A successful assembled turn leaves it as-is.
    const rec = freshRecovery()
    rec.streamRetries = 2
    decideOnAssembled("tool_use", toolMsg("t1"), rec)
    expect(rec.streamRetries).toBe(2)
    // Only freshRecovery() (a NEW turn) zeroes it.
    expect(freshRecovery().streamRetries).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. maxTurns under a recovery STORM — N backoffs then success = ONE turn slot
// ─────────────────────────────────────────────────────────────────────────

describe("A3 maxTurns — recovery storm consumes exactly one turn slot", () => {
  test("3 backoffs then success completes under maxTurns=1 → out.turns === 1", async () => {
    // 3 transient throws (the full backoff budget) then a clean answer. With
    // maxTurns=1 this can only complete if the same-turn retries did NOT
    // consume the single turn slot.
    const llm = new ScriptedLLM([
      thr(retryable()),
      thr(retryable()),
      thr(retryable()),
      ev(text("recovered after storm")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 1 })),
      20_000,
      "storm-one-turn",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    expect(llm.calls).toBe(4) // 3 retries + 1 success, all within one turn slot
    const last = out.messages.findLast((m) => m.role === "assistant")
    expect(last?.content.some((b) => b.type === "text" && b.text === "recovered after storm")).toBe(
      true,
    )
  }, 25_000)

  test("mixed storm (backoff + max_tokens nudge + empty nudge) then success = ONE turn slot", async () => {
    // Pile every retry-flavoured recovery into a single logical turn, then
    // succeed. maxTurns=1 ⇒ the only way to complete is zero turn-slot cost.
    const llm = new ScriptedLLM([
      thr(retryable()), // backoff (streamRetries 0→1)
      ev(text("partial", "max_tokens")), // output nudge (outputContinues 0→1)
      ev([{ type: "message_stop", stop_reason: "end_turn" }]), // empty nudge
      ev(text("final after mixed storm")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 1 })),
      20_000,
      "mixed-storm-one-turn",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    expect(llm.calls).toBe(4)
  }, 25_000)
})

// ─────────────────────────────────────────────────────────────────────────
// 5. PTL → reactive compaction path does NOT count as a normal turn
// ─────────────────────────────────────────────────────────────────────────

describe("A3 PTL — reactive compaction is not a normal turn", () => {
  test("decideOnStreamError(PTL) ⇒ compact (no counter consumed, not an error/turn)", () => {
    const rec = freshRecovery()
    const a = decideOnStreamError(new LLMError("prompt is too long"), "ptl", rec)
    expect(a).toEqual({ do: "compact" })
    // PTL routing must NOT spend the stream-retry budget — compaction is a
    // separate same-turn remedy, distinct from a transient retry.
    expect(rec.streamRetries).toBe(0)
  })

  test("integrated: PTL → reactiveCompact → completed under maxTurns=1, out.turns === 1", async () => {
    // Seed >2 assistant turns so reactiveCompact (keepRecentTurns default) has
    // a summarizable prefix.
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn one" }] },
      { role: "user", content: [{ type: "text", text: "second request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn two" }] },
      { role: "user", content: [{ type: "text", text: "third request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn three" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ]
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long for this model")),
      ev(text("<summary>resume from here</summary>")), // compaction summary
      ev(text("final answer after compaction")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, messages: history, maxTurns: 1 })),
      20_000,
      "ptl-not-a-turn",
    )
    expect(out.reason).toBe("completed")
    // The PTL+compaction round did NOT consume the single turn slot.
    expect(out.turns).toBe(1)
    // A `recovery:"compact"` trace was emitted (proves the reactive path ran).
    const compactReasons = stream.events.filter(
      (e) => e.type === "recovery" && e.reason === "compact",
    )
    expect(compactReasons.length).toBeGreaterThanOrEqual(1)
    // History collapsed to a synthetic continuation summary.
    const firstText = out.messages[0]?.content[0]
    expect(firstText?.type === "text" && firstText.text).toContain("continuation summary")
  }, 25_000)
})
