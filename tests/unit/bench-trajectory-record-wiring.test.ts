import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { maybeRecordTrajectory } from "@/apps/bench"

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
const KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
let saved: string | undefined
let dir: string

beforeEach(() => {
  saved = process.env[KEY]
  delete process.env[KEY]
  dir = mkdtempSync(join(tmpdir(), "traj-"))
})
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
  rmSync(dir, { recursive: true, force: true })
})

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
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
    process.env[KEY] = "0"
    const stub = new StubLLM()
    expect(maybeRecordTrajectory(stub)).toBe(stub)
  })

  test("ON-1: knob=path ⇒ wrapped (different port)", () => {
    process.env[KEY] = join(dir, "cassette.jsonl")
    const stub = new StubLLM()
    expect(maybeRecordTrajectory(stub)).not.toBe(stub)
  })

  test("ON-2: consuming the wrapped stream writes the cassette", async () => {
    const path = join(dir, "cassette.jsonl")
    process.env[KEY] = path
    expect(existsSync(path)).toBe(false)
    await drain(maybeRecordTrajectory(new StubLLM()))
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0)
  })
})
