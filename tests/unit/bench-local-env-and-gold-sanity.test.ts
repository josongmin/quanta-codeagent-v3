import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstance } from "@/apps/bench/eval"
import { buildConfig } from "@/apps/bench/eval/driver"
import { runEnvPrep } from "@/apps/bench/eval/env-prep"
import { verify } from "@/apps/bench/eval/verdict"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { validateGoldPatch } from "@/runner/batch/eval/gold-sanity"
import type { Instance } from "@/runner/batch/types"

class NoopLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const localEnv = { vars: {}, pathPrepend: ["bin"] }

const writeExecutable = async (path: string, body: string): Promise<void> => {
  await writeFile(path, `#!/bin/sh\n${body}`, "utf8")
  chmodSync(path, 0o755)
}

describe("bench localEnv + gold sanity", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-local-env-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("setupCmd and local testCmd execute through Instance.localEnv", async () => {
    await mkdir(join(dir, "bin"), { recursive: true })
    await writeExecutable(join(dir, "bin", "prep-marker"), "echo prepared > .prepared\n")
    await writeExecutable(join(dir, "bin", "check-marker"), "test -f .prepared\n")
    const instance: Instance = {
      id: "local-env",
      repoPath: dir,
      problemStatement: "noop",
      setupCmd: "prep-marker",
      testCmd: "check-marker",
      localEnv,
    }

    expect(await runEnvPrep(instance, dir, 30000)).toEqual({ ok: true })
    const out = await verify(instance, "diff --git a/a b/a\n", dir, { timeoutMs: 30000 })
    expect(out.passed).toBe(true)
  })

  test("buildConfig threads Instance.localEnv into AgentConfig", () => {
    const instance: Instance = {
      id: "cfg-env",
      repoPath: dir,
      problemStatement: "noop",
      testCmd: "true",
      localEnv,
    }
    const cfg = buildConfig(
      instance,
      { llm: new NoopLLM(), maxTurns: 1, timeoutMs: 1000 },
      dir,
      new AbortController().signal,
      { emit: () => undefined },
    )
    expect(cfg.localEnv).toEqual(localEnv)
  })

  test("validateGoldPatch rejects a reference patch that does not satisfy the verifier", async () => {
    await writeFile(join(dir, "answer.txt"), "bad\n", "utf8")
    const badGold = [
      "diff --git a/answer.txt b/answer.txt",
      "--- a/answer.txt",
      "+++ b/answer.txt",
      "@@ -1 +1 @@",
      "-bad",
      "+still-bad",
      "",
    ].join("\n")
    const instance: Instance = {
      id: "bad-gold",
      repoPath: dir,
      problemStatement: "noop",
      testCmd: 'test "$(cat answer.txt)" = good',
      goldPatch: badGold,
    }

    const out = await validateGoldPatch(instance, { timeoutMs: 30000 })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain("gold patch did not resolve")
  })

  test("runInstance marks failed reference validation as grader_invalid", async () => {
    await writeFile(join(dir, "answer.txt"), "bad\n", "utf8")
    const badGold = [
      "diff --git a/answer.txt b/answer.txt",
      "--- a/answer.txt",
      "+++ b/answer.txt",
      "@@ -1 +1 @@",
      "-bad",
      "+still-bad",
      "",
    ].join("\n")
    const instance: Instance = {
      id: "bad-gold-run",
      repoPath: dir,
      problemStatement: "noop",
      testCmd: 'test "$(cat answer.txt)" = good',
      goldPatch: badGold,
    }

    const out = await runInstance(instance, {
      llm: new NoopLLM(),
      maxTurns: 1,
      timeoutMs: 30000,
      goldSanity: { mode: "on-fail" },
    })
    expect(out.passed).toBe(false)
    expect(out.verdict).toBe("grader_invalid")
    expect(out.error).toContain("gold patch did not resolve")
  })
})
