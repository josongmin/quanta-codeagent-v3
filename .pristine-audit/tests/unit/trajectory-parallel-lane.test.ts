/**
 * jul-08 PARALLEL trajectory recording — lane labeling + append integrity.
 *
 * The bench runs N candidates (repair-breadth, verify-select) CONCURRENTLY
 * through ONE shared recording port. Two things must hold for "record the
 * parallel work too":
 *
 *   1. LANE LABELING — laneLabeledPort tags each fork's calls with a lane id;
 *      the recorder lifts it into `metadata.lane` so interleaved turns stay
 *      attributable. REPLAY-NEUTRAL: the lane is stripped from the stored request
 *      and never enters the hash (same messages + different lane ⇒ SAME id).
 *   2. APPEND ORDER — concurrent `append`s to one jsonl store must land in CALL
 *      order, not completion-race order. O_APPEND keeps each line intact, but
 *      without serialization 50 concurrent appends scramble (L0,L1,L44,L9,…),
 *      which breaks the "keep first N" contract of truncateCassette / REPLAY_LIMIT.
 *      The store serializes appends behind a tail-promise mutex.
 *
 * Strong-test discipline: real effects (parsed jsonl lines, metadata), paired
 * controls (labeled vs unlabeled), and the neutrality assertion is
 * red-on-injection — routing the lane into the hash would break id equality.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { type LLMPort, laneLabeledPort } from "@/llm"
import { defaultHashRequest, jsonlReplayStore, recordingLlmPort } from "@/llm/replay"
import type { RecordedInteraction } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

function req(text: string): StreamInput {
  return { messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [] }
}
function stubInner(events: StreamEvent[], captureLane?: (l: string | undefined) => void): LLMPort {
  return {
    model: "stub-model",
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      captureLane?.(input.recordingLane)
      async function* gen(): AsyncIterable<StreamEvent> {
        for (const ev of events) yield ev
      }
      return gen()
    },
  }
}
async function runToEnd(stream: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of stream) {
    /* drive to completion */
  }
}

// ── 1. laneLabeledPort decorator ─────────────────────────────────────────────
describe("1. laneLabeledPort", () => {
  test("injects recordingLane into the stream input", async () => {
    let seen: string | undefined
    const p = laneLabeledPort(
      stubInner([{ type: "text_delta", delta: "x" }], (l) => {
        seen = l
      }),
      "repair-breadth#3",
    )
    await runToEnd(p.stream(req("q")))
    expect(seen).toBe("repair-breadth#3")
  })
  test("respects a caller-set lane (outer wrap wins)", async () => {
    let seen: string | undefined
    const p = laneLabeledPort(
      stubInner([{ type: "text_delta", delta: "x" }], (l) => {
        seen = l
      }),
      "inner",
    )
    await runToEnd(p.stream({ ...req("q"), recordingLane: "outer" }))
    expect(seen).toBe("outer")
  })
  test("delegates identity fields verbatim", () => {
    const p = laneLabeledPort({ model: "m", provider: "prov", stream: () => ({}) as never }, "L")
    expect(p.model).toBe("m")
    expect(p.provider).toBe("prov")
  })
})

// ── 2. recorder lifts lane → metadata.lane, replay-neutral ───────────────────
describe("2. recording lane in metadata", () => {
  const path = `/tmp/tpl-lane-${process.pid}.jsonl`
  afterEach(async () => {
    await rm(path, { force: true })
  })

  test("recordingLane lands in metadata.lane and is stripped from the stored request", async () => {
    const store = jsonlReplayStore({ path })
    const p = recordingLlmPort({ inner: stubInner([{ type: "text_delta", delta: "hi" }]), store })
    await runToEnd(p.stream({ ...req("q"), recordingLane: "verify-select#1" }))
    const recs = await jsonlReplayStore({ path }).load()
    expect(recs[0]?.metadata.lane).toBe("verify-select#1")
    // stripped from the persisted request (not request content)
    expect((recs[0]?.request as StreamInput).recordingLane).toBeUndefined()
  })

  test("CROWN: same messages + different lane ⇒ SAME id (lane never hashed)", async () => {
    const base = req("identical")
    const expectedId = defaultHashRequest(base, "exact")
    const a = jsonlReplayStore({ path: `${path}.a` })
    const b = jsonlReplayStore({ path: `${path}.b` })
    await runToEnd(
      recordingLlmPort({ inner: stubInner([{ type: "text_delta", delta: "y" }]), store: a }).stream(
        {
          ...base,
          recordingLane: "lane-A",
        },
      ),
    )
    await runToEnd(
      recordingLlmPort({ inner: stubInner([{ type: "text_delta", delta: "y" }]), store: b }).stream(
        {
          ...base,
          recordingLane: "lane-B",
        },
      ),
    )
    const [ra, rb] = [await a.load(), await b.load()]
    expect(ra[0]?.id).toBe(expectedId)
    expect(rb[0]?.id).toBe(expectedId)
    await rm(`${path}.a`, { force: true })
    await rm(`${path}.b`, { force: true })
  })
})

// ── 3. concurrent append order ───────────────────────────────────────────────
describe("3. append serialization under concurrency", () => {
  const path = `/tmp/tpl-concurrent-${process.pid}.jsonl`
  afterEach(async () => {
    await rm(path, { force: true })
  })

  test("N concurrent appends land in CALL ORDER (not completion-race order)", async () => {
    const store = jsonlReplayStore({ path })
    const N = 50
    const mkRec = (i: number): RecordedInteraction => ({
      id: `rec-${i}`,
      // ~15KB payload so appendFile completions genuinely race — without the
      // mutex this order scrambles (verified: L0,L1,L44,L9,…).
      request: req(`lane ${i} `.repeat(2000)),
      events: [{ type: "text_delta", delta: `body-${i}` }],
      metadata: { recordedAt: i, model: "m", durationMs: 1, lane: `repair-breadth#${i}` },
    })
    // fire all appends concurrently — the store must serialize them internally
    await Promise.all(Array.from({ length: N }, (_, i) => store.append(mkRec(i))))

    const recs = await jsonlReplayStore({ path }).load()
    expect(recs).toHaveLength(N) // none lost / torn
    // disk order === call order — the load-bearing invariant for "keep first N"
    const order = recs.map((r) => r.metadata.lane)
    const expectedOrder = Array.from({ length: N }, (_, i) => `repair-breadth#${i}`)
    expect(order).toEqual(expectedOrder)
  })

  test("parallel recording ports sharing one store → every lane's turn recorded", async () => {
    const store = jsonlReplayStore({ path })
    const LANES = 8
    await Promise.all(
      Array.from({ length: LANES }, (_, i) => {
        const lane = laneLabeledPort(
          recordingLlmPort({ inner: stubInner([{ type: "text_delta", delta: `d${i}` }]), store }),
          `repair-breadth#${i}`,
        )
        return runToEnd(lane.stream(req(`candidate ${i}`)))
      }),
    )
    const recs = await jsonlReplayStore({ path }).load()
    expect(recs).toHaveLength(LANES)
    expect(new Set(recs.map((r) => r.metadata.lane)).size).toBe(LANES)
  })
})
