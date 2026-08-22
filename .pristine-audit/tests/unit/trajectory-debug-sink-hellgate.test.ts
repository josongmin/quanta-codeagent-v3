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
import { join } from "node:path"
import { contributeEditTraceDebug, contributeVerdictDebug } from "@/apps/bench/eval/driver"
import { maybeRecordTrajectory, resolveBenchTrajectoryMode } from "@/apps/bench/trajectory"
import { debugSink, isTrajectoryDebugEnabled } from "@/apps/bench/trajectory-debug-sink"
import { defaultHashRequest, jsonlReplayStore, recordingLlmPort } from "@/llm/replay"
import type { RecordedInteraction } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { benchHome } from "@/runner/batch/corpus/paths"
import { laneContext } from "@/shared"

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
    // must be the UNIFIED default cassette (<benchHome>/runs/<runId>/trajectory.jsonl),
    // NOT a stray file literally named "debug"
    const path = mode.kind === "record" ? mode.path : undefined
    expect(path?.startsWith(`${join(benchHome(), "runs")}/`)).toBe(true)
    expect(path?.endsWith("/trajectory.jsonl")).toBe(true)
    expect(path).not.toContain("debug")
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

// ── 3b. PARALLEL-LANE isolation (per-lane buffers) ──────────────────────────
// The live toolExec contributor + parallel candidates would cross-contaminate a
// single shared buffer. Under laneContext, each lane's contributions and its
// drain see only that lane's bucket. This is the fix the platform's contract
// promised; without per-lane keying lane A's drain would steal lane B's slices.
describe("3b. per-lane isolation under laneContext", () => {
  beforeEach(() => {
    process.env[RECORD_KEY] = "debug"
  })
  test("concurrent lanes buffer + drain independently (no cross-attribution)", async () => {
    // Two lanes interleave appends within their OWN laneContext, then each drains.
    const drainA = await laneContext.run("repair-breadth#0", async () => {
      debugSink.append("toolExec", { name: "readA" })
      // yield so the sibling lane interleaves before we drain
      await Promise.resolve()
      debugSink.append("toolExec", { name: "editA" })
      return { drain: () => debugSink.drain() }
    })
    const drainB = await laneContext.run("repair-breadth#1", async () => {
      debugSink.append("toolExec", { name: "readB" })
      await Promise.resolve()
      return { drain: () => debugSink.drain() }
    })
    // Each lane's drain, run under its own context, yields ONLY its own slices.
    const a = await laneContext.run("repair-breadth#0", async () => drainA.drain())
    const b = await laneContext.run("repair-breadth#1", async () => drainB.drain())
    expect(a).toEqual({ toolExec: [{ name: "readA" }, { name: "editA" }] })
    expect(b).toEqual({ toolExec: [{ name: "readB" }] })
  })
  test("serial (no lane context) uses one default bucket — byte-identical", () => {
    debugSink.append("toolExec", { name: "s1" })
    debugSink.contribute("verdict", { passed: true })
    expect(debugSink.drain()).toEqual({
      toolExec: [{ name: "s1" }],
      verdict: { passed: true },
    })
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

// ── 6. VERDICT enricher (jul-13, ADR-0539) ──────────────────────────────────
// The driver's verify-finalize sites call `contributeVerdictDebug(result)` (the
// SSOT both `runInstanceOnce` paths use) so the grade outcome rides
// `metadata.debug.verdict` of the recorded turn — mirroring `toolExec`. These
// tests pin the PRODUCER contract: deleting the `contribute("verdict", …)` inside
// contributeVerdictDebug makes the "verdict rides the record" assertion RED. The
// gate-off control + a CROWN neutrality assertion pin default-off + replay-safety.
describe("6. verdict enricher (contributeVerdictDebug)", () => {
  const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
  const DEBUG_KEY = "QUANTA_BENCH_TRAJECTORY_DEBUG"
  const path = `/tmp/tds-verdict-${process.pid}.jsonl`

  afterEach(async () => {
    await rm(path, { force: true })
  })

  test("ON ⇒ verdict payload rides metadata.debug.verdict on the recorded turn", async () => {
    process.env[RECORD_KEY] = path
    process.env[DEBUG_KEY] = "1"

    // producer: the driver contributes at the verify-finalize site.
    contributeVerdictDebug({ passed: true, patch: "aaa", verdict: "ok" })

    const port = maybeRecordTrajectory(stubInner([{ type: "text_delta", delta: "hi" }]))
    await runToEnd(port.stream(req("verdict-q")))

    const records = await jsonlReplayStore({ path }).load()
    expect(records).toHaveLength(1)
    // patchBytes = "aaa".length = 3; observationVerdict carried when present.
    expect((records[0]?.metadata.debug as Record<string, unknown> | undefined)?.verdict).toEqual({
      passed: true,
      patchBytes: 3,
      observationVerdict: "ok",
    })
  })

  test("optional fields omitted when absent (lean payload)", () => {
    process.env[RECORD_KEY] = "debug"
    contributeVerdictDebug({ passed: false, patch: "" })
    expect(debugSink.drain()).toEqual({ verdict: { passed: false, patchBytes: 0 } })
  })

  test("carries the harness error summary when present", () => {
    process.env[RECORD_KEY] = "debug"
    contributeVerdictDebug({ passed: false, patch: "x", verdict: "grader_invalid", error: "boom" })
    expect(debugSink.drain()).toEqual({
      verdict: {
        passed: false,
        patchBytes: 1,
        observationVerdict: "grader_invalid",
        error: "boom",
      },
    })
  })

  test("control: DEBUG off ⇒ contributeVerdictDebug is inert, no verdict key", async () => {
    process.env[RECORD_KEY] = path
    delete process.env[DEBUG_KEY]

    contributeVerdictDebug({ passed: true, patch: "aaa", verdict: "ok" })
    const port = maybeRecordTrajectory(stubInner([{ type: "text_delta", delta: "hi" }]))
    await runToEnd(port.stream(req("verdict-q")))

    const records = await jsonlReplayStore({ path }).load()
    expect(records[0]?.metadata).not.toHaveProperty("debug")
  })

  test("CROWN: verdict enrichment does NOT perturb the request id hash", async () => {
    const request = req("verdict-neutral")
    const expectedId = defaultHashRequest(request, "exact")

    process.env[RECORD_KEY] = "debug"
    const withVerdict = capturingStore("/tmp/tds-verdict-crown.jsonl")
    contributeVerdictDebug({ passed: true, patch: "zz", verdict: "ok" })
    await runToEnd(
      recordingLlmPort({
        inner: stubInner([{ type: "text_delta", delta: "x" }]),
        store: withVerdict.port,
        debugDrain: () => debugSink.drain(),
      }).stream(request),
    )

    // request hash is keyed off `request` only — the verdict slice rides metadata.
    expect(withVerdict.appended[0]?.id).toBe(expectedId)
    expect(
      (withVerdict.appended[0]?.metadata.debug as Record<string, unknown> | undefined)?.verdict,
    ).toEqual({ passed: true, patchBytes: 2, observationVerdict: "ok" })
  })
})

// ── 7. EDITTRACE enricher (jul-13, ADR-0539) — the THIRD/final contributor ───
// The bench SDK driver wires `contributeEditTraceDebug` as BenchStreamTap's
// `onEditResult` (gated by isTrajectoryDebugEnabled). Per edit it APPENDS a
// shaped trace (mode/outcome/occurrences/fuzzy-escalation, all from the edit's
// OWN output message — no recompute) onto `metadata.debug.editTrace` as a LIST,
// so multiple edits in a turn accumulate (never overwrite). Deleting the
// `append("editTrace", …)` inside contributeEditTraceDebug makes the "editTrace
// rides the record" assertion RED. Gate-off control + CROWN neutrality pin
// default-off + replay-safety.
describe("7. editTrace enricher (contributeEditTraceDebug)", () => {
  const RECORD_KEY = "QUANTA_BENCH_RECORD_TRAJECTORY"
  const DEBUG_KEY = "QUANTA_BENCH_TRAJECTORY_DEBUG"
  const path = `/tmp/tds-edittrace-${process.pid}.jsonl`

  afterEach(async () => {
    await rm(path, { force: true })
  })

  test("ON ⇒ per-edit trace rides metadata.debug.editTrace as a LIST (multiple edits accumulate)", async () => {
    process.env[RECORD_KEY] = path
    process.env[DEBUG_KEY] = "1"

    // producer: the tap hands each edit's raw signals to the shaper.
    contributeEditTraceDebug({
      name: "edit",
      file: "src/a.py",
      ok: true,
      preview: "src/a.py: Replaced 2 occurrence(s)",
      replaceAll: true,
    })
    contributeEditTraceDebug({
      name: "edit",
      file: "src/b.py",
      ok: true,
      preview: "src/b.py: Replaced 1 occurrence(s) via whitespace-flexible match",
      replaceAll: false,
    })

    const port = maybeRecordTrajectory(stubInner([{ type: "text_delta", delta: "hi" }]))
    await runToEnd(port.stream(req("edittrace-q")))

    const records = await jsonlReplayStore({ path }).load()
    expect(records).toHaveLength(1)
    expect((records[0]?.metadata.debug as Record<string, unknown> | undefined)?.editTrace).toEqual([
      {
        tool: "edit",
        file: "src/a.py",
        mode: "exact",
        outcome: "matched",
        occurrences: 2,
        replaceAll: true,
      },
      {
        tool: "edit",
        file: "src/b.py",
        mode: "fuzzy",
        outcome: "matched",
        occurrences: 1,
        fuzzyEscalated: true,
      },
    ])
  })

  test("mode/outcome oracle: fast-apply, stale, failed, exact — derived from preview only", () => {
    process.env[RECORD_KEY] = "debug"
    contributeEditTraceDebug({
      name: "edit",
      file: "f.py",
      ok: true,
      preview: "f.py: applied via fast-apply merge",
      replaceAll: false,
    })
    contributeEditTraceDebug({
      name: "edit",
      file: "g.py",
      ok: false,
      preview: "stale_precondition: g.py sha256 aa != expected bb",
      replaceAll: false,
    })
    contributeEditTraceDebug({
      name: "edit",
      file: "h.py",
      ok: false,
      preview: "h.py: old_string not found in file",
      replaceAll: false,
    })
    expect(debugSink.drain()).toEqual({
      editTrace: [
        { tool: "edit", file: "f.py", mode: "fast-apply", outcome: "matched" },
        { tool: "edit", file: "g.py", mode: "exact", outcome: "stale" },
        { tool: "edit", file: "h.py", mode: "exact", outcome: "failed" },
      ],
    })
  })

  test("SCOPE GUARD: a non-edit write tool (write) is NOT captured in editTrace (never mis-moded)", () => {
    process.env[RECORD_KEY] = "debug"
    // `write` fires onEditResult too (write_filesystem), but its output vocabulary
    // ("Overwrote/Created … (N bytes)") is NOT the edit grammar. It must be dropped
    // rather than silently tagged mode:"exact" with its byte count lost.
    contributeEditTraceDebug({
      name: "write",
      file: "new.py",
      ok: true,
      preview: "new.py: Created new.py (42 bytes)",
      replaceAll: false,
    })
    // scripted_replace / apply_patch likewise dropped — different vocabularies.
    contributeEditTraceDebug({
      name: "scripted_replace",
      file: "s.py",
      ok: true,
      preview: "s.py: applied (replacements=3)",
      replaceAll: false,
    })
    contributeEditTraceDebug({
      name: "apply_patch",
      file: "p.py",
      ok: true,
      preview: "updated: p.py",
      replaceAll: false,
    })
    // No editTrace key at all — none of the three edit-mode slices leaked.
    expect(debugSink.drain()).toBeUndefined()
  })

  test("SCOPE GUARD paired control: an edit interleaved with a write ⇒ ONLY the edit slice", () => {
    process.env[RECORD_KEY] = "debug"
    contributeEditTraceDebug({
      name: "write",
      file: "new.py",
      ok: true,
      preview: "new.py: Created new.py (10 bytes)",
      replaceAll: false,
    })
    contributeEditTraceDebug({
      name: "edit",
      file: "real.py",
      ok: true,
      preview: "real.py: Replaced 1 occurrence(s)",
      replaceAll: false,
    })
    expect(debugSink.drain()).toEqual({
      editTrace: [
        { tool: "edit", file: "real.py", mode: "exact", outcome: "matched", occurrences: 1 },
      ],
    })
  })

  test("control: DEBUG off ⇒ contributeEditTraceDebug is inert, no editTrace key", async () => {
    process.env[RECORD_KEY] = path
    delete process.env[DEBUG_KEY]

    contributeEditTraceDebug({
      name: "edit",
      file: "src/a.py",
      ok: true,
      preview: "src/a.py: Replaced 1 occurrence(s)",
      replaceAll: false,
    })
    const port = maybeRecordTrajectory(stubInner([{ type: "text_delta", delta: "hi" }]))
    await runToEnd(port.stream(req("edittrace-q")))

    const records = await jsonlReplayStore({ path }).load()
    expect(records[0]?.metadata).not.toHaveProperty("debug")
  })

  test("CROWN: editTrace enrichment does NOT perturb the request id hash", async () => {
    const request = req("edittrace-neutral")
    const expectedId = defaultHashRequest(request, "exact")

    process.env[RECORD_KEY] = "debug"
    const withEdit = capturingStore("/tmp/tds-edittrace-crown.jsonl")
    contributeEditTraceDebug({
      name: "edit",
      file: "src/a.py",
      ok: true,
      preview: "src/a.py: Replaced 1 occurrence(s)",
      replaceAll: false,
    })
    await runToEnd(
      recordingLlmPort({
        inner: stubInner([{ type: "text_delta", delta: "x" }]),
        store: withEdit.port,
        debugDrain: () => debugSink.drain(),
      }).stream(request),
    )

    // request hash is keyed off `request` only — the editTrace slice rides metadata.
    expect(withEdit.appended[0]?.id).toBe(expectedId)
    expect(
      (withEdit.appended[0]?.metadata.debug as Record<string, unknown> | undefined)?.editTrace,
    ).toEqual([
      { tool: "edit", file: "src/a.py", mode: "exact", outcome: "matched", occurrences: 1 },
    ])
  })
})
