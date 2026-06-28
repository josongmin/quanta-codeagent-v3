/**
 * A1b — Wiring proof: `prepareReproTestDetailed` persists EVERY repro candidate
 * through the injected `reproArtifactSink` (engages when set), and is a NO-OP +
 * best-effort when the sink is absent or throws (default-OFF byte-identical, and
 * a sink failure can never disturb the repro pipeline).
 *
 * This is the determinism guard the A1 sink needs: the unit `repro-artifacts-sink`
 * test proves the sink's write-set; THIS test proves the driver actually calls it
 * once per candidate with the right instanceId/kind/index — i.e. it is not
 * wired-but-inert.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "../../src/llm"
import { prepareReproTestDetailed } from "../../src/runner/batch/eval/driver"
import type {
  ReproArtifactSink,
  ReproCandidateArtifact,
} from "../../src/runner/batch/eval/repro-artifacts-sink"
import type { Instance } from "../../src/runner/batch/types"

const STUB_SOURCE = "import x\n\ndef test_repro():\n    assert False\n"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: STUB_SOURCE }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const mkInstance = (overrides: Partial<Instance> = {}): Instance => ({
  id: "django__django-99999",
  repoPath: "/tmp/x",
  problemStatement: "the bug is in foo.py",
  testCmd: "true",
  ...overrides,
})

const reproducedSamples = (tests: readonly string[]) =>
  tests.map((source) => ({
    source,
    stdout: "1 failed in 0.1s",
    stderr: "trace",
    outcome: "reproduced" as const,
  }))

const recordingSink = (): { sink: ReproArtifactSink; calls: ReproCandidateArtifact[] } => {
  const calls: ReproCandidateArtifact[] = []
  return { calls, sink: { persist: async (a) => void calls.push(a) } }
}

const ENV_KEYS = ["QUANTA_BENCH_REPRO_TEST"] as const
let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("A1b repro-artifact persistence wiring", () => {
  test("ENGAGES: one persist per candidate, correct instanceId/kind/index", async () => {
    const { sink, calls } = recordingSink()
    const detail = await prepareReproTestDetailed(mkInstance({ id: "inst-x" }), "/tmp/sb", 3, {
      llm: new StubLLM(),
      execute: async ({ tests }) => reproducedSamples(tests),
      reproArtifactSink: sink,
    })
    // 3 canonical candidates generated (K=3) ⇒ 3 persisted.
    expect(calls.length).toBe(3)
    expect(calls.every((c) => c.instanceId === "inst-x")).toBe(true)
    expect(calls.every((c) => c.kind === "canonical")).toBe(true)
    expect(calls.map((c) => c.index).sort((a, b) => a - b)).toEqual([0, 1, 2])
    expect(calls.every((c) => c.outcome === "reproduced")).toBe(true)
    // the persisted source is the GENERATED candidate (post fence-strip / scaffold
    // wrap), not the raw LLM delta — assert it is non-empty rather than equal.
    expect(calls.every((c) => c.source.length > 0)).toBe(true)
    // sanity: the pipeline still produced a selection (persistence is additive).
    expect(detail.selection).not.toBeNull()
  })

  test("NO-OP: absent sink ⇒ pipeline unchanged (no throw, selection produced)", async () => {
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 2, {
      llm: new StubLLM(),
      execute: async ({ tests }) => reproducedSamples(tests),
      // no reproArtifactSink
    })
    expect(detail.selection).not.toBeNull()
  })

  test("BEST-EFFORT: a throwing sink never disturbs the repro pipeline", async () => {
    const throwing: ReproArtifactSink = {
      persist: async () => {
        throw new Error("disk full")
      },
    }
    const detail = await prepareReproTestDetailed(mkInstance(), "/tmp/sb", 2, {
      llm: new StubLLM(),
      execute: async ({ tests }) => reproducedSamples(tests),
      reproArtifactSink: throwing,
    })
    // selection is identical to the no-sink path — the throw was swallowed.
    expect(detail.selection).not.toBeNull()
    expect((detail.selection?.samples.length ?? 0) > 0).toBe(true)
  })
})
