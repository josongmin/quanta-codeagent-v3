import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StreamEvent, StreamInput } from "../../../src/llm"
import { createLLM } from "../../../src/llm/factory"

/**
 * jun-11 — `QUANTA_LLM_REPLAY` deterministic-replay seam in `createLLM`.
 *
 * Set the env to a JSONL cassette ⇒ the factory returns a cassette PLAYER instead
 * of a network adapter (no API key, no network), yielding the recorded
 * `StreamEvent`s. The request→cassette hash is pinned to a constant ("replay")
 * so a hand-authored single-turn cassette `{"id":"replay","events":[…]}` matches
 * without predicting a hash. Unlocks turn-layer e2e (reasoning render, mid-turn
 * behavior) + reproducible repro. RED before the hook existed (anthropic with no
 * key threw); GREEN after.
 */
describe("createLLM — QUANTA_LLM_REPLAY deterministic replay (jun-11)", () => {
  const writeCassette = (events: StreamEvent[]): { path: string; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), "llm-replay-"))
    const path = join(dir, "cassette.jsonl")
    writeFileSync(path, `${JSON.stringify({ id: "replay", events })}\n`)
    return { path, dir }
  }

  test("returns a cassette player that yields the recorded events (no API key)", async () => {
    const { path, dir } = writeCassette([
      { type: "thinking_delta", text: "weighing the options" },
      { type: "text_delta", delta: "the answer is 42" },
      { type: "message_stop", stop_reason: "end_turn" } as StreamEvent,
    ])
    // anthropic + NO api key would normally throw; the replay branch short-circuits.
    const llm = createLLM(
      "anthropic",
      {},
      { QUANTA_LLM_REPLAY: path } as unknown as Parameters<typeof createLLM>[2],
    )
    const got: string[] = []
    for await (const ev of llm.stream({ messages: [], system: "", tools: [] } as StreamInput)) {
      got.push(ev.type)
    }
    expect(got).toContain("thinking_delta")
    expect(got).toContain("text_delta")
    rmSync(dir, { recursive: true, force: true })
  })

  test("unset ⇒ inert: anthropic without a key still throws (replay branch not taken)", () => {
    expect(() =>
      createLLM("anthropic", {}, {} as unknown as Parameters<typeof createLLM>[2]),
    ).toThrow()
  })
})
