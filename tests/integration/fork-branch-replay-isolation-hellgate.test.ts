import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { replayTrajectoryPort } from "@/apps/bench/trajectory"
import type { LLMPort } from "@/llm/ports"
import { type RecordedInteraction, ReplayMissError } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * HELLGATE — per-branch replay ISOLATION, the load-bearing invariant for the
 * trajectory fork-experiment's K-branch fan-out (RFC jun-23 Phase 2).
 *
 * A reviewer (jun-23) found the RFC's "K branches replay the same prefix, then
 * diverge live" claim is FALSE under the current bench wiring: the replay store
 * is stateful — `match` marks each cassette index `used` (jsonl-store.ts) — and
 * bench builds ONE replay port for the whole run (index.ts resolveLLM), reused
 * across every Best-of-N attempt. So attempt 1 consumes the prefix and attempt
 * 2+ MISS from turn 1. The fix is structural: each branch must get its OWN port
 * (fresh store ⇒ fresh `used`), NOT a shared one.
 *
 * This suite pins both halves so the bug can never silently return:
 *  - SHARED port across two passes ⇒ the second pass misses the prefix (the bug,
 *    as a regression sentinel — proves the consumption is real and why sharing
 *    is wrong).
 *  - FRESH port per branch (the contract) ⇒ both passes replay the prefix
 *    IDENTICALLY, and a MUTATED turn-N request misses ⇒ live fallback (the
 *    "fork-at-N + live divergence" story, now actually true).
 *
 * Tests the EXACT primitive Phase 2 will call (`replayTrajectoryPort`), not a
 * hand-rolled stand-in, so green here = the composed fan-out is sound.
 */

// The replayed "prefix" turn (turns 1..N-1 are deterministic).
const PREFIX_INPUT: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "turn-N-prefix-prompt" }] }],
  tools: [],
}
// A turn-N input a mutator produced — different bytes ⇒ different hash ⇒ MISS.
const MUTATED_INPUT: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "turn-N-MUTATED-by-experiment" }] }],
  tools: [],
}
const RECORDED = "REPLAYED-FROM-CASSETTE"
const LIVE = "LIVE-DIVERGED-OUTPUT"

const cassetteRow: RecordedInteraction = {
  id: "prefix-1",
  request: PREFIX_INPUT,
  events: [{ type: "text_delta", delta: RECORDED } as StreamEvent],
  metadata: { recordedAt: 0, model: "test-double", durationMs: 0 },
}

/** A live adapter standing in for the real LLM after divergence. */
const liveFallback: LLMPort = {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: LIVE } as StreamEvent
  },
}

const drain = async (port: LLMPort, input: StreamInput): Promise<string> => {
  let out = ""
  for await (const ev of port.stream(input)) {
    if (ev.type === "text_delta") out += ev.delta
  }
  return out
}

let dir: string
let cassettePath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-replay-iso-"))
  cassettePath = join(dir, "trajectory.jsonl")
  await writeFile(cassettePath, `${JSON.stringify(cassetteRow)}\n`, "utf-8")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("fork-branch replay isolation hellgate", () => {
  test("1. SENTINEL (the bug): a SHARED port consumes the prefix once — the second branch MISSES", async () => {
    // onMiss=throw with NO fallback: a miss is observable as a throw. One port,
    // two passes (= two branches sharing the bench-wired port).
    const shared = replayTrajectoryPort({ path: cassettePath, onMiss: "throw" })

    const first = await drain(shared, PREFIX_INPUT)
    expect(first).toBe(RECORDED) // branch 1 replays the prefix (a genuine HIT first)

    // branch 2 issues the SAME prefix request, but the shared `used` set already
    // consumed it ⇒ no unused match ⇒ MISS. Pin the throw to ReplayMissError so
    // this can't pass on an unrelated error (file-read / malformed cassette): the
    // ONLY admissible failure here is a replay miss caused by `used` consumption.
    await expect(drain(shared, PREFIX_INPUT)).rejects.toBeInstanceOf(ReplayMissError)
  })

  test("2. CONTRACT (the fix): a FRESH port per branch replays the prefix IDENTICALLY for both", async () => {
    // Each branch builds its own port over the SAME cassette path ⇒ fresh `used`.
    const branchA = replayTrajectoryPort({ path: cassettePath, onMiss: "throw" })
    const branchB = replayTrajectoryPort({ path: cassettePath, onMiss: "throw" })

    const a = await drain(branchA, PREFIX_INPUT)
    const b = await drain(branchB, PREFIX_INPUT)

    // Both independently replay the recorded prefix — no cross-branch consumption.
    expect(a).toBe(RECORDED)
    expect(b).toBe(RECORDED)
    expect(a).toBe(b)
  })

  test("3. FORK-AT-N: a fresh branch replays the prefix, then a MUTATED turn-N request diverges LIVE", async () => {
    // passthrough + a live fallback models "replay prefix, go live on divergence".
    const branch = replayTrajectoryPort({
      path: cassettePath,
      onMiss: "passthrough",
      fallback: liveFallback,
    })

    // turns 1..N-1: prompt matches the cassette ⇒ replayed (≈0 tokens).
    expect(await drain(branch, PREFIX_INPUT)).toBe(RECORDED)
    // turn N: the experiment mutated the input ⇒ hash miss ⇒ LIVE fallback. This
    // is the fork point — divergence happens exactly where the mutator changed
    // the bytes, with NO cassette truncation needed.
    expect(await drain(branch, MUTATED_INPUT)).toBe(LIVE)
  })

  test("4. used-set PERSISTS within a port — a hit is consumed exactly once, every later identical call misses", async () => {
    // Stronger than 'second call fails once': prove the consumption is a durable
    // monotonic state, not a one-shot toggle. A shared port called 3× with the
    // SAME request ⇒ hit, miss, miss. This is the exact state that breaks branch
    // 2+ when the bench-wired port is shared across the fan-out.
    const shared = replayTrajectoryPort({ path: cassettePath, onMiss: "throw" })
    expect(await drain(shared, PREFIX_INPUT)).toBe(RECORDED) // 1st: HIT
    await expect(drain(shared, PREFIX_INPUT)).rejects.toBeInstanceOf(ReplayMissError) // 2nd: MISS
    await expect(drain(shared, PREFIX_INPUT)).rejects.toBeInstanceOf(ReplayMissError) // 3rd: still MISS
  })
})
