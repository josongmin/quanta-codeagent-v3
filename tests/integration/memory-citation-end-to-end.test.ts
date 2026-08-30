// ADR-0082 memory_citation provenance — integration smoke. Confirms that a
// real `runAgent` invocation with a wired memory store + recall-eligible
// entries surfaces `AgentOutcome.memoryCitations` whose rows match the entries
// that actually went into the rendered <system-reminder> tail.
//
// Provenance, not heuristic: we never inspect the assistant's response. The
// outcome's citation list is produced by the loop's `citationSink` stamped at
// the recall seam — joined with `where: "reminder_tail"` (the only render path
// quanta uses today; the static system prefix carries no per-turn data, ADR-0003).
import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { InMemoryStore } from "@/memory"
import { baseConfig, FakeLLM, text } from "./_harness"

const lastUserMessageText = (messages: FakeLLM["seenMessages"][number] | undefined): string => {
  const tail = messages?.at(-1)
  return tail?.role === "user"
    ? tail.content.map((block) => (block.type === "text" ? block.text : "")).join("")
    : ""
}

describe("memory citation end-to-end (loop surface)", () => {
  test("recall places ≥1 record → AgentOutcome.memoryCitations is populated with reminder_tail rows", async () => {
    // Seed the store with two records relevant to the user prompt so recall
    // returns them. Using durable timestamps (createdAt < now-100ms) so the
    // freshness bucket is stable.
    const store = new InMemoryStore([
      {
        id: "rec-pg",
        kind: "fact",
        text: "uses Postgres 16 with row-level security",
        tags: ["db"],
        createdAt: 1000,
        importance: 0.9,
      },
      {
        id: "rec-ts",
        kind: "fact",
        text: "TypeScript strict mode enabled",
        tags: ["lang"],
        createdAt: 1100,
        importance: 0.7,
      },
    ])

    const llm = new FakeLLM([text("ok done")])
    const out = await runAgent(
      baseConfig({
        llm,
        store,
        sessionId: "test-citation-e2e",
        messages: [{ role: "user", content: [{ type: "text", text: "tell me about Postgres" }] }],
        memory: { recallLimit: 5 },
      }),
    )
    expect(out.reason).toBe("completed")

    // The outcome surfaces citations.
    expect(out.memoryCitations).toBeDefined()
    if (!out.memoryCitations) throw new Error("memoryCitations missing")
    expect(out.memoryCitations.length).toBeGreaterThan(0)

    // Each citation row matches the contract: closed where-enum =
    // "reminder_tail" (the seam memory always rides today), recordId is a
    // string the seeded store knows about, score finite, tokensApprox
    // positive.
    const seededIds = new Set(["rec-pg", "rec-ts"])
    for (const c of out.memoryCitations) {
      expect(c.where).toBe("reminder_tail")
      expect(seededIds.has(c.recordId)).toBe(true)
      expect(Number.isFinite(c.score)).toBe(true)
      expect(c.score).toBeGreaterThan(0)
      expect(c.tokensApprox).toBeGreaterThan(0)
    }

    // The record IDs the loop reports MUST appear in the rendered reminder-
    // tail text the LLM actually saw (citation iff placed-in-prompt).
    const turnMessages = llm.seenMessages[0]
    if (!turnMessages) throw new Error("seenMessages[0] missing")
    const tailText = lastUserMessageText(turnMessages)
    expect(tailText).toContain("<system-reminder>")
    // The post-recall block uses the entry text; verify each cited record's
    // text fragment shows up in the rendered tail.
    for (const c of out.memoryCitations) {
      if (c.recordId === "rec-pg") expect(tailText).toContain("Postgres 16")
      if (c.recordId === "rec-ts") expect(tailText).toContain("TypeScript strict mode")
    }
  })

  test("no store wired → memoryCitations field is OMITTED from outcome (byte-identical legacy)", async () => {
    const out = await runAgent(
      baseConfig({
        llm: new FakeLLM([text("hi")]),
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }),
    )
    expect(out.reason).toBe("completed")
    // No store ⇒ no accumulator allocated, no citations captured, field omitted.
    expect(out.memoryCitations).toBeUndefined()
    expect("memoryCitations" in out).toBe(false)
  })

  test("store wired but empty → memoryCitations OMITTED (no recall hits across the run)", async () => {
    const out = await runAgent(
      baseConfig({
        llm: new FakeLLM([text("hi")]),
        store: new InMemoryStore(),
        sessionId: "empty",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }),
    )
    expect(out.reason).toBe("completed")
    // Empty store ⇒ accumulator allocated but never populated ⇒ field omitted.
    expect(out.memoryCitations).toBeUndefined()
  })
})
