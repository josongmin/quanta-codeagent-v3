/**
 * Compare CLI adapters — availability probe + failure path.
 *
 *   1. `available()` reports {ok:false} for a non-existent binary instead of
 *      throwing — runner must be able to call adapters that aren't installed.
 *   2. Quanta adapter is always available (in-process; no probe needed).
 *
 * The actual `runOne` path is exercised by the integration smoke tests
 * (requires API keys + at least one installed competitor CLI).
 */
import { describe, expect, test } from "bun:test"
import { buildAiderAdapter } from "@/../src/apps/eval/compare/adapters/aider"
import { buildClaudeCodeAdapter } from "@/../src/apps/eval/compare/adapters/claude-code"
import { CliAgentAdapter } from "@/../src/apps/eval/compare/adapters/cli-base"
import { buildCursorAdapter } from "@/../src/apps/eval/compare/adapters/cursor"
import { QuantaAdapter } from "@/../src/apps/eval/compare/adapters/quanta"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const stubLLM: LLMPort = {
  model: "test",
  // biome-ignore lint/correctness/useYield: never iterated in this test
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
}

describe("compare adapters", () => {
  test("non-existent binary ⇒ available()={ok:false} (does not throw)", async () => {
    const adapter = new CliAgentAdapter({
      name: "definitely-not-installed",
      bin: "definitely-not-installed-xyz123",
      versionArgs: ["--version"],
      buildArgv: () => ({ argv: [] }),
    })
    const r = await adapter.available()
    expect(r.ok).toBe(false)
    expect(r.reason).toBeDefined()
  })

  test("Quanta adapter always available", async () => {
    const a = new QuantaAdapter({ llm: stubLLM })
    const r = await a.available()
    expect(r.ok).toBe(true)
  })

  test("named builders produce adapters with the documented name", () => {
    expect(buildClaudeCodeAdapter().name).toBe("claude-code")
    expect(buildCursorAdapter().name).toBe("cursor")
    expect(buildAiderAdapter().name).toBe("aider")
  })
})
