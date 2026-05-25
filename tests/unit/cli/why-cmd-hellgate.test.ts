/**
 * `/why <toolCallId|last>` hellgate (ADR-0271).
 *
 * Pins the meta-LLM reasoning-query surface: 16 adversarial cases cover
 * the full path — argument parsing, last-resolution, missing session,
 * JSON parse + markdown-fence stripping, LLM failure modes, ANSI gating,
 * token accumulation, prompt context cap.
 *
 * Slice-fence: imports ONLY @/llm types + @/session types + the new
 * why-cmd module. No REPL wiring is touched.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent } from "../../../src/llm"
import { assembleFromEvents } from "../../../src/llm"
import { __test as whyTest, runWhyCmd } from "../../../src/apps/cli/why-cmd"
import type { SessionEnvelopeRecord } from "../../../src/session"

/* ─── fixtures ──────────────────────────────────────────────────────── */

const ISO = (n: number): string => new Date(1717000000000 + n).toISOString()

const turnContext = (turn_id: string): SessionEnvelopeRecord => ({
  type: "turn_context",
  schema_version: 2,
  turn_id,
  cwd: "/tmp/x",
  current_date: ISO(0),
  timezone: "UTC",
  approval_policy: "never",
  sandbox_policy: "read-only",
  permission_profile: "default",
  model: "gpt-5",
  personality: "default",
  collaboration_mode: "solo",
  realtime_active: false,
  effort: "medium",
  summary: "",
  user_instructions: "",
  truncation_policy: "none",
  parent_thread_id: null,
  thread_role: "root",
})

const userMessage = (turn_id: string, content: string, tsOffset = 0): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "user_message",
  content,
})

const toolInvoke = (
  turn_id: string,
  tool: string,
  input: Record<string, unknown>,
  tsOffset = 2,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_invoke",
  tool,
  input,
})

const toolResult = (
  turn_id: string,
  tool: string,
  ok: boolean,
  output: string,
  tsOffset = 4,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "tool_result",
  tool,
  ok,
  output,
})

const decision = (
  turn_id: string,
  gate: "permission" | "rule" | "hook" | "cap" | "jail" | "budget",
  outcome: "allow" | "deny" | "ask",
  reason: string,
  toolCallId: string,
  tsOffset = 3,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "decision",
  gate,
  outcome,
  decision_reason: reason,
  tool_call_id: toolCallId,
})

const custom = (
  turn_id: string,
  custom_kind: string,
  data: Record<string, unknown>,
  tsOffset = 5,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  ts: ISO(tsOffset),
  turn_id,
  kind: "custom",
  custom_kind,
  data,
})

/* ─── LLM stubs ─────────────────────────────────────────────────────── */

/** A capturing stub LLMPort: records the last `StreamInput` it saw and
 *  yields the canned events. Default usage event carries 320 tokens. */
const stubLlm = (
  events: StreamEvent[],
): { llm: LLMPort; lastInput: { value: { messages: Message[]; system?: string } | undefined } } => {
  const captured: { value: { messages: Message[]; system?: string } | undefined } = {
    value: undefined,
  }
  const llm: LLMPort = {
    model: "stub",
    stream(input) {
      captured.value = {
        messages: input.messages,
        ...(typeof input.system === "string" ? { system: input.system } : {}),
      }
      return (async function* () {
        for (const ev of events) yield ev
      })()
    },
  }
  return { llm, lastInput: captured }
}

const textEvents = (text: string, tokens = 320): StreamEvent[] => [
  { type: "text_delta", delta: text },
  {
    type: "usage",
    inputTokens: Math.floor(tokens / 2),
    outputTokens: tokens - Math.floor(tokens / 2),
    model: "stub",
  },
  { type: "message_stop", stop_reason: "end_turn" },
]

const goodJson = (
  goal: string,
  reasoning: string[],
  considered: string[] = [],
  confidence: "high" | "medium" | "low" = "high",
): string =>
  JSON.stringify({ goal, reasoning, alternatives_considered: considered, confidence })

/* ─── sink ─────────────────────────────────────────────────────────── */

const captureSink = (): { out: (s: string) => void; text: () => string } => {
  let buf = ""
  return {
    out: (s) => {
      buf += s
    },
    text: () => buf,
  }
}

const runWith = async (
  arg: string,
  envelopes: readonly SessionEnvelopeRecord[],
  events: StreamEvent[],
  opts: { sessionId?: string | undefined; color?: boolean } = {},
): Promise<{
  exitCode: number
  tokensUsed?: number
  text: string
  capturedInput: { messages: Message[]; system?: string } | undefined
}> => {
  const sink = captureSink()
  const { llm, lastInput } = stubLlm(events)
  const r = await runWhyCmd(arg, {
    out: sink.out,
    sessionId: opts.sessionId ?? "sess-test",
    color: opts.color ?? false,
    model: "gpt-5",
    llm,
    readSessionEnvelopes: async () => envelopes,
  })
  return { ...r, text: sink.text(), capturedInput: lastInput.value }
}

