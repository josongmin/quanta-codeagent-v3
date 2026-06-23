import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jsonlReplayStore } from "@/llm/replay/jsonl-store"
import type { RecordedInteraction } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * HELLGATE — the replay store `limit` (fork-at-N WITHOUT a mutator).
 *
 * `limit` caps `match` to the FIRST N recorded interactions, so a replay of the
 * prefix diverges at exactly the N-th interaction (re-sample / temperature-vary
 * the tail from a chosen point). Teeth pin the window boundary precisely so an
 * off-by-one or a dropped cap is caught.
 */

const reqN = (n: number): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: `turn-${n}` }] }],
  tools: [],
})
const rowN = (n: number): RecordedInteraction => ({
  id: `i${n}`,
  request: reqN(n),
  events: [{ type: "text_delta", delta: `recorded-${n}` } as StreamEvent],
  metadata: { recordedAt: 0, model: "double", durationMs: 0 },
})

let dir: string
let path: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-limit-"))
  path = join(dir, "c.jsonl")
  // Three distinct interactions.
  await writeFile(path, [rowN(1), rowN(2), rowN(3)].map((r) => JSON.stringify(r)).join("\n"), "utf8")
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("jsonl replay store — limit window", () => {
  test("CONTROL: no limit ⇒ every recorded interaction is eligible (1, 2, 3 all hit)", async () => {
    const store = jsonlReplayStore({ path })
    expect((await store.match(reqN(1)))?.id).toBe("i1")
    expect((await store.match(reqN(2)))?.id).toBe("i2")
    expect((await store.match(reqN(3)))?.id).toBe("i3")
  })

  test("limit=2 ⇒ the first two HIT, the THIRD misses (forks at interaction 3)", async () => {
    const store = jsonlReplayStore({ path, limit: 2 })
    // Order-independent: interaction 3 is outside the eligible window even on a
    // FRESH store (nothing consumed yet) — proving it's the cap, not consumption.
    expect(await store.match(reqN(3))).toBeNull()
    expect((await store.match(reqN(1)))?.id).toBe("i1")
    expect((await store.match(reqN(2)))?.id).toBe("i2")
    // And 3 still misses after 1+2 are consumed.
    expect(await store.match(reqN(3))).toBeNull()
  })

  test("BOUNDARY: limit=1 ⇒ only interaction 1 eligible; limit=3 ⇒ same as no limit", async () => {
    const one = jsonlReplayStore({ path, limit: 1 })
    expect((await one.match(reqN(1)))?.id).toBe("i1")
    expect(await one.match(reqN(2))).toBeNull()

    const three = jsonlReplayStore({ path, limit: 3 })
    expect((await three.match(reqN(3)))?.id).toBe("i3")
  })

  test("EDGE: limit=0 ⇒ nothing replays; negative clamps to 0", async () => {
    const zero = jsonlReplayStore({ path, limit: 0 })
    expect(await zero.match(reqN(1))).toBeNull()
    const neg = jsonlReplayStore({ path, limit: -5 })
    expect(await neg.match(reqN(1))).toBeNull()
  })

  test("limit ABOVE total is harmless (clamped to length) — interaction 3 still hits", async () => {
    const store = jsonlReplayStore({ path, limit: 999 })
    expect((await store.match(reqN(3)))?.id).toBe("i3")
  })
})
