import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { EMBED_DIM, type EmbedderPort, InMemoryStore } from "@/memory"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

/**
 * End-to-end SOTA++ memory wiring exercised through the REAL `runAgent`:
 * two sessions over one shared `InMemoryStore` with a deterministic fake LLM
 * + fake embedder. Asserts distill→persist→embed (session 1), recall into the
 * turn payload + reinforcement (session 2), and a behavior-preserving control
 * run with no store/embedder. Fakes are self-contained to this file.
 */

const DISTILL_MARKER = "You distill durable long-term memory"

/**
 * Scriptable fake LLM. Records every {@link StreamInput} it saw. Branches on
 * the last user message text: a distillation prompt → emit the scripted JSON
 * array; any normal turn → emit a final assistant text (no tool calls), so the
 * loop completes in exactly one turn.
 */
class FakeLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  constructor(
    private readonly distillJson: string,
    private readonly finalText = "done",
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
    const lastText = (lastUser?.content ?? [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    const out = lastText.includes(DISTILL_MARKER) ? this.distillJson : this.finalText
    yield { type: "text_delta", delta: out }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Collects emitted agent events (no-op sink otherwise). */
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/**
 * Deterministic embedder: a seeded LCG fills a 1536-dim vector from the input
 * text. Equal text ⇒ identical vector (cosine 1). {@link vary} produces a
 * deliberately different seed so "different" text yields a low-similarity vec.
 */
class FakeEmbedder implements EmbedderPort {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => seededVec(t)))
  }
}

const seededVec = (text: string): number[] => {
  let s = 2166136261
  for (let i = 0; i < text.length; i++) {
    s = (s ^ text.charCodeAt(i)) * 16777619
    s >>>= 0
  }
  const v = new Array<number>(EMBED_DIM)
  let x = s || 1
  for (let i = 0; i < EMBED_DIM; i++) {
    x = (1103515245 * x + 12345) >>> 0
    v[i] = (x / 0xffffffff) * 2 - 1
  }
  return v
}

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry([]),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 2,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const FACT_TEXT = "user prefers tabs over spaces"
const DISTILL_S1 = JSON.stringify([
  { kind: "fact", tier: "semantic", text: FACT_TEXT, tags: ["preference"], importance: 0.9 },
])

describe("agent + SOTA++ memory (e2e through runAgent)", () => {
  test("session 1 distills+embeds, session 2 recalls into the turn + reinforces", async () => {
    const store = new InMemoryStore()
    const embedder = new FakeEmbedder()

    // --- Session 1: complete in one turn, then distill persists the fact. ---
    const llm1 = new FakeLLM(DISTILL_S1, "implemented the change")
    const out1 = await runAgent(
      cfg({
        llm: llm1,
        store,
        embedder,
        sessionId: "s1",
        messages: [{ role: "user", content: [{ type: "text", text: "set the indent style" }] }],
      }),
    )
    expect(out1.reason).toBe("completed")
    expect(out1.turns).toBe(1)

    // Assertion 1: store holds the distilled entry, embedded + tagged.
    const all = await store.all()
    expect(all.length).toBe(1)
    const entry = all[0]
    if (!entry) throw new Error("expected one persisted entry")
    expect(entry.kind).toBe("fact")
    expect(entry.text).toBe(FACT_TEXT)
    expect(entry.importance).toBeCloseTo(0.9, 5)
    expect(entry.embedding?.length).toBe(EMBED_DIM)
    const accessBefore = entry.accessCount ?? 0
    expect(entry.lastAccessedAt).toBeUndefined()

    // --- Session 2: recall must surface the fact into what the LLM sees. ---
    const llm2 = new FakeLLM(JSON.stringify([]), "acknowledged")
    const out2 = await runAgent(
      cfg({
        llm: llm2,
        store,
        embedder,
        sessionId: "s2",
        messages: [{ role: "user", content: [{ type: "text", text: "what indent do I like" }] }],
      }),
    )
    expect(out2.reason).toBe("completed")
    expect(out2.turns).toBe(1)

    // Assertion 2: the recalled "## Memory hints (routing hints only — not proof)" rides the trailing
    // <system-reminder> user message of session 2's first (non-distill) turn.
    const turnInput = llm2.inputs.find((i) => {
      const lastUser = [...i.messages].reverse().find((m) => m.role === "user")
      const t = (lastUser?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n")
      return !t.includes(DISTILL_MARKER)
    })
    expect(turnInput).toBeDefined()
    const tail = turnInput?.messages.at(-1)
    const tailText =
      tail?.role === "user"
        ? tail.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        : ""
    expect(tailText).toContain("<system-reminder>")
    expect(tailText).toContain("## Memory hints (routing hints only — not proof)")
    expect(tailText).toContain(FACT_TEXT)

    // Assertion 3: reinforcement bumped access bookkeeping after recall.
    const reinforced = (await store.all())[0]
    if (!reinforced) throw new Error("expected entry to persist across sessions")
    expect(reinforced.accessCount ?? 0).toBeGreaterThan(accessBefore)
    expect(typeof reinforced.lastAccessedAt).toBe("number")
  })

  test("behavior-preserving control: no store + no embedder runs identically", async () => {
    const llm = new FakeLLM(JSON.stringify([]), "final answer")
    const out = await runAgent(
      cfg({
        llm,
        messages: [{ role: "user", content: [{ type: "text", text: "just answer" }] }],
      }),
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    // No distillation call happens without a store: exactly one LLM stream.
    expect(llm.inputs.length).toBe(1)
    const onlyInput = llm.inputs[0]
    if (!onlyInput) throw new Error("expected one llm call")
    const tail = onlyInput.messages.at(-1)
    const tailText =
      tail?.role === "user"
        ? tail.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        : ""
    expect(tailText).not.toContain("## Memory hints (routing hints only — not proof)")
  })
})
