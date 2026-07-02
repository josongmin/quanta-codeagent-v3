/**
 * A2 (jul-3 strategy-audit) WIRING proof — the batch eval driver threads
 * `promptPack:"batch"` into the agent's SYSTEM prompt, so a graded bench run
 * carries the `R-NO-EXPLORE-OVER-EDIT` rule (stop exploring once you have a
 * coherent edit + verify step).
 *
 * This is a WIRING test, not a re-assertion of `buildSystemPrompt`: it drives
 * the real `buildConfig` (the exact seam the driver uses) and reads back the
 * assembled `config.system`. RED before the fix: `buildConfig` called
 * `buildSystemPrompt(sandbox)` (no pack) ⇒ the rule was ABSENT.
 *
 * Guard: the interactive default MUST NOT carry the batch-only rule (proves
 * the pack selection is load-bearing, not a rule that leaked into core).
 */

import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent"
import type { LLMPort } from "@/llm"
import type { StreamPort } from "@/stream"
import type { Instance } from "../../types"
import type { RunInstanceDeps } from "./context-types"
import { buildConfig } from "./config-build"

const BATCH_RULE_MARKER = "[R-NO-EXPLORE-OVER-EDIT]"

const stubLlm: LLMPort = {
  model: "stub",
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error("stub llm should not be streamed in a wiring test")
  },
}

const nullStream: StreamPort = { emit() {} }

const makeInstance = (sandbox: string): Instance => ({
  id: "wiring__a2-prompt-pack",
  repoPath: sandbox,
  problemStatement: "wiring probe: assert the batch pack threads into config.system",
  testCmd: "true",
})

const makeDeps = (): RunInstanceDeps => ({
  llm: stubLlm,
  maxTurns: 1,
  timeoutMs: 1,
})

describe("A2 — batch eval driver threads promptPack:'batch' into config.system", () => {
  test("buildConfig().system carries the batch-only R-NO-EXPLORE-OVER-EDIT rule (WIRING)", () => {
    const sandbox = process.cwd()
    const config = buildConfig(
      makeInstance(sandbox),
      makeDeps(),
      sandbox,
      new AbortController().signal,
      nullStream,
    )
    expect(typeof config.system).toBe("string")
    expect(config.system).toContain(BATCH_RULE_MARKER)
  })

  test("GUARD: the interactive default prompt does NOT carry the batch-only rule (pack selection is load-bearing)", () => {
    // If the rule leaked into CORE_RULES the WIRING test above would pass
    // vacuously; pin that the default (no pack) path is CLEAN.
    expect(buildSystemPrompt(process.cwd())).not.toContain(BATCH_RULE_MARKER)
    // And the exact pack the driver selects DOES carry it (the seam value).
    expect(buildSystemPrompt(process.cwd(), { promptPack: "batch" })).toContain(BATCH_RULE_MARKER)
  })
})
