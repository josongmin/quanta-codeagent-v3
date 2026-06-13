/**
 * T08 — model-refusal recovery (fork/neutralize + re-prompt) HELLGATE.
 *
 * Drives the REAL agent loop (`runAgent`) with a hermetic scripted LLM that
 * injects refusal-class stops, asserting the §T08 use-cases end-to-end (no
 * synthetic shims around the decision FSM — the recovery must hold through the
 * actual same-turn engine, recovery-executor, and working-memory append path):
 *
 *   UC1  false-refusal recovery: refusal → fork+neutralize + re-prompt →
 *        SECOND attempt succeeds, with NO user intervention.
 *   UC2  one-shot HARD rule: re-refusal after the single fallback is terminal.
 *        RED-ON-INJECTION — the scripted LLM THROWS on a 3rd call, so any code
 *        that retries more than once turns this test red (not a silent hang).
 *   UC3  default-OFF byte-identical: gate OFF ⇒ a refusal terminates exactly as
 *        before (one call, `reason:"refusal"`), no extra LLM call.
 *   UC4  provider-agnostic: BOTH Anthropic `refusal` and OpenAI
 *        `content_filtered` route through the same recovery (normalization seam),
 *        recovering on the second attempt and terminating on re-refusal.
 *   UC5  budget: a fork that would exceed `taskBudget` is declined ⇒ terminal,
 *        no second call.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { REFUSAL_NEUTRALIZED_MARKER } from "@/agent/loop"
import { DEFAULT_REFUSAL_FALLBACK_PROMPT } from "@/agent/refusal-fallback"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** Replays scripts strictly in order. THROWS when called more times than there
 *  are scripts — so an over-retrying loop surfaces as a hard error (red), never
 *  a silent repeat or an infinite same-turn spin. Records every StreamInput so
 *  the re-prompt's transcript can be inspected. */
class StrictReplayLLM implements LLMPort {
  readonly model = "replay"
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const script = this.scripts[this.calls]
    this.calls += 1
    if (script === undefined) {
      throw new Error(`StrictReplayLLM: unexpected LLM call #${this.calls} (scripts exhausted)`)
    }
    for (const ev of script) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const refusalScript = (text: string, stopReason: "refusal" | "content_filtered"): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: stopReason },
]

const successScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A refusal that ALSO reports a large usage so `taskSpend` accumulates past the
 *  budget by decision time (UC5). */
const refusalWithUsage = (tokens: number): StreamEvent[] => [
  { type: "text_delta", delta: "I cannot help with that." },
  { type: "usage", inputTokens: tokens, outputTokens: 0, model: "replay" },
  { type: "message_stop", stop_reason: "refusal" },
]

let permRoot: string | null = null
const baseCfg = (
  llm: LLMPort,
  stream: StreamPort,
  over: Partial<AgentConfig> = {},
): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
  permRoot = mkdtempSync(join(tmpdir(), "refusal-fallback-perm-"))
  const prev = process.env.QUANTA_PERMISSION_STATE
  process.env.QUANTA_PERMISSION_STATE = join(permRoot, "perm.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.QUANTA_PERMISSION_STATE
    else process.env.QUANTA_PERMISSION_STATE = prev
    if (permRoot) rmSync(permRoot, { recursive: true, force: true })
    permRoot = null
    __resetRuntimeConfig()
    __resetDefaultPermissionStore()
  }
}

const ON: Partial<AgentConfig> = { refusalFallback: { enabled: true } }

