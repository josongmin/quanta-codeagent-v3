import { describe, expect, test } from "bun:test"
import { createAutoClassifierPort } from "@/agent/auto-classifier"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ClassifyRequest } from "@/permission"

/** Mock LLMPort: yields a scripted reply as text deltas, recording every
 *  StreamInput it was called with so cache/forwarding can be asserted. */
class MockLLM implements LLMPort {
  calls: StreamInput[] = []
  private replies: string[]
  constructor(...replies: string[]) {
    this.replies = replies
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls.push(input)
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)] ?? ""
    yield { type: "text_delta", delta: reply }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class ThrowingLLM implements LLMPort {
  // biome-ignore lint/correctness/useYield: intentionally throws before yielding
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("upstream down")
  }
}

/** Index into a captured array, throwing if the slot is absent — same
 *  fail-on-missing contract the previous `arr[i]!` assertions had, with an
 *  explicit runtime guard instead of a compile-only assertion. */
const at = <T>(arr: readonly T[], i: number): T => {
  const v = arr[i]
  if (v === undefined) throw new Error(`expected element at index ${i}`)
  return v
}

const req = (over: Partial<ClassifyRequest> = {}): ClassifyRequest => ({
  tool: "Bash",
  input: { command: "ls -la" },
  systemPrompt: "SYS-PROMPT",
  stage: "fast",
  ...over,
})

describe("createAutoClassifierPort", () => {
  test("allow path: <block>no</block> ⇒ allow", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    const d = await port(req())
    expect(d.verdict).toBe("allow")
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("block path: yes + reason ⇒ block with the model's reason", async () => {
    const llm = new MockLLM("<block>yes</block><reason>rm -rf on shared infra</reason>")
    const port = createAutoClassifierPort({ llm })
    const d = await port(req({ input: { command: "rm -rf /" } }))
    expect(d.verdict).toBe("block")
    expect(d.reason).toBe("rm -rf on shared infra")
  })

  test("block path without closing </block> (stage-1 stop sequence) still parses", async () => {
    const llm = new MockLLM("<block>yes")
    const port = createAutoClassifierPort({ llm })
    const d = await port(req())
    expect(d.verdict).toBe("block")
  })

  test("unparseable reply ⇒ fail-safe block", async () => {
    const llm = new MockLLM("I think this looks fine, proceed.")
    const port = createAutoClassifierPort({ llm })
    const d = await port(req())
    expect(d.verdict).toBe("block")
    expect(d.reason).toBe("classifier response unparseable (failed safe)")
  })

  test("stream error ⇒ fail-safe block, never throws", async () => {
    const port = createAutoClassifierPort({ llm: new ThrowingLLM() })
    const d = await port(req())
    expect(d.verdict).toBe("block")
    expect(d.reason).toBe("classifier response unparseable (failed safe)")
  })

  test("system prompt forwarded as a single cached SystemBlock", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    await port(req({ systemPrompt: "THREAT-TAXONOMY" }))
    const sys = at(llm.calls, 0).system
    expect(Array.isArray(sys)).toBe(true)
    expect(sys).toEqual([{ type: "text", text: "THREAT-TAXONOMY", cache: true }])
  })

  test("user message wraps tool + input (+ context) in <transcript>", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    await port(req({ recentContext: "User: clean up the repo" }))
    const msg = at(at(llm.calls, 0).messages, 0)
    expect(msg.role).toBe("user")
    const block = at(msg.content, 0)
    const text = block.type === "text" ? block.text : ""
    expect(text).toContain("<transcript>")
    expect(text).toContain("User: clean up the repo")
    expect(text).toContain("Bash")
    expect(text).toContain("ls -la")
  })

  test("cache hit: two identical requests ⇒ LLM called once", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    const a = await port(req())
    const b = await port(req())
    expect(a).toEqual(b)
    expect(llm.calls.length).toBe(1)
  })

  test("cache key is canonical: key-reordered input still hits cache", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    await port(req({ input: { a: 1, b: 2 } }))
    await port(req({ input: { b: 2, a: 1 } }))
    expect(llm.calls.length).toBe(1)
  })

  test("cache TTL expiry: re-queries after TTL with injected clock", async () => {
    let t = 1_000
    const llm = new MockLLM("<block>no</block>", "<block>yes</block><reason>changed</reason>")
    const port = createAutoClassifierPort({ llm, cacheTtlMs: 5_000, now: () => t })
    const first = await port(req())
    expect(first.verdict).toBe("allow")

    t += 4_999 // still within TTL
    await port(req())
    expect(llm.calls.length).toBe(1)

    t += 2 // now past expiry (1000 + 5000 < 6001)
    const third = await port(req())
    expect(llm.calls.length).toBe(2)
    expect(third.verdict).toBe("block")
  })

  test("distinct inputs miss the cache", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    await port(req({ input: { command: "ls" } }))
    await port(req({ input: { command: "pwd" } }))
    expect(llm.calls.length).toBe(2)
  })

  test("distinct stages miss the cache (fast vs thinking)", async () => {
    const llm = new MockLLM("<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    await port(req({ stage: "fast" }))
    await port(req({ stage: "thinking" }))
    expect(llm.calls.length).toBe(2)
  })

  test("fail-safe verdicts are NOT cached (transient errors must not stick)", async () => {
    const llm = new MockLLM("garbage", "<block>no</block>")
    const port = createAutoClassifierPort({ llm })
    const first = await port(req())
    expect(first.verdict).toBe("block")
    const second = await port(req())
    expect(llm.calls.length).toBe(2)
    expect(second.verdict).toBe("allow")
  })
})
