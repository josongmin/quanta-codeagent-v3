/**
 * jul-08 trajectory DEBUG sidecar — platform-layer hellgate.
 *
 * The debug tier (`QUANTA_BENCH_RECORD_TRAJECTORY=debug`) lets subsystems across
 * a bench run contribute keyed debug slices that ride ALONGSIDE the recorded LLM
 * turn as `metadata.debug`. The load-bearing contract this suite pins:
 *
 *   1. GATE matrix — on iff `RECORD=debug` OR `TRAJECTORY_DEBUG` truthy.
 *   2. DEFAULT-OFF no-op — gate off ⇒ contribute is inert, drain is undefined,
 *      recorder attaches NO `debug` key (byte-identical record).
 *   3. Push + pull + CLEAR — contribute accrues, enricher samples lazily, drain
 *      empties the buffer so slices never leak across turns.
 *   4. REPLAY-NEUTRALITY (the crown invariant) — a debug-enriched record has the
 *      SAME `id` hash as the un-enriched one. Debug data lands in metadata only,
 *      so it can NEVER invalidate a cross-box cassette match.
 *
 * Strong-test discipline: every assertion observes a REAL effect (drained
 * object, appended record), each invariant has a paired control (on vs off), and
 * the neutrality test is red-on-injection — routing debug into the hash would
 * flip id equality.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { maybeRecordTrajectory, resolveBenchTrajectoryMode } from "@/apps/bench/trajectory"
import { debugSink, isTrajectoryDebugEnabled } from "@/apps/bench/trajectory-debug-sink"
import { defaultHashRequest, jsonlReplayStore, recordingLlmPort } from "@/llm/replay"
import type { RecordedInteraction } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
const DEBUG_KEY = "QUANTA_BENCH_TRAJECTORY_DEBUG"

let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = { [RECORD_KEY]: process.env[RECORD_KEY], [DEBUG_KEY]: process.env[DEBUG_KEY] }
  delete process.env[RECORD_KEY]
  delete process.env[DEBUG_KEY]
  debugSink.reset()
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  debugSink.reset()
})

// ── test doubles ──────────────────────────────────────────────────────────
function req(text: string): StreamInput {
  return { messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [] }
}
function stubInner(events: StreamEvent[]) {
  return {
    model: "stub-model",
    stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      async function* gen(): AsyncIterable<StreamEvent> {
        for (const ev of events) yield ev
      }
      return gen()
    },
  }
}
async function runToEnd(stream: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of stream) {
    /* drive to completion so the recorder commits */
  }
}
/** An in-memory store that keeps every appended record for assertion. Wraps a
 *  real store so the full ReplayStore surface (match/load/save/reset) stays
 *  type-complete; only `append` is intercepted. */
function capturingStore(path: string) {
  const store = jsonlReplayStore({ path })
  const appended: RecordedInteraction[] = []
  return {
    port: {
      ...store,
      append: async (r: RecordedInteraction) => {
        appended.push(r)
      },
    },
    appended,
  }
}

// ── 1. GATE matrix ─────────────────────────────────────────────────────────
describe("1. isTrajectoryDebugEnabled gate", () => {
  test("unset ⇒ off", () => {
    expect(isTrajectoryDebugEnabled({})).toBe(false)
  })
  test("RECORD=debug ⇒ on (case-insensitive)", () => {
    expect(isTrajectoryDebugEnabled({ [RECORD_KEY]: "debug" })).toBe(true)
    expect(isTrajectoryDebugEnabled({ [RECORD_KEY]: "DEBUG" })).toBe(true)
  })
  test("RECORD=1 (plain record, NOT debug) ⇒ off", () => {
    expect(isTrajectoryDebugEnabled({ [RECORD_KEY]: "1" })).toBe(false)
  })
  test("footgun guard: RECORD=debug is the TIER token, not a path — resolves to the default cassette", () => {
    process.env[RECORD_KEY] = "debug"
    const mode = resolveBenchTrajectoryMode()
    expect(mode.kind).toBe("record")
    // must be the default file, NOT a stray file literally named "debug"
    expect(mode.kind === "record" && mode.path).toBe(`${process.cwd()}/bench-trajectory.jsonl`)
    expect(isTrajectoryDebugEnabled()).toBe(true)
  })
  test("TRAJECTORY_DEBUG truthy ⇒ on; falsy ⇒ off", () => {
    expect(isTrajectoryDebugEnabled({ [DEBUG_KEY]: "1" })).toBe(true)
    expect(isTrajectoryDebugEnabled({ [DEBUG_KEY]: "0" })).toBe(false)
    expect(isTrajectoryDebugEnabled({ [DEBUG_KEY]: "off" })).toBe(false)
  })
})

