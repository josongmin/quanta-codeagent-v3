import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"
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
const swebenchInstance = (): Instance => ({
  id: "budget-wire-1",
  repoPath: "/tmp/x",
  problemStatement: "inspect only",
  testCmd: "true",
  swebench: { instanceId: "x__budget-1", repo: "x/x", baseCommit: "deadbeef" },
})

describe("bench budget-meter wiring", () => {
  test("ADVERSARIAL: buildConfig threads a fresh budget meter from budgetMeterFactory", () => {
    const seen: BudgetMeter[] = []
    const deps = {
      llm: new StubLLM(),
      maxTurns: 1,
      timeoutMs: 5_000,
      budgetMeterFactory: () => {
        const meter = new BudgetMeter({ dials: { maxTurns: 0 } })
        seen.push(meter)
        return meter
      },
    }
    const a = buildConfig(
      swebenchInstance(),
      deps,
      "/tmp/sb-a",
      new AbortController().signal,
      stubStream,
    )
    const b = buildConfig(
      swebenchInstance(),
      deps,
      "/tmp/sb-b",
      new AbortController().signal,
      stubStream,
    )

    expect(seen).toHaveLength(2)
    expect(a.budgetMeter).toBe(seen[0])
    expect(b.budgetMeter).toBe(seen[1])
    expect(a.budgetMeter).not.toBe(b.budgetMeter)
  })
})
