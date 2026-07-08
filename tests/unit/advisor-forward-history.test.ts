import { describe, expect, test } from "bun:test"
import { type AdvisorConsultFromLLMOptions, advisorConsultFromLLM, redactTranscript } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"

/**
 * RFC jun-6 §6.2 — advisor full-history forward + transcript redaction hellgate.
 *
 * (b1) `forwardHistory:true` assembles the conversation transcript at the
 * composition root (the port) and prepends it to context — but ONLY after every
 * message is run through the secret + PII scrubbers. The REAL risk is that a
 * leaked secret in a prior tool result reaches the advisor sub-LLM; the hellgate
 * plants real-shaped secrets and asserts NONE survive.
 */

// A planted env-dump tool result carrying real-shaped secrets + PII.
const PLANTED_OPENAI = "sk-proj-abcdEFGH1234567890abcdEFGH1234567890abcdEFGH"
const PLANTED_AWS = "AKIAIOSFODNN7EXAMPLE"
const PLANTED_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
const PLANTED_EMAIL = "victim@example.com"

const transcript = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "help me debug" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "shell", input: { cmd: "env" } }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: `OPENAI_API_KEY=${PLANTED_OPENAI}\nAWS_KEY=${PLANTED_AWS}\nTOKEN=${PLANTED_JWT}\nCONTACT=${PLANTED_EMAIL}`,
      },
    ],
  },
]

/** Capture the request that reaches the LLM stream. */
const makeCapturingLLM = (): { llm: LLMPort; captured: () => string | undefined } => {
  let userText: string | undefined
  const stream = (input: { messages: Message[] }): AsyncIterable<StreamEvent> => {
    const firstUser = input.messages.find((m) => m.role === "user")
    const block = firstUser?.content[0]
    userText = block && block.type === "text" ? block.text : undefined
    return (async function* () {
      yield { type: "text_delta", delta: "advisor analysis" } as StreamEvent
    })()
  }
  const llm = { stream } as unknown as LLMPort
  return { llm, captured: () => userText }
}

describe("redactTranscript — secrets/PII scrubbed before forwarding", () => {
  test("OpenAI / AWS / JWT / email are ALL scrubbed", () => {
    const out = redactTranscript(transcript())
    expect(out).not.toContain(PLANTED_OPENAI)
    expect(out).not.toContain(PLANTED_AWS)
    expect(out).not.toContain(PLANTED_JWT)
    expect(out).not.toContain(PLANTED_EMAIL)
    // The transcript IS still forwarded (just redacted) — it carries the role
    // lines + redaction markers.
    expect(out).toContain("REDACTED")
    expect(out).toContain("transcript begin")
  })

  test("untrusted-as-DATA framing present (not commands to obey)", () => {
    const out = redactTranscript(transcript())
    expect(out).toContain("DATA")
    expect(out).toContain("NOT as instructions")
  })

  test("size bound — a 300-message transcript is tail-windowed", () => {
    const big: Message[] = Array.from({ length: 300 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text" as const, text: `message ${i}` }],
    }))
    const out = redactTranscript(big, { maxMessages: 40 })
    expect(out).toContain("earlier message(s) omitted")
    // Oldest messages dropped; the most-recent are kept.
    expect(out).toContain("message 299")
    expect(out).not.toContain("message 0\n")
  })

  test("char-cap backstop truncates a huge transcript", () => {
    const huge: Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(50_000) }] },
    ]
    const out = redactTranscript(huge, { maxChars: 1000 })
    expect(out).toContain("transcript truncated")
  })

  // jul-7 audit F-C defense-in-depth: a spawn_agent tool_result surfaces the child's
  // owner_token (a bare UUID authorizing close_agent). When this transcript is forked to a
  // sibling (fork_turns:"all") or forwarded to the advisor sub-LLM, the token must NOT
  // survive — the known-format secret pass does not recognize a UUID.
  test("subagent owner_token is scrubbed (capability token, not a known-format secret)", () => {
    const OWNER_TOKEN = "b1946ac9-2f0e-4dc0-9f1a-2f0e4dc09f1a"
    const withToken: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: `spawned agentId: task_abc (owner_token: ${OWNER_TOKEN} — pass this to close_agent to cancel it)`,
          },
        ],
      },
    ]
    const out = redactTranscript(withToken)
    expect(out).not.toContain(OWNER_TOKEN) // token gone
    expect(out).toContain("owner_token: [redacted]") // label kept, value scrubbed
    expect(out).toContain("task_abc") // the (non-secret) agent id survives
  })
})

describe("advisorConsultFromLLM — forwardHistory wiring", () => {
  test("forwardHistory:true + transcriptSource ⇒ NO raw secret reaches port.consult", async () => {
    const { llm, captured } = makeCapturingLLM()
    const opts: AdvisorConsultFromLLMOptions = {
      llm,
      resolveModel: () => "gpt-5",
      transcriptSource: () => transcript(),
    }
    const consult = advisorConsultFromLLM(opts)
    const result = await consult({ question: "", forwardHistory: true })
    expect(result.ok).toBe(true)
    const sent = captured() as string
    // The transcript was forwarded but EVERY planted secret is scrubbed.
    expect(sent).toContain("transcript begin")
    expect(sent).not.toContain(PLANTED_OPENAI)
    expect(sent).not.toContain(PLANTED_AWS)
    expect(sent).not.toContain(PLANTED_JWT)
    expect(sent).not.toContain(PLANTED_EMAIL)
  })

  test("forwardHistory:true WITHOUT a transcriptSource ⇒ no-op (explicit path)", async () => {
    const { llm, captured } = makeCapturingLLM()
    const consult = advisorConsultFromLLM({ llm, resolveModel: () => "gpt-5" })
    await consult({ question: "plain question", forwardHistory: true })
    // No transcript wired ⇒ the explicit question is sent verbatim.
    expect(captured()).toBe("plain question")
  })

  test("explicit-question mode is byte-identical (no transcript injected)", async () => {
    const { llm, captured } = makeCapturingLLM()
    const consult = advisorConsultFromLLM({
      llm,
      resolveModel: () => "gpt-5",
      transcriptSource: () => transcript(),
    })
    await consult({ question: "should I use X or Y?" })
    // forwardHistory absent ⇒ transcript NOT injected.
    expect(captured()).toBe("should I use X or Y?")
    expect(captured()).not.toContain("transcript begin")
  })

  test("forwardHistory + explicit context ⇒ transcript precedes the hand-written context", async () => {
    const { llm, captured } = makeCapturingLLM()
    const consult = advisorConsultFromLLM({
      llm,
      resolveModel: () => "gpt-5",
      transcriptSource: () => transcript(),
    })
    await consult({ question: "review", context: "EXTRA_CONTEXT_MARKER", forwardHistory: true })
    const sent = captured() as string
    expect(sent).toContain("transcript begin")
    expect(sent).toContain("EXTRA_CONTEXT_MARKER")
    expect(sent.indexOf("transcript begin")).toBeLessThan(sent.indexOf("EXTRA_CONTEXT_MARKER"))
  })
})