// ── 2. default-off no-op ─────────────────────────────────────────────────────
describe("2. gate OFF ⇒ inert", () => {
  test("contribute is a no-op and drain returns undefined", () => {
    // gate off (env cleared in beforeEach)
    debugSink.contribute("toolExec", { exitCode: 1 })
    expect(debugSink.drain()).toBeUndefined()
  })
})

// ── 3. push + pull + clear ───────────────────────────────────────────────────
describe("3. gate ON ⇒ accrues, samples, clears", () => {
  beforeEach(() => {
    process.env[RECORD_KEY] = "debug"
  })
  test("contribute accrues keyed slices; drain returns them", () => {
    debugSink.contribute("toolExec", { name: "bash", exitCode: 127 })
    debugSink.contribute("editSha", { before: "aa", after: "bb" })
    const drained = debugSink.drain()
    expect(drained).toEqual({
      toolExec: { name: "bash", exitCode: 127 },
      editSha: { before: "aa", after: "bb" },
    })
  })
  test("drain CLEARS the buffer — next drain is undefined (no cross-turn leak)", () => {
    debugSink.contribute("k", 1)
    expect(debugSink.drain()).toEqual({ k: 1 })
    expect(debugSink.drain()).toBeUndefined()
  })
  test("registered enricher is sampled lazily; undefined sample is skipped", () => {
    let n = 0
    debugSink.register({ key: "counter", sample: () => ++n })
    debugSink.register({ key: "maybe", sample: () => undefined })
    expect(debugSink.drain()).toEqual({ counter: 1 })
    expect(debugSink.drain()).toEqual({ counter: 2 })
  })
  test("append accumulates many-per-turn items into an array", () => {
    debugSink.append("toolExec", { name: "read", ms: 3 })
    debugSink.append("toolExec", { name: "edit", ms: 9 })
    debugSink.append("toolExec", { name: "bash", ms: 40 })
    expect(debugSink.drain()).toEqual({
      toolExec: [
        { name: "read", ms: 3 },
        { name: "edit", ms: 9 },
        { name: "bash", ms: 40 },
      ],
    })
  })
  test("append after drain starts a fresh array (no cross-turn leak)", () => {
    debugSink.append("k", 1)
    debugSink.drain()
    debugSink.append("k", 2)
    expect(debugSink.drain()).toEqual({ k: [2] })
  })
  test("append throws if key already set to a non-array via contribute", () => {
    debugSink.contribute("k", "scalar")
    expect(() => debugSink.append("k", 1)).toThrow(/non-array/)
  })
})

