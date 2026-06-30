import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
const EXPOSE_ENV = "QUANTA_BENCH_EXPOSE_DATASET_VERIFIER"
const savedExpose = process.env[EXPOSE_ENV]

beforeEach(() => {
  delete process.env[EXPOSE_ENV]
})

afterEach(() => {
  if (savedExpose === undefined) delete process.env[EXPOSE_ENV]
  else process.env[EXPOSE_ENV] = savedExpose
})

const userText = (instance: Instance): string => {
  const ac = new AbortController()
  const cfg = buildConfig(instance, baseDeps, "/tmp/sb", ac.signal, stubStream)
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

describe("bench verifier-command prompt wiring", () => {
  test("synthesized swebench dataset verifier stays hidden from the agent by default", () => {
    const testCmd =
      "uv run --no-project --python 3.8 --with pytest --with setuptools --with-editable . pytest -x --no-header tests/foo.py"
    const text = userText({
      id: "x__1",
      repoPath: "/tmp/x",
      problemStatement: "fix it",
      testCmd,
      swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
    })
    expect(text).not.toContain("Repository-local verifier for this task:")
    expect(text).not.toContain(testCmd)
    expect(text).toContain("Work inside /tmp/sb.")
    expect(text).toContain("When done, stop.")
  })

  test("opt-in surfaces the exact repo-local verifier command above the workspace line", () => {
    process.env[EXPOSE_ENV] = "1"
    const testCmd =
      "uv run --no-project --python 3.8 --with pytest --with setuptools --with-editable . pytest -x --no-header tests/foo.py"
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

  test("selected-test-files-derived Pro verifier stays hidden from the agent by default", () => {
    const testCmd = "go test -count=1 ./... -run '^(?:TestEvents)$'"
    const text = userText({
      id: "go__1",
      repoPath: "/tmp/x",
      problemStatement: "fix it",
      testCmd,
      swebench: {
        instanceId: "go__1",
        repo: "navidrome/navidrome",
        baseCommit: "deadbeef",
        repoLanguage: "go",
        selectedTestFilesToRun: ["TestEvents"],
      },
    })
    expect(text).not.toContain("Repository-local verifier for this task:")
    expect(text).not.toContain(testCmd)
  })

  test("selected-test-files-derived Pro verifier is surfaced only on explicit opt-in", () => {
    process.env[EXPOSE_ENV] = "1"
    const testCmd = "go test -count=1 ./... -run '^(?:TestEvents)$'"
    const text = userText({
      id: "go__1",
      repoPath: "/tmp/x",
      problemStatement: "fix it",
      testCmd,
      swebench: {
        instanceId: "go__1",
        repo: "navidrome/navidrome",
        baseCommit: "deadbeef",
        repoLanguage: "go",
        selectedTestFilesToRun: ["TestEvents"],
      },
    })
    expect(text).toContain(`Repository-local verifier for this task: ${testCmd}`)
  })
})