// Lint-safe ANSI regex (built from non-literal escape).
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`)

/* ─── cases ─────────────────────────────────────────────────────────── */

describe("why-cmd · argument resolution", () => {
  test("case 1 — `last` resolves to the most-recent decision tool_call_id", async () => {
    const envs = [
      turnContext("3"),
      decision("3", "permission", "allow", "first", "tc_old", 1),
      decision("3", "permission", "allow", "newer", "tc_new", 2),
    ]
    const events = textEvents(goodJson("Open foo.ts", ["because prior message asked"]))
    const r = await runWith("last", envs, events)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("why tc_new")
  })

  test("case 2 — explicit id matches a recorded decision", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_explicit", 1)]
    const events = textEvents(goodJson("Locate handler", ["Read is precise"]))
    const r = await runWith("tc_explicit", envs, events)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("why tc_explicit")
    expect(r.text).toContain("Locate handler")
  })

  test("case 3 — unknown id ⇒ 'not found' + exit 1", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_x", 1)]
    const r = await runWith("tc_missing", envs, textEvents("ignored"))
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain("tc_missing not found in session sess-test")
  })

  test("case 4 — undefined session id ⇒ 'no active session' + exit 1", async () => {
    const sink = captureSink()
    const { llm } = stubLlm(textEvents("never called"))
    const r = await runWhyCmd("tc_x", {
      out: sink.out,
      sessionId: undefined,
      model: "gpt-5",
      llm,
      readSessionEnvelopes: async () => [],
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("no active session")
  })

  test("case 5 — empty id ⇒ exit 1 + usage hint", async () => {
    const sink = captureSink()
    const { llm } = stubLlm([])
    const r = await runWhyCmd("", {
      out: sink.out,
      sessionId: "sess",
      model: "gpt-5",
      llm,
      readSessionEnvelopes: async () => [],
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("tool call id is required")
  })

  test("case 6 — `last` against empty session ⇒ 'no tool calls found' + exit 1", async () => {
    const r = await runWith("last", [turnContext("3")], textEvents("never"))
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain("no tool calls found")
  })
})

describe("why-cmd · LLM response parsing", () => {
  test("case 7 — clean JSON renders structured panel", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_7", 1)]
    const events = textEvents(
      goodJson("Find foo handler", ["1st", "2nd", "3rd"], ["grep", "lsp"], "high"),
    )
    const r = await runWith("tc_7", envs, events)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("Find foo handler")
    expect(r.text).toContain("1. 1st")
    expect(r.text).toContain("- grep")
    expect(r.text).toContain("high")
    expect(r.tokensUsed).toBe(320)
  })

  test("case 8 — invalid JSON ⇒ fallback panel with raw text", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_8", 1)]
    const events = textEvents("I think the agent did this because of a hunch. Probably.")
    const r = await runWith("tc_8", envs, events)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("LLM returned unstructured prose")
    expect(r.text).toContain("hunch")
  })

  test("case 9 — markdown ```json … ``` fence is stripped + parsed", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_9", 1)]
    const fenced = `\`\`\`json\n${goodJson("after-fence-goal", ["a"])}\n\`\`\``
    const r = await runWith("tc_9", envs, textEvents(fenced))
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("after-fence-goal")
    expect(r.text).not.toContain("```")
  })

  test("case 10 — LLM throw ⇒ 'meta query failed' + exit 1", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_10", 1)]
    const sink = captureSink()
    const llm: LLMPort = {
      stream() {
        return (async function* () {
          throw new Error("upstream 502")
          yield { type: "message_stop", stop_reason: "end_turn" } as StreamEvent
        })()
      },
    }
    const r = await runWhyCmd("tc_10", {
      out: sink.out,
      sessionId: "sess-test",
      model: "gpt-5",
      llm,
      readSessionEnvelopes: async () => envs,
    })
    expect(r.exitCode).toBe(1)
    expect(sink.text()).toContain("meta query failed: upstream 502")
  })

  test("case 11 — confidence='low' is annotated", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_11", 1)]
    const events = textEvents(goodJson("?", ["maybe"], [], "low"))
    const r = await runWith("tc_11", envs, events)
    expect(r.exitCode).toBe(0)
    expect(r.text).toContain("low")
    expect(r.text).toContain("uncertain")
  })

  test("case 12 — long reasoning (10 items) is rendered verbatim", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_12", 1)]
    const steps = Array.from({ length: 10 }, (_, i) => `step-${i + 1}`)
    const events = textEvents(goodJson("g", steps))
    const r = await runWith("tc_12", envs, events)
    expect(r.exitCode).toBe(0)
    for (const s of steps) expect(r.text).toContain(s)
  })
})

