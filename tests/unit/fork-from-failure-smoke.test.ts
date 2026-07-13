/**
 * T-E2 — Plane A fork-from-failure: ONE documented entrypoint + end-to-end smoke.
 *
 * "Fork from failure" = replay a recorded (failed) bench trajectory up to turn N,
 * then RESUME LIVE with a different config — cheaply re-testing a
 * localization/strategy fix on a recorded failure WITHOUT re-running the whole
 * expensive run. The capability already EXISTS (it is not being built here); it
 * was just SCATTERED across `src/apps/bench/trajectory.ts` with no single named
 * home. It is now documented as one entrypoint in
 * `docs/tracing-fork-from-failure.md`.
 *
 * The named entrypoint (all in `@/apps/bench/trajectory`):
 *   1. RECORD    — `QUANTA_BENCH_RECORD_TRAJECTORY` (default-ON) writes the tape.
 *   2. FORK-AT-N — EITHER in place via `QUANTA_BENCH_REPLAY_LIMIT` (no copy) OR
 *                  as a file artifact via `truncateCassette(src, keep, dest)`.
 *   3. REPLAY+DIVERGE — `resolveBenchTrajectoryMode()` → `replayTrajectoryPort()`
 *                  with `onMiss:"record-and-passthrough"` (or `passthrough`):
 *                  the prefix replays from the cassette, and the first turn PAST
 *                  the fork point falls through to the LIVE fallback (the resumed,
 *                  reconfigured run).
 *
 * This smoke drives that composition through the PUBLIC primitives so the
 * documented path is proven runnable. It is DELIBERATELY not a duplicate of
 * `tests/integration/replay-limit-and-truncate-hellgate.test.ts` (which unit-tests
 * each primitive + env resolver); THIS asserts the FULL record→fork→resume story
 * as one narrative, and pins that the entrypoint symbols are exported.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  replayTrajectoryPort,
  resolveBenchTrajectoryMode,
  truncateCassette,
} from "@/apps/bench/trajectory"
import type { LLMPort } from "@/llm/ports"
import { jsonlReplayStore, recordingLlmPort } from "@/llm/replay"
import type { StreamEvent, StreamInput } from "@/llm/types"

const reqN = (n: number): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: `turn-${n}` }] }],
  tools: [],
})

/** A "recorded failure" model: deterministic per-turn output we capture to tape. */
const recordedModel = (label: string): LLMPort => ({
  model: "double",
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const text = (input.messages[0]?.content[0] as { text: string } | undefined)?.text ?? "?"
    yield { type: "text_delta", delta: `${label}:${text}` } as StreamEvent
  },
})

const LIVE = "RESUMED-LIVE"
/** The reconfigured resume model reached only PAST the fork point. */
const resumeModel: LLMPort = {
  model: "resume",
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
let tape: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-from-failure-"))
  tape = join(dir, "failed-run.jsonl")

  // STEP 1 — RECORD a 3-turn "failed" run to the cassette (the same
  // recordingLlmPort the bench composition wraps `resolveLLM` with).
  const rec = recordingLlmPort({ inner: recordedModel("rec"), store: jsonlReplayStore({ path: tape }) })
  for (const n of [1, 2, 3]) await drain(rec, reqN(n))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("T-E2 — fork-from-failure entrypoint (end-to-end smoke)", () => {
  test("the entrypoint symbols are all exported from @/apps/bench/trajectory", () => {
    expect(typeof truncateCassette).toBe("function")
    expect(typeof replayTrajectoryPort).toBe("function")
    expect(typeof resolveBenchTrajectoryMode).toBe("function")
  })

  test("FORK-AT-N via truncateCassette then RESUME LIVE past the fork point", async () => {
    // STEP 2 — fork at turn 2: materialize a prefix cassette (non-destructive).
    const forked = join(dir, "forked-at-2.jsonl")
    const res = await truncateCassette(tape, 2, forked)
    expect(res).toEqual({ dest: forked, kept: 2, total: 3 })

    // STEP 3 — replay the prefix, DIVERGE onto the reconfigured resume model at
    // the first turn absent from the fork.
    const port = replayTrajectoryPort({
      path: forked,
      onMiss: "record-and-passthrough",
      fallback: resumeModel,
    })
    expect(await drain(port, reqN(1))).toBe("rec:turn-1") // replayed from tape
    expect(await drain(port, reqN(2))).toBe("rec:turn-2") // replayed from tape
    expect(await drain(port, reqN(3))).toBe(LIVE) // PAST fork ⇒ resumed live
  })

  test("FORK-AT-N in place via QUANTA_BENCH_REPLAY_LIMIT resolves onto the mode", () => {
    const prevPath = process.env.QUANTA_BENCH_REPLAY_TRAJECTORY
    const prevLimit = process.env.QUANTA_BENCH_REPLAY_LIMIT
    process.env.QUANTA_BENCH_REPLAY_TRAJECTORY = tape
    process.env.QUANTA_BENCH_REPLAY_LIMIT = "2"
    try {
      const mode = resolveBenchTrajectoryMode()
      expect(mode.kind).toBe("replay")
      expect(mode.kind === "replay" && mode.limit).toBe(2)
      // And the resolved mode drives the SAME replay port (in-place fork, no copy).
      const port =
        mode.kind === "replay"
          ? replayTrajectoryPort({
              path: mode.path,
              onMiss: "passthrough",
              fallback: resumeModel,
              ...(mode.limit !== undefined ? { limit: mode.limit } : {}),
            })
          : undefined
      expect(port).toBeDefined()
    } finally {
      if (prevPath === undefined) delete process.env.QUANTA_BENCH_REPLAY_TRAJECTORY
      else process.env.QUANTA_BENCH_REPLAY_TRAJECTORY = prevPath
      if (prevLimit === undefined) delete process.env.QUANTA_BENCH_REPLAY_LIMIT
      else process.env.QUANTA_BENCH_REPLAY_LIMIT = prevLimit
    }
  })
})