describe("T08 refusal-fallback recovery (hellgate)", () => {
  test("UC1 — refusal recovers on the SECOND attempt, no user intervention", async () => {
    await withEnv(async () => {
      const llm = new StrictReplayLLM([
        refusalScript("I'm sorry, I can't do that.", "refusal"),
        successScript("Done — here is the result."),
      ])
      const stream = new RecordingStream()
      const out = await runAgent(baseCfg(llm, stream, ON))
      expect(llm.calls).toBe(2) // exactly one fork+reprompt
      expect(out.reason).toBe("completed")
      // The recovery is observable (north-star): a recovery event fires with a
      // detail that names the refusal-fallback + surfaces the refused rationale.
      const rec = stream.events.find(
        (e): e is Extract<AgentEvent, { type: "recovery" }> => e.type === "recovery",
      )
      expect(rec).toBeDefined()
      expect(rec?.detail).toContain("model_refusal_fallback")
      expect(rec?.detail).toContain("neutralizedByFork")
      expect(rec?.detail).toContain("I'm sorry, I can't do that.")
    })
  })

  test("UC1b — the re-prompt neutralizes the refusal and injects the fallback prompt", async () => {
    await withEnv(async () => {
      const llm = new StrictReplayLLM([
        refusalScript("Refusing: policy X.", "refusal"),
        successScript("ok"),
      ])
      await runAgent(baseCfg(llm, new RecordingStream(), ON))
      // The SECOND request's transcript must contain the neutralized marker (NOT
      // the raw refusal text) and the default fallback re-prompt.
      const secondInput = llm.inputs[1]
      expect(secondInput).toBeDefined()
      const flat = JSON.stringify(secondInput?.messages ?? [])
      expect(flat).toContain(REFUSAL_NEUTRALIZED_MARKER)
      expect(flat).toContain(DEFAULT_REFUSAL_FALLBACK_PROMPT)
      expect(flat).not.toContain("Refusing: policy X.") // refusal text forked off
    })
  })

  test("UC2 — re-refusal after the single fallback is TERMINAL (red-on-injection)", async () => {
    await withEnv(async () => {
      // Only TWO scripts: a 3rd LLM call (i.e. a 2nd fallback) throws → red.
      const llm = new StrictReplayLLM([
        refusalScript("no", "refusal"),
        refusalScript("still no", "refusal"),
      ])
      const out = await runAgent(baseCfg(llm, new RecordingStream(), ON))
      expect(llm.calls).toBe(2) // exactly one retry, then terminal
      expect(out.reason).toBe("refusal")
      expect(out.refusal?.rationale).toBe("still no")
    })
  })

  test("UC3 — default-OFF: a refusal terminates byte-identically (one call)", async () => {
    await withEnv(async () => {
      const llm = new StrictReplayLLM([refusalScript("declined", "refusal")])
      const out = await runAgent(baseCfg(llm, new RecordingStream())) // no refusalFallback
      expect(llm.calls).toBe(1)
      expect(out.reason).toBe("refusal")
      expect(out.refusal?.rationale).toBe("declined")
    })
  })

  test("UC4a — OpenAI content_filtered recovers via the SAME path (provider-agnostic)", async () => {
    await withEnv(async () => {
      const llm = new StrictReplayLLM([
        refusalScript("[content filtered]", "content_filtered"),
        successScript("recovered answer"),
      ])
      const out = await runAgent(baseCfg(llm, new RecordingStream(), ON))
      expect(llm.calls).toBe(2)
      expect(out.reason).toBe("completed")
    })
  })

  test("UC4b — content_filtered re-refusal is terminal (never silently completes)", async () => {
    await withEnv(async () => {
      const llm = new StrictReplayLLM([
        refusalScript("[filtered]", "content_filtered"),
        refusalScript("[filtered again]", "content_filtered"),
      ])
      const out = await runAgent(baseCfg(llm, new RecordingStream(), ON))
      expect(llm.calls).toBe(2)
      expect(out.reason).toBe("refusal")
    })
  })

  test("UC5 — fork is declined when it would exceed taskBudget ⇒ terminal", async () => {
    await withEnv(async () => {
      // budget 10 tokens; the refusal reports 100 spent → over budget → no fork.
      const llm = new StrictReplayLLM([refusalWithUsage(100)])
      const out = await runAgent(
        baseCfg(llm, new RecordingStream(), {
          ...ON,
          taskBudget: { tokens: 10 },
        }),
      )
      expect(llm.calls).toBe(1) // no second call — fork declined
      expect(out.reason).toBe("refusal")
    })
  })

  test("UC5b — fork PROCEEDS when taskBudget has headroom", async () => {
    await withEnv(async () => {
      const llm = new StrictReplayLLM([
        refusalWithUsage(5), // 5 < 1000 budget → headroom
        successScript("done"),
      ])
      const out = await runAgent(
        baseCfg(llm, new RecordingStream(), {
          ...ON,
          taskBudget: { tokens: 1000 },
        }),
      )
      expect(llm.calls).toBe(2)
      expect(out.reason).toBe("completed")
    })
  })
})
