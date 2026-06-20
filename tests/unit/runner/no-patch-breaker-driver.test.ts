import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { buildConfig } from "@/runner/batch/eval/driver"
import { noPatchExhaustedErrorOf } from "@/runner/batch/eval/no-patch-breaker-adapter"
import type { Instance } from "@/runner/batch/types"

class NoopLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const instance: Instance = {
  id: "no-patch-breaker",
  repoPath: "/tmp/no-patch-breaker",
  problemStatement: "Fix the bug.",
  testCmd: "true",
}

const baseDeps = {
  llm: new NoopLLM(),
  maxTurns: 60,
  timeoutMs: 1_000,
}

const clearBenchEnv = (): void => {
  delete process.env.QUANTA_BENCH_NO_PATCH_BREAKER
  delete process.env.QUANTA_BENCH_PRESET
  delete process.env.QUANTA_BENCH_SOTA
  delete process.env.QUANTA_KNOBS_PRESET
  delete process.env.QUANTA_HOOKS
}

describe("no-patch breaker driver wiring", () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    clearBenchEnv()
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  test("buildConfig stays hook-free when the knob is off", () => {
    const cfg = buildConfig(
      instance,
      baseDeps,
      "/tmp/no-patch-breaker",
      new AbortController().signal,
      { emit: () => undefined },
    )
    expect(cfg.hooks).toBeUndefined()
  })

  test("buildConfig injects a commit-now prompt at the no-edit threshold", async () => {
    process.env.QUANTA_BENCH_NO_PATCH_BREAKER = "1"
    const cfg = buildConfig(
      instance,
      baseDeps,
      "/tmp/no-patch-breaker",
      new AbortController().signal,
      { emit: () => undefined },
    )
    expect(cfg.hooks).toBeDefined()
    const before = await cfg.hooks?.emit({ type: "turn_start", turn: 47 })
    const atThreshold = await cfg.hooks?.emit({ type: "turn_start", turn: 48 })
    expect(before?.promptHook).toBeUndefined()
    expect(atThreshold?.promptHook?.injectBeforeUser).toContain(
      "No mutating edit has been made after 48/60 turns.",
    )
  })

  test("a denied write attempt does not disarm the breaker, but an executed edit does", async () => {
    process.env.QUANTA_BENCH_NO_PATCH_BREAKER = "1"
    const cfg = buildConfig(
      instance,
      baseDeps,
      "/tmp/no-patch-breaker",
      new AbortController().signal,
      { emit: () => undefined },
    )
    await cfg.hooks?.emit({
      type: "pre_tool_use",
      name: "write",
      input: { path: "fix.py", content: "patched" },
    })
    const afterDeniedAttempt = await cfg.hooks?.emit({ type: "turn_start", turn: 48 })
    expect(afterDeniedAttempt?.promptHook?.injectBeforeUser).toContain(
      "No mutating edit has been made after 48/60 turns.",
    )

    await cfg.hooks?.emit({
      type: "post_tool_use",
      name: "write",
      input: { path: "fix.py", content: "patched" },
      ok: true,
      output: "ok",
    })
    const afterExecutedEdit = await cfg.hooks?.emit({ type: "turn_start", turn: 49 })
    expect(afterExecutedEdit?.promptHook).toBeUndefined()
  })

  test("exhausted verdict appears only for zero-edit exhausted runs", () => {
    expect(
      noPatchExhaustedErrorOf({
        enabled: true,
        stopReason: "max_turns",
        patch: "",
        editCount: 0,
      }),
    ).toBe("no patch produced before max turns exhausted (no_patch_exhausted)")
    expect(
      noPatchExhaustedErrorOf({
        enabled: false,
        stopReason: "max_turns",
        patch: "",
        editCount: 0,
      }),
    ).toBeUndefined()
    expect(
      noPatchExhaustedErrorOf({
        enabled: true,
        stopReason: "max_turns",
        patch: "",
        editCount: 1,
      }),
    ).toBeUndefined()
    expect(
      noPatchExhaustedErrorOf({
        enabled: true,
        stopReason: "max_turns",
        patch: "diff --git a/a b/a\n",
        editCount: 0,
      }),
    ).toBeUndefined()
    expect(
      noPatchExhaustedErrorOf({
        enabled: true,
        stopReason: "budget_exhausted",
        patch: "",
        editCount: 0,
      }),
    ).toBe("no patch produced before token budget exhausted (no_patch_exhausted)")
  })
})
