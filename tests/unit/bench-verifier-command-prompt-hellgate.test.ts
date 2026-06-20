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
const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }

const userText = (instance: Instance): string => {
  const ac = new AbortController()
  const cfg = buildConfig(instance, baseDeps, "/tmp/sb", ac.signal, stubStream)
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

describe("bench verifier-command prompt wiring", () => {
  test("swebench prompt surfaces the exact repo-local verifier command above the workspace line", () => {
    const testCmd =
      "uvx --quiet --python 3.8 --with pytest --with-editable . pytest -x --no-header tests/foo.py"
    const text = userText({
      id: "x__1",
      repoPath: "/tmp/x",
      problemStatement: "fix it",
      testCmd,
      swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
    })
    expect(text).toContain(`Repository-local verifier for this task: ${testCmd}`)
    expect(text).toContain(
      "prefer this command (or a narrower variant of it) over bare host-global pytest/python",
    )
    expect(text.indexOf(testCmd)).toBeGreaterThan(text.indexOf("Work inside /tmp/sb."))
    expect(text.indexOf(testCmd)).toBeLessThan(text.indexOf("When done, stop."))
  })

  test("custom corpus prompt stays free of the swebench verifier hint", () => {
    const text = userText({
      id: "custom-1",
      repoPath: "/tmp/x",
      problemStatement: "fix it",
      testCmd: "pytest tests/foo.py",
    })
    expect(text).not.toContain("Repository-local verifier for this task:")
    expect(text).not.toContain("host-global pytest/python")
  })
})