describe("why-cmd · output shaping", () => {
  test("case 13 — color=false ⇒ zero ANSI escapes", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_13", 1)]
    const r = await runWith("tc_13", envs, textEvents(goodJson("g", ["r1"], ["alt"], "low")), {
      color: false,
    })
    expect(r.exitCode).toBe(0)
    expect(ANSI_RE.test(r.text)).toBe(false)
  })

  test("case 14 — very long goal (>500 chars) is truncated", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_14", 1)]
    const longGoal = "x".repeat(800)
    const events = textEvents(goodJson(longGoal, ["r"]))
    const r = await runWith("tc_14", envs, events)
    expect(r.exitCode).toBe(0)
    expect(r.text).not.toContain("x".repeat(800))
    expect(r.text).toContain("more")
  })

  test("case 15 — tokensUsed reflects usage event sum", async () => {
    const envs = [turnContext("3"), decision("3", "permission", "allow", "ok", "tc_15", 1)]
    const events: StreamEvent[] = [
      { type: "text_delta", delta: goodJson("g", ["r"]) },
      { type: "usage", inputTokens: 70, outputTokens: 30, model: "stub" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const r = await runWith("tc_15", envs, events)
    expect(r.tokensUsed).toBe(100)
    expect(r.text).toContain("100 tokens")
  })
})

describe("why-cmd · prompt cap (privacy + cost)", () => {
  test("case 16 — only the last 3 preceding messages reach the LLM", async () => {
    const envs: SessionEnvelopeRecord[] = [
      turnContext("3"),
      userMessage("3", "msg-A: first old query", 0),
      userMessage("3", "msg-B: second old query", 1),
      userMessage("3", "msg-C: third query", 2),
      userMessage("3", "msg-D: fourth query (most recent)", 3),
      decision("3", "permission", "allow", "ok", "tc_cap", 10),
      toolInvoke("3", "Read", { path: "src/foo.ts" }, 11),
    ]
    const r = await runWith("tc_cap", envs, textEvents(goodJson("g", ["r"])))
    expect(r.exitCode).toBe(0)
    const sys = r.capturedInput?.system ?? ""
    expect(sys).toContain("introspection assistant")
    // The user prompt of the meta-query lives in messages[0].content[0].
    const block = r.capturedInput?.messages?.[0]?.content?.[0]
    const userText = block && block.type === "text" ? block.text : ""
    expect(userText).toContain("msg-B")
    expect(userText).toContain("msg-C")
    expect(userText).toContain("msg-D")
    // The oldest message MUST be capped out — only the last 3 survive.
    expect(userText).not.toContain("msg-A: first old query")
  })

  test("case 17 — secret-shape values in tool_invoke input are redacted on the wire", async () => {
    const envs: SessionEnvelopeRecord[] = [
      turnContext("3"),
      decision("3", "permission", "allow", "ok", "tc_sec", 1),
      toolInvoke(
        "3",
        "WebFetch",
        {
          url: "https://api.example.com",
          headers: { Authorization: "Bearer sk-proj-abcdefghij1234567890" },
        },
        2,
      ),
    ]
    const r = await runWith("tc_sec", envs, textEvents(goodJson("g", ["r"])))
    expect(r.exitCode).toBe(0)
    const block = r.capturedInput?.messages?.[0]?.content?.[0]
    const userText = block && block.type === "text" ? block.text : ""
    // Verbatim secret value MUST NOT cross the host boundary.
    expect(userText).not.toContain("sk-proj-abcdefghij1234567890")
    expect(userText).toContain("REDACTED")
  })
})

describe("why-cmd · helpers (white-box)", () => {
  test("case 18 — stripFences handles bare-``` fence and inner json tag", () => {
    const inner = `{"goal":"x","reasoning":["a"],"alternatives_considered":[],"confidence":"high"}`
    expect(whyTest.stripFences(`\`\`\`json\n${inner}\n\`\`\``)).toBe(inner)
    expect(whyTest.stripFences(`\`\`\`${inner}\`\`\``).trim()).toBe(inner)
    expect(whyTest.stripFences(inner)).toBe(inner)
  })

  test("case 19 — parseReasoning gracefully returns null for bad shapes", () => {
    expect(whyTest.parseReasoning("not json")).toBe(null)
    expect(whyTest.parseReasoning(`{"goal":"x"}`)).toBe(null) // missing reasoning
    expect(whyTest.parseReasoning(`null`)).toBe(null)
  })

  test("case 20 — parseReasoning coerces unknown confidence to 'medium'", () => {
    const inner = `{"goal":"g","reasoning":["r"],"alternatives_considered":[],"confidence":"???"}`
    const p = whyTest.parseReasoning(inner)
    expect(p).not.toBe(null)
    expect(p?.confidence).toBe("medium")
  })

  // Compile-pin: `assembleFromEvents` is re-exported via @/llm — keep
  // the import live so the dependency surface is checked.
  test("case 21 — assembleFromEvents pin", () => {
    const { message } = assembleFromEvents([
      { type: "text_delta", delta: "hi" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    expect(message.role).toBe("assistant")
  })
})
