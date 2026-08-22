/**
 * Wiring hellgate for the jun-29 repro-grounding driver seam (C5). Drives the real
 * `prepareReproTestDetailed` with an injected `generate` SPY that captures the
 * `grounding` arg it receives, proving:
 *   - reproGrounding UNSET ⇒ generate sees NO grounding (byte-identical prompt).
 *   - reproGrounding=true + a port that returns a test ⇒ generate sees the stripped
 *     exemplar skeleton (ENGAGES — not wired-but-inert), and the secret assertion
 *     body does NOT survive (no-leak end-to-end through the driver).
 */
import { describe, expect, test } from "bun:test"
import type { ReproGroundingInput } from "../../src/agent/repro-test/generate"
import type { Instance } from "../../src/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "../../src/llm"
import { prepareReproTestDetailed } from "../../src/runner/batch/eval/driver"
import type { ReproGroundingPorts } from "../../src/runner/batch/eval/repro-grounding"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const instance: Instance = {
  id: "t",
  repoPath: "/tmp/x",
  problemStatement: "sphinx.ext.autodoc renders the wrong default",
  testCmd: "true",
}

const RAW_TEST = `import pytest
from sphinx.testing.util import SphinxTestApp

@pytest.mark.sphinx("html", testroot="ext-autodoc")
def test_existing(app: SphinxTestApp):
    app.build()
    assert app.result == "SECRET-GOLD-VALUE"
`

// Capture the grounding arg every generate call receives.
const runWith = async (opts: {
  reproGrounding?: boolean
  ports?: ReproGroundingPorts
  groundingSourceFiles?: readonly string[]
}): Promise<(ReproGroundingInput | undefined)[]> => {
  const captured: (ReproGroundingInput | undefined)[] = []
  await prepareReproTestDetailed(instance, "/tmp/sb-nonexistent", 1, {
    llm: new StubLLM(),
    generate: async (args: { grounding?: ReproGroundingInput }) => {
      captured.push(args.grounding)
      return ["def test_x():\n    assert True\n"]
    },
    // execute stub: return no samples (we only assert on the generate arg).
    execute: (async () => []) as never,
    ...(opts.reproGrounding !== undefined ? { reproGrounding: opts.reproGrounding } : {}),
    ...(opts.ports !== undefined ? { groundingPorts: opts.ports } : {}),
    ...(opts.groundingSourceFiles !== undefined
      ? { groundingSourceFiles: opts.groundingSourceFiles }
      : {}),
  })
  return captured
}

describe("repro-grounding driver wiring (C5)", () => {
  test("reproGrounding UNSET ⇒ generate receives NO grounding (byte-identical)", async () => {
    const captured = await runWith({})
    expect(captured.length).toBeGreaterThan(0)
    for (const g of captured) expect(g).toBeUndefined()
  })

  test("reproGrounding=true with a relatedTests port ⇒ generate receives the stripped skeleton (ENGAGES)", async () => {
    const ports: ReproGroundingPorts = {
      relatedTests: async () => [{ path: "tests/test_autodoc.py", text: RAW_TEST }],
    }
    const captured = await runWith({
      reproGrounding: true,
      ports,
      groundingSourceFiles: ["sphinx/ext/autodoc/__init__.py"], // skip disk inference
    })
    expect(captured.length).toBeGreaterThan(0)
    const g = captured[0]
    expect(g?.exemplarSkeletons?.length).toBe(1)
    const skeleton = g?.exemplarSkeletons?.[0] ?? ""
    expect(skeleton).toContain("from sphinx.testing.util import SphinxTestApp")
    expect(skeleton).toContain("@pytest.mark.sphinx") // marker shape kept (literals redacted)
    // NO-LEAK end-to-end through the driver seam.
    expect(skeleton).not.toContain("SECRET-GOLD-VALUE")
    expect(skeleton).not.toMatch(/\bassert\b/)
  })

  test("reproGrounding=true but port returns nothing ⇒ no grounding (inert, byte-identical)", async () => {
    const ports: ReproGroundingPorts = { relatedTests: async () => [] }
    const captured = await runWith({
      reproGrounding: true,
      ports,
      groundingSourceFiles: ["sphinx/ext/autodoc/__init__.py"],
    })
    for (const g of captured) expect(g).toBeUndefined()
  })

  // C6 measurement-hole fix: telemetry must distinguish engaged / ran-but-whiffed /
  // off, so the A/B can't mistake "grounding never fired" for "grounding didn't help".
  const telemetryWith = async (opts: {
    reproGrounding?: boolean
    ports?: ReproGroundingPorts
  }): Promise<{ grounding?: { engaged: boolean; exemplars: number } }> => {
    const r = await prepareReproTestDetailed(instance, "/tmp/sb-nonexistent", 1, {
      llm: new StubLLM(),
      generate: async () => ["def test_x():\n    assert True\n"],
      execute: (async () => []) as never,
      ...(opts.reproGrounding !== undefined ? { reproGrounding: opts.reproGrounding } : {}),
      ...(opts.ports !== undefined ? { groundingPorts: opts.ports } : {}),
      ...(opts.reproGrounding ? { groundingSourceFiles: ["sphinx/ext/autodoc/__init__.py"] } : {}),
    })
    return r.telemetry as { grounding?: { engaged: boolean; exemplars: number } }
  }

  test("telemetry: OFF ⇒ no grounding field (byte-identical)", async () => {
    const t = await telemetryWith({})
    expect(t.grounding).toBeUndefined()
  })

  test("telemetry: ON + engaged ⇒ engaged=true, exemplars counted", async () => {
    const ports: ReproGroundingPorts = {
      relatedTests: async () => [{ path: "t.py", text: RAW_TEST }],
    }
    const t = await telemetryWith({ reproGrounding: true, ports })
    expect(t.grounding?.engaged).toBe(true)
    expect(t.grounding?.exemplars).toBe(1)
  })

  test("telemetry: ON but whiffed ⇒ engaged=false (distinguishable from off)", async () => {
    const ports: ReproGroundingPorts = { relatedTests: async () => [] }
    const t = await telemetryWith({ reproGrounding: true, ports })
    expect(t.grounding).toBeDefined()
    expect(t.grounding?.engaged).toBe(false)
    expect(t.grounding?.exemplars).toBe(0)
  })
})
