/**
 * WS4 SCENARIO hellgate (jul-12 OmO absorption) — the true end-to-end guarantee:
 * a repo's AGENTS.md / CLAUDE.md content reaches the ACTUAL system prompt that
 * the LLM receives on the wire when a human drives an interactive turn.
 *
 * The unit hellgate (`interactive-repo-rules-wire-hellgate`) proves the two links
 * in isolation — the preset populates `cfg.repoRules`, and `buildTurnContext`
 * renders it. THIS suite closes the whole chain with NO stubbed render: it runs
 * the REAL interactive assembly (`runMode` → buildInteractiveBase → assemble)
 * and then the REAL agent loop (`runAgent`) with a capturing LLM, asserting the
 * rule text lands in the `StreamInput.system` the model is actually called with.
 *
 *   §1  AGENTS.md → live LLM system prompt (red-on-injection: unwired ⇒ absent).
 *   §2  CLAUDE.md is honored the same way (REPO_RULE_CANDIDATES coverage on the
 *       live path).
 *   §3  CONTROL — a rule-less repo leaves the system prompt free of any injected
 *       block (no spurious content; the absent-case stays clean end-to-end).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import type { AssembleRequest } from "../../src/apps/agent/assemble"
import { runMode as runInteractiveMode } from "../../src/apps/agent/mode-presets/interactive"

const SENTINEL = "OMO-WS4-E2E-RULE-9d7f-DO-NOT-DELETE-THIS-LINE"

/** Captures the system prompt of the FIRST stream() call (the turn's LLM call)
 *  then completes the turn so `runAgent` returns cleanly. */
class CapturingLLM implements LLMPort {
  capturedSystem: unknown = "__uncalled__"
  readonly model = "capture"
  // biome-ignore lint/suspicious/useAwait: async generator contract
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (this.capturedSystem === "__uncalled__") this.capturedSystem = input.system ?? null
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const baseFor = (cwd: string, llm: LLMPort): AssembleRequest["base"] => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream: { emit: () => undefined },
  permission: { mode: "acceptEdits" },
  messages: [userText("go")],
  system: "test",
  cwd,
  maxTurns: 2,
  signal: new AbortController().signal,
  sessionId: "sess-ws4-e2e",
})

/** Drive the REAL interactive assembly, then the REAL agent loop, and return the
 *  system prompt the LLM was actually called with (stringified for a robust
 *  substring check — `SystemPromptInput` may be a string or a SystemBlock[]). */
const systemPromptForRepo = async (cwd: string): Promise<string> => {
  const llm = new CapturingLLM()
  await runInteractiveMode({
    mode: "interactive",
    base: baseFor(cwd, llm),
    // The seam runs the REAL loop (not a stub) over the assembled cfg, so the
    // full prompt pipeline (context-assembler → prompt.ts → StreamInput.system)
    // executes exactly as in a live interactive turn.
    seams: { runAgent: async (cfg: AgentConfig) => runAgent(cfg) },
  })
  return JSON.stringify(llm.capturedSystem ?? "")
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omo-ws4-e2e-"))
  // `.git` stops loadRepoRules' walk-up here — deterministic regardless of any
  // AGENTS.md in tmpdir's ancestors.
  writeFileSync(join(dir, ".git"), "")
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("WS4 e2e — repo rules reach the live LLM system prompt", () => {
  test("§1 AGENTS.md content is in the StreamInput.system the model is called with (red-on-injection)", async () => {
    writeFileSync(join(dir, "AGENTS.md"), `# Project rules\n\n${SENTINEL}\n`)
    const system = await systemPromptForRepo(dir)
    expect(system).not.toBe(JSON.stringify("__uncalled__"))
    expect(system).toContain(SENTINEL)
  })

  test("§2 CLAUDE.md is honored on the live interactive path too", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), `# Claude rules\n\n${SENTINEL}\n`)
    const system = await systemPromptForRepo(dir)
    expect(system).toContain(SENTINEL)
  })

  test("§3 control — a rule-less repo yields a system prompt free of the sentinel", async () => {
    const system = await systemPromptForRepo(dir)
    // The LLM WAS called (a real turn ran) …
    expect(system).not.toBe(JSON.stringify("__uncalled__"))
    // … and no repo-rule block leaked in.
    expect(system).not.toContain(SENTINEL)
  })
})
