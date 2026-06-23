import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const stubStream: StreamPort = { emit() {} }

const mkInstance = (problemStatement = "Fix the bug in src/foo.py."): Instance => ({
  id: "x__1",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
  swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
})

const userText = (
  closureHint: string | undefined,
  reproHint: string | undefined = undefined,
): string => {
  const ac = new AbortController()
  const cfg = buildConfig(
    mkInstance(),
    { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
    "/tmp/sb",
    ac.signal,
    stubStream,
    undefined,
    undefined,
    reproHint,
    closureHint,
  )
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

const withEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
  const prev = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("closure prompt wiring", () => {
  test("closureHint non-empty ⇒ injected before the base task", () => {
    const text = userText("First edit candidate: src/foo.py")
    expect(text).toContain("First edit candidate: src/foo.py")
    expect(text.indexOf("First edit candidate: src/foo.py")).toBeLessThan(
      text.indexOf(mkInstance().problemStatement),
    )
  })

  test("closureHint empty/undefined ⇒ byte-identical to legacy path", () => {
    expect(userText(undefined)).toBe(userText(""))
  })

  test("closureHint + reproHint ⇒ closure hint stays above repro, both above base", () => {
    const text = userText("First edit candidate: src/foo.py", "REPRO_DIRECTIVE")
    const iClosure = text.indexOf("First edit candidate: src/foo.py")
    const iRepro = text.indexOf("REPRO_DIRECTIVE")
    const iBase = text.indexOf("Work inside /tmp/sb")
    expect(iClosure).toBeGreaterThanOrEqual(0)
    expect(iRepro).toBeGreaterThan(iClosure)
    expect(iBase).toBeGreaterThan(iRepro)
  })

  test("chaMultisiteSteer is injected into both the prompt prelude and localize-phase config", () => {
    withEnv({ QUANTA_BENCH_LOCALIZE_PHASE: "3" }, () => {
      const steer = [
        "MULTI-SITE FIX: `m` is overridden by sibling classes that share a base.",
        "  - pkg/oracle.py:9  (Oracle.m)",
      ].join("\n")
      const ac = new AbortController()
      const cfg = buildConfig(
        mkInstance(),
        { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
        "/tmp/sb",
        ac.signal,
        stubStream,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        steer,
      )
      const block = cfg.messages[0]?.content[0]
      const text = block && block.type === "text" ? block.text : ""
      expect(text).toContain(steer)
      expect(text.indexOf(steer)).toBeLessThan(text.indexOf("Work inside /tmp/sb"))
      expect(cfg.localizePhase).toEqual({ phase1Turns: 3, chaMultisiteSteer: steer })
    })
  })
})

// WS1 mini-parity: `round0-minimal` thins the round-0 prompt by deferring the
// bulky repro-directive prose to repair rounds (seedMsg present), keeping the
// one-line first-edit closureHint. Env-driven (QUANTA_BENCH_ROUND0_MINIMAL) so
// the test exercises the full benchOptIns→posture→buildConfig wiring.
const withRound0Minimal = (val: string | undefined, fn: () => void): void => {
  const key = "QUANTA_BENCH_ROUND0_MINIMAL"
  const prev = process.env[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

const userTextSeeded = (args: {
  closureHint?: string
  reproHint?: string
  seedMsg?: string
}): string => {
  const ac = new AbortController()
  const cfg = buildConfig(
    mkInstance(),
    { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
    "/tmp/sb",
    ac.signal,
    stubStream,
    args.seedMsg,
    undefined,
    args.reproHint,
    args.closureHint,
  )
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

describe("WS1 mini-parity round0-minimal", () => {
  test("ON + round 0 (no seedMsg) ⇒ repro prose suppressed, closureHint kept", () => {
    withRound0Minimal("1", () => {
      const text = userTextSeeded({
        closureHint: "First edit candidate: src/foo.py",
        reproHint: "REPRO_DIRECTIVE_PROSE",
      })
      expect(text).not.toContain("REPRO_DIRECTIVE_PROSE")
      expect(text).toContain("First edit candidate: src/foo.py")
    })
  })

  test("ON + repair round (seedMsg present) ⇒ repro prose re-attaches", () => {
    withRound0Minimal("1", () => {
      const text = userTextSeeded({
        reproHint: "REPRO_DIRECTIVE_PROSE",
        seedMsg: "Round 1 repair seed.",
      })
      expect(text).toContain("REPRO_DIRECTIVE_PROSE")
    })
  })

  test("OFF (default) + round 0 ⇒ repro prose present (byte-identical control)", () => {
    withRound0Minimal(undefined, () => {
      const text = userTextSeeded({ reproHint: "REPRO_DIRECTIVE_PROSE" })
      expect(text).toContain("REPRO_DIRECTIVE_PROSE")
    })
  })

  test("ON ⇒ suppression is round-0-only: same reproHint absent@0 yet present@repair", () => {
    withRound0Minimal("1", () => {
      const round0 = userTextSeeded({ reproHint: "REPRO_DIRECTIVE_PROSE" })
      const repair = userTextSeeded({ reproHint: "REPRO_DIRECTIVE_PROSE", seedMsg: "seed" })
      expect(round0).not.toContain("REPRO_DIRECTIVE_PROSE")
      expect(repair).toContain("REPRO_DIRECTIVE_PROSE")
    })
  })
})
