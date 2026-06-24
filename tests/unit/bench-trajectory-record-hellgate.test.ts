import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeRecordTrajectory, maybeReplayTrajectory } from "@/apps/bench"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { jsonlReplayStore, ReplayMissError, recordingLlmPort } from "@/llm/replay"

/**
 * Wiring proof: bench LLM-trajectory recording is DEFAULT-OFF and only wraps the
 * port when `QUANTA_BENCH_RECORD_TRAJECTORY` is set. When on, consuming the
 * wrapped stream writes a replayable JSONL cassette — the bench-native "fork from
 * a point" enabler (a failed remote run can be replayed/diverged after the fact).
 *
 * Red-on-injection:
 *  - always-wrap ⇒ OFF-1 (identity when knob unset) RED.
 *  - never-wrap ⇒ ON-1 (different port) + ON-2 (cassette written) RED.
 */
const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
const REPLAY_KEY = "QUANTA_BENCH_REPLAY_TRAJECTORY"
const REPLAY_ON_MISS_KEY = "QUANTA_BENCH_REPLAY_ON_MISS"
let savedRecord: string | undefined
let savedReplay: string | undefined
let savedReplayOnMiss: string | undefined
let dir: string

beforeEach(() => {
  savedRecord = process.env[RECORD_KEY]
  savedReplay = process.env[REPLAY_KEY]
  savedReplayOnMiss = process.env[REPLAY_ON_MISS_KEY]
  delete process.env[RECORD_KEY]
  delete process.env[REPLAY_KEY]
  delete process.env[REPLAY_ON_MISS_KEY]
  dir = mkdtempSync(join(tmpdir(), "traj-"))
})
afterEach(() => {
  if (savedRecord === undefined) delete process.env[RECORD_KEY]
  else process.env[RECORD_KEY] = savedRecord
  if (savedReplay === undefined) delete process.env[REPLAY_KEY]
  else process.env[REPLAY_KEY] = savedReplay
  if (savedReplayOnMiss === undefined) delete process.env[REPLAY_ON_MISS_KEY]
  else process.env[REPLAY_ON_MISS_KEY] = savedReplayOnMiss
  rmSync(dir, { recursive: true, force: true })
})

class StubLLM implements LLMPort {
  calls = 0
  constructor(private readonly text: string = "live") {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: this.text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const req = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})
const drain = async (llm: LLMPort): Promise<void> => {
  for await (const _ev of llm.stream(req())) {
    /* consume — the recorder appends after the stream completes */
  }
}

describe("bench trajectory recording gate", () => {
  test("OFF-1: knob unset ⇒ identity (byte-identical, no wrap)", () => {
    const stub = new StubLLM()
    expect(maybeRecordTrajectory(stub)).toBe(stub)
  })

  test("OFF-2: knob='0' ⇒ identity", () => {
    process.env[RECORD_KEY] = "0"
    const stub = new StubLLM()
    expect(maybeRecordTrajectory(stub)).toBe(stub)
  })

  test("ON-1: knob=path ⇒ wrapped (different port)", () => {
    process.env[RECORD_KEY] = join(dir, "cassette.jsonl")
    const stub = new StubLLM()
    expect(maybeRecordTrajectory(stub)).not.toBe(stub)
  })

  test("ON-2: consuming the wrapped stream writes the cassette", async () => {
    const path = join(dir, "cassette.jsonl")
    process.env[RECORD_KEY] = path
    expect(existsSync(path)).toBe(false)
    await drain(maybeRecordTrajectory(new StubLLM()))
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0)
  })
})

describe("bench trajectory replay gate", () => {
  test("OFF-1: knob unset ⇒ identity (byte-identical, no wrap)", () => {
    const stub = new StubLLM()
    expect(maybeReplayTrajectory(stub)).toBe(stub)
  })

  test("ON-1: exact-match replay consumes the cassette and never calls the fallback", async () => {
    const path = join(dir, "cassette.jsonl")
    const recordedInner = new StubLLM("recorded")
    const store = jsonlReplayStore({ path })
    await drain(recordingLlmPort({ inner: recordedInner, store }))
    expect(recordedInner.calls).toBe(1)

    process.env[REPLAY_KEY] = path
    const fallback = new StubLLM("fallback")
    const got: string[] = []
    for await (const ev of maybeReplayTrajectory(fallback).stream(req())) {
      if (ev.type === "text_delta") got.push(ev.delta)
    }
    expect(got).toEqual(["recorded"])
    expect(fallback.calls).toBe(0)
  })

  test("ON-2: replay defaults fail-closed on miss", async () => {
    const path = join(dir, "cassette.jsonl")
    const store = jsonlReplayStore({ path })
    await drain(recordingLlmPort({ inner: new StubLLM("recorded"), store }))

    process.env[REPLAY_KEY] = path
    const missReq = (): StreamInput => ({
      messages: [{ role: "user", content: [{ type: "text", text: "different" }] }],
      tools: [],
    })

    const port = maybeReplayTrajectory(new StubLLM("fallback"))
    await expect(
      (async () => {
        for await (const _ev of port.stream(missReq())) {
          /* drain */
        }
      })(),
    ).rejects.toBeInstanceOf(ReplayMissError)
  })

  test("ON-3: explicit record-and-passthrough opt-in diverges and appends the miss", async () => {
    const path = join(dir, "cassette.jsonl")
    process.env[REPLAY_KEY] = path
    process.env[REPLAY_ON_MISS_KEY] = "record-and-passthrough"
    const fallback = new StubLLM("fallback")

    await drain(maybeReplayTrajectory(fallback))

    expect(fallback.calls).toBe(1)
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
  })
})
