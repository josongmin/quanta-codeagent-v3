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
})