// ── 4. recorder wiring + REPLAY-NEUTRALITY ──────────────────────────────────
describe("4. recordingLlmPort debugDrain wiring", () => {
  test("debug slice lands in metadata.debug", async () => {
    const { port: store, appended } = capturingStore("/tmp/tds-a.jsonl")
    const drained = { toolExec: { exitCode: 2 } }
    const p = recordingLlmPort({
      inner: stubInner([{ type: "text_delta", delta: "hi" }]),
      store,
      debugDrain: () => drained,
    })
    await runToEnd(p.stream(req("q")))
    expect(appended).toHaveLength(1)
    expect(appended[0]?.metadata.debug).toEqual(drained)
  })

  test("no debugDrain ⇒ no debug key (byte-identical metadata)", async () => {
    const { port: store, appended } = capturingStore("/tmp/tds-b.jsonl")
    const p = recordingLlmPort({ inner: stubInner([{ type: "text_delta", delta: "hi" }]), store })
    await runToEnd(p.stream(req("q")))
    expect(appended[0]?.metadata).not.toHaveProperty("debug")
  })

  test("CROWN: id hash is IDENTICAL with and without debug (replay-neutral)", async () => {
    const request = req("same-question")
    const expectedId = defaultHashRequest(request, "exact")

    const withDbg = capturingStore("/tmp/tds-c.jsonl")
    await runToEnd(
      recordingLlmPort({
        inner: stubInner([{ type: "text_delta", delta: "x" }]),
        store: withDbg.port,
        debugDrain: () => ({ heavy: { a: 1, b: [2, 3] } }),
      }).stream(request),
    )

    const noDbg = capturingStore("/tmp/tds-d.jsonl")
    await runToEnd(
      recordingLlmPort({
        inner: stubInner([{ type: "text_delta", delta: "x" }]),
        store: noDbg.port,
      }).stream(request),
    )

    // Same request ⇒ same key, regardless of debug enrichment. If debug ever
    // leaked into the hash, these would diverge (red-on-injection).
    expect(withDbg.appended[0]?.id).toBe(expectedId)
    expect(noDbg.appended[0]?.id).toBe(expectedId)
    expect(withDbg.appended[0]?.id).toBe(noDbg.appended[0]?.id as string)
  })

  test("throwing drainer never sinks the turn — record still commits, no debug key", async () => {
    const { port: store, appended } = capturingStore("/tmp/tds-e.jsonl")
    const p = recordingLlmPort({
      inner: stubInner([{ type: "text_delta", delta: "ok" }]),
      store,
      debugDrain: () => {
        throw new Error("drain boom")
      },
    })
    await runToEnd(p.stream(req("q")))
    expect(appended).toHaveLength(1)
    expect(appended[0]?.metadata).not.toHaveProperty("debug")
  })
})

// ── 5. WIRING-PROOF: trajectory.ts wires the REAL singleton sink ─────────────
// The above prove recordingLlmPort attaches whatever debugDrain returns. This
// proves the bench record path (`maybeRecordTrajectory`) actually wires the
// process-scoped `debugSink` — closing the wired-but-inert gap: a slice pushed
// to the singleton must reach `metadata.debug` on the persisted cassette.
describe("5. maybeRecordTrajectory wires the singleton (integration)", () => {
  const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
  const DEBUG_KEY = "QUANTA_BENCH_TRAJECTORY_DEBUG"
  const path = `/tmp/tds-wiring-${process.pid}.jsonl`

  afterEach(async () => {
    await rm(path, { force: true })
  })

  test("slice pushed to the real debugSink lands on the persisted record", async () => {
    // RECORD=<temp path> enables recording to a controllable file; DEBUG=1
    // turns on the tier independently (the path token stays a real path).
    process.env[RECORD_KEY] = path
    process.env[DEBUG_KEY] = "1"

    debugSink.contribute("runContextProbe", { wired: true })
    debugSink.append("toolExec", { name: "read", ms: 5 })

    const port = maybeRecordTrajectory(stubInner([{ type: "text_delta", delta: "hi" }]))
    await runToEnd(port.stream(req("wiring")))

    const records = await jsonlReplayStore({ path }).load()
    expect(records).toHaveLength(1)
    expect(records[0]?.metadata.debug).toEqual({
      runContextProbe: { wired: true },
      toolExec: [{ name: "read", ms: 5 }],
    })
  })

  test("control: DEBUG off ⇒ same push is inert, no debug key persisted", async () => {
    process.env[RECORD_KEY] = path
    delete process.env[DEBUG_KEY]

    debugSink.contribute("runContextProbe", { wired: true })
    const port = maybeRecordTrajectory(stubInner([{ type: "text_delta", delta: "hi" }]))
    await runToEnd(port.stream(req("wiring")))

    const records = await jsonlReplayStore({ path }).load()
    expect(records[0]?.metadata).not.toHaveProperty("debug")
  })
})
