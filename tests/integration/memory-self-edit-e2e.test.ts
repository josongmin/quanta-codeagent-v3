import { describe, expect, test } from "bun:test"
import { memoryTools, NullEmbedder, runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { InMemoryStore } from "@/memory"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the self-edit memory tools
 * (`memory_write` / `memory_search`, RFC §6.3 / feature `memory-self-edit-tools`).
 *
 * These are agent tools the MODEL invokes MID-LOOP. Prior coverage only calls
 * `tool.execute(...)` DIRECTLY in unit tests (`tests/unit/memory-tools.test.ts`)
 * or fetches the tool off a `Tooling.registry` and calls `.execute` by hand
 * (`memory-mode-knob-wire-hellgate.test.ts`). NONE drives the tool through
 * `runAgent`'s real dispatch from a scripted `tool_use` block — so the chain
 *
 *   scripted LLM emits `memory_write` tool_use
 *     → runAgent dispatches through the registry
 *       → the DURABLE store actually changes (fresh readback)
 *       → the `tool_result` is fed back and the NEXT turn's `memory_search`
 *         (also dispatched) surfaces the just-written record to the model
 *
 * was `runAgent × scripted-LLM == 0`. This closes that gap and, via the
 * neuter-control test, proves the assertion is non-vacuous (removing the tools
 * from the registry ⇒ the store never changes and the search never surfaces).
 *
 * Offline: a {@link NullEmbedder} (empty vectors, no network) so recall falls
 * back to lexical text scoring over the {@link InMemoryStore}.
 */

// A distinctive statement the model writes then later searches for. If the
// self-edit tools truly dispatch through the loop, this must survive into the
// durable store AND resurface in the search tool_result the next turn reads.
const MEMO_TEXT = "the deploy runbook lives at ops/deploy/RUNBOOK-SELFEDIT-42.md"
const MEMO_QUERY = "RUNBOOK-SELFEDIT-42"

const writeCall = (id: string, textVal: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "memory_write" },
  { type: "tool_use_end", id, input: { text: textVal, kind: "fact", importance: 0.9 } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const searchCall = (id: string, query: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "memory_search" },
  { type: "tool_use_end", id, input: { query } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const convo = (i: StreamInput): string =>
  i.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/**
 * Three-phase scripted model that also RECORDS the full text (incl. the
 * `tool_result` payloads) it saw each turn — so we can prove the search
 * tool_result actually reached a later turn's model input.
 *
 *   turn 1: emit `memory_write`
 *   turn 2 (after the write tool_result): emit `memory_search`
 *   turn 3 (after the search tool_result): end the turn
 */
class SelfEditLLM implements LLMPort {
  readonly model = "self-edit-test-model"
  readonly seenTurns: string[] = []
  private step = 0
  async *stream(i: StreamInput): AsyncIterable<StreamEvent> {
    this.seenTurns.push(convo(i))
    const n = this.step++
    if (n === 0) {
      yield* writeCall("w1", MEMO_TEXT)
      return
    }
    if (n === 1) {
      yield* searchCall("s1", MEMO_QUERY)
      return
    }
    yield* text("done — memory recorded and recalled")
  }
}

describe("self-edit memory tools — real loop dispatch through runAgent", () => {
  test("scripted LLM writes then searches ⇒ store mutated (fresh readback) + tool_result reaches next turn", async () => {
    __resetRuntimeConfig()
    const store = new InMemoryStore()
    const embedder = new NullEmbedder()
    // Pre-condition: nothing in the durable store yet.
    expect((await store.all()).length).toBe(0)

    const llm = new SelfEditLLM()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          // The REAL registry the loop dispatches over carries the self-edit
          // tools bound to THIS store (+ offline embedder). This is exactly
          // what `buildToolingCore` wires in production.
          registry: new ToolRegistry([...defaultTools, ...memoryTools({ store, embedder })]),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "record the runbook location, then look it up" }],
            },
          ],
          maxTurns: 8,
        }),
      ),
      15_000,
      "memory-self-edit-e2e",
    )

    // 1. The loop ran all three scripted turns to completion.
    expect(out.reason).toBe("completed")
    expect(llm.seenTurns.length).toBeGreaterThanOrEqual(3)

    // 2. LOAD-BEARING: `memory_write` dispatched through the loop and the
    //    DURABLE store actually changed — proven by a FRESH readback (not the
    //    tool's return string). Exactly one entry, carrying the written text.
    const persisted = await store.all()
    expect(persisted.length).toBe(1)
    const entry = persisted[0]
    if (!entry) throw new Error("expected one persisted entry")
    expect(entry.text).toBe(MEMO_TEXT)
    expect(entry.kind).toBe("fact")
    expect(entry.importance).toBeCloseTo(0.9, 5)
    // NullEmbedder yields empty vectors which `tryEmbed` drops ⇒ no embedding.
    expect(entry.embedding).toBeUndefined()

    // 3. LOAD-BEARING: the WRITE tool_result reached the model on turn 2 — the
    //    scripted model only emitted `memory_search` because it consumed the
    //    "Saved memory …" result from turn 1's dispatch.
    const turn2 = llm.seenTurns[1] ?? ""
    expect(turn2).toContain(`Saved memory ${entry.id}`)

    // 4. LOAD-BEARING: the SEARCH tool_result (which surfaces the just-written
    //    record) reached the model on turn 3 — the search actually queried the
    //    live store and found the fresh entry.
    const turn3 = llm.seenTurns[2] ?? ""
    expect(turn3).toContain(entry.id)
    expect(turn3).toContain(MEMO_QUERY)
  })

  test("NEUTER control: registry WITHOUT the memory tools ⇒ store never changes, search never surfaces (non-vacuous)", async () => {
    __resetRuntimeConfig()
    const store = new InMemoryStore()
    const embedder = new NullEmbedder()

    const llm = new SelfEditLLM()
    // Same scripted `memory_write` / `memory_search` calls, but the loop's
    // registry does NOT contain the self-edit tools — dispatch cannot execute
    // them. If the load-bearing assertions above were vacuous (e.g. asserting
    // on the tool's own echo instead of a real store mutation), this control
    // would still pass them; it must NOT.
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry([...defaultTools]),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "record the runbook location, then look it up" }],
            },
          ],
          maxTurns: 8,
        }),
      ),
      15_000,
      "memory-self-edit-e2e-neuter",
    )

    expect(out.reason).toBe("completed")
    // INVERSE of the MAIN test's load-bearing assertion #2: with the tools
    // absent from the registry, the fresh readback is EMPTY (no dispatch ⇒ no
    // store mutation). This is the exact discriminator that makes the main
    // `persisted.length === 1` non-vacuous.
    expect((await store.all()).length).toBe(0)
    // INVERSE of #3/#4: no later turn ever saw a "Saved memory …" nor the
    // searched record id — the unknown-tool path returns an error result, not a
    // persisted record echoed back through the tool_result.
    const anyTurnSurfacedTheMemo = llm.seenTurns.some((t) => t.includes("Saved memory mem:tool:"))
    expect(anyTurnSurfacedTheMemo).toBe(false)
    const anyTurnSurfacedTheQueryHit = llm.seenTurns.some((t) => t.includes("#mem:tool:"))
    expect(anyTurnSurfacedTheQueryHit).toBe(false)
  })
})
