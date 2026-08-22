import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  replayTrajectoryPort,
  resolveBenchTrajectoryMode,
  truncateCassette,
} from "@/apps/bench/trajectory"
import type { LLMPort } from "@/llm/ports"
import type { RecordedInteraction } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * HELLGATE — `QUANTA_BENCH_REPLAY_LIMIT` (in-place fork-at-N, no mutator) and
 * `truncateCassette` (the file-artifact equivalent), proven through the bench
 * primitives + the env resolver. Covers the operator path end-to-end:
 *   - the env resolves onto the replay mode and reaches the replay port;
 *   - a limited port replays the prefix then DIVERGES LIVE at the cap;
 *   - truncateCassette produces a byte-faithful prefix copy without touching src;
 *   - invalid env fails loud.
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
const LIVE = "LIVE-DIVERGED"
const liveFallback: LLMPort = {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: LIVE } as StreamEvent
  },
}
const drain = async (port: LLMPort, input: StreamInput): Promise<string> => {
  let out = ""
  for await (const ev of port.stream(input)) if (ev.type === "text_delta") out += ev.delta
  return out
}

let dir: string
let path: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-trunc-"))
  path = join(dir, "c.jsonl")
  await writeFile(
    path,
    [rowN(1), rowN(2), rowN(3), rowN(4), rowN(5)].map((r) => JSON.stringify(r)).join("\n"),
    "utf8",
  )
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("QUANTA_BENCH_REPLAY_LIMIT — env resolution", () => {
  const withEnv = <T>(v: string | undefined, fn: () => T): T => {
    const prev = process.env.QUANTA_BENCH_REPLAY_TRAJECTORY
    const prevLimit = process.env.QUANTA_BENCH_REPLAY_LIMIT
    process.env.QUANTA_BENCH_REPLAY_TRAJECTORY = path
    if (v === undefined) delete process.env.QUANTA_BENCH_REPLAY_LIMIT
    else process.env.QUANTA_BENCH_REPLAY_LIMIT = v
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.QUANTA_BENCH_REPLAY_TRAJECTORY
      else process.env.QUANTA_BENCH_REPLAY_TRAJECTORY = prev
      if (prevLimit === undefined) delete process.env.QUANTA_BENCH_REPLAY_LIMIT
      else process.env.QUANTA_BENCH_REPLAY_LIMIT = prevLimit
    }
  }

  test("a valid limit lands on the resolved replay mode; absent ⇒ no cap", () => {
    const limited = withEnv("2", () => resolveBenchTrajectoryMode())
    expect(limited.kind).toBe("replay")
    expect(limited.kind === "replay" && limited.limit).toBe(2)

    const unlimited = withEnv(undefined, () => resolveBenchTrajectoryMode())
    expect(unlimited.kind === "replay" && unlimited.limit).toBeUndefined()
  })

  test("invalid limit FAILS LOUD (not silently ignored)", () => {
    expect(() => withEnv("two", () => resolveBenchTrajectoryMode())).toThrow(
      /QUANTA_BENCH_REPLAY_LIMIT/,
    )
    expect(() => withEnv("-3", () => resolveBenchTrajectoryMode())).toThrow(
      /QUANTA_BENCH_REPLAY_LIMIT/,
    )
    expect(() => withEnv("1.5", () => resolveBenchTrajectoryMode())).toThrow(
      /QUANTA_BENCH_REPLAY_LIMIT/,
    )
  })
})

describe("replayTrajectoryPort with limit — prefix replays, tail diverges LIVE", () => {
  test("limit=2 ⇒ turns 1,2 replay from cassette; turn 3 goes live (fork-at-N, no mutator)", async () => {
    const port = replayTrajectoryPort({
      path,
      onMiss: "passthrough",
      fallback: liveFallback,
      limit: 2,
    })
    expect(await drain(port, reqN(1))).toBe("recorded-1") // replayed
    expect(await drain(port, reqN(2))).toBe("recorded-2") // replayed
    expect(await drain(port, reqN(3))).toBe(LIVE) // past the cap ⇒ live divergence
  })

  test("CONTROL: no limit ⇒ turn 3 also replays (proves the cap, not chance)", async () => {
    const port = replayTrajectoryPort({ path, onMiss: "passthrough", fallback: liveFallback })
    expect(await drain(port, reqN(3))).toBe("recorded-3")
  })
})

describe("truncateCassette — byte-faithful prefix copy, source untouched", () => {
  test("keep=2 ⇒ dest has exactly the first 2; src unchanged; counts reported", async () => {
    const dest = join(dir, "trunc-2.jsonl")
    const res = await truncateCassette(path, 2, dest)
    expect(res).toEqual({ dest, kept: 2, total: 5 })

    // dest is the first two interactions, in order.
    const lines = (await readFile(dest, "utf8")).trim().split("\n")
    expect(lines.length).toBe(2)
    expect((JSON.parse(lines[0] as string) as RecordedInteraction).id).toBe("i1")
    expect((JSON.parse(lines[1] as string) as RecordedInteraction).id).toBe("i2")

    // SOURCE is untouched (still 5 lines) — truncate is non-destructive.
    expect((await readFile(path, "utf8")).trim().split("\n").length).toBe(5)
  })

  test("EDGE: keep<=0 ⇒ empty cassette; keep>=total ⇒ full copy", async () => {
    const empty = join(dir, "trunc-0.jsonl")
    expect((await truncateCassette(path, 0, empty)).kept).toBe(0)
    expect((await readFile(empty, "utf8")).trim()).toBe("")

    const full = join(dir, "trunc-all.jsonl")
    const r = await truncateCassette(path, 999, full)
    expect(r.kept).toBe(5)
    expect((await readFile(full, "utf8")).trim().split("\n").length).toBe(5)
  })

  test("SAFETY: dest === src is refused (truncation must not overwrite the source)", async () => {
    await expect(truncateCassette(path, 2, path)).rejects.toThrow(/dest must differ from src/)
    // src is intact after the refused call.
    expect((await readFile(path, "utf8")).trim().split("\n").length).toBe(5)
  })

  test("a truncated cassette replayed with passthrough diverges live past its end", async () => {
    const dest = join(dir, "trunc-fork.jsonl")
    await truncateCassette(path, 2, dest)
    const port = replayTrajectoryPort({ path: dest, onMiss: "passthrough", fallback: liveFallback })
    expect(await drain(port, reqN(1))).toBe("recorded-1")
    expect(await drain(port, reqN(2))).toBe("recorded-2")
    expect(await drain(port, reqN(3))).toBe(LIVE) // not in the truncated file ⇒ live
  })
})
