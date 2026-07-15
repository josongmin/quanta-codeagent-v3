import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the `check_secrets` LLM-callable tool
 * (`check-secrets-llm-tool` feature). Prior coverage
 * (`tests/unit/check-secrets-tool-hellgate.test.ts`) exercises the tool factory
 * / env-gate / scanner in ISOLATION — `runAgent × scripted-LLM == 0`. NOTHING
 * drove a real loop where the scripted model INVOKES `check_secrets` mid-loop
 * and the loop dispatches it through the real registry, feeding the verdict
 * back to the next turn.
 *
 * THE WIRED CONTRACT: `buildCheckSecretsBlock(config.secretCheckToolEnabled)`
 * (run inside `buildSessionFeatures` at `runAgent` bootstrap) appends
 * `check_secrets` to `extraTools`; `buildEffectiveConfig` folds it into the
 * effective `ToolRegistry` the loop's dispatch consults. So setting
 * `config.secretCheckToolEnabled = true` is the composition-root gate that
 * makes the tool DISPATCHABLE through the loop — exactly what the env resolver
 * `checkSecretsToolEnabled(QUANTA_SECRET_CHECK_TOOL=on)` threads in production.
 *
 * GROUND TRUTH — the tool ran through real dispatch and returned a REAL verdict
 * (from the async `compositeSecretScanner`, NOT a scripted string) to the next
 * turn's `StreamInput.messages`:
 *   - dirty input (an AWS access key) ⇒ the tool_result the model sees on the
 *     follow-up turn reports `finding(s)` (a real scan hit);
 *   - PAIRED CONTROL: clean input ⇒ the tool_result reports `0 findings (clean)`.
 * The two verdicts differ ONLY because the real scanner classified the two
 * inputs differently — proving the tool dispatched and scanned for real.
 */

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A representative secret the composite scanner recognizes (AWS access key id,
 *  the same shape the sibling dispatch-redaction hellgate uses). */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
const CLEAN_TEXT = "the quick brown fox jumps over the lazy dog"

/** Scripted LLM: turn 1 calls check_secrets over some `text`, then finishes.
 *  Records every tool_result content it SEES on the follow-up turn so we assert
 *  the verdict crossed the turn boundary and reached the model. */
class CheckSecretsLLM implements LLMPort {
  readonly model = "check-secrets-test-model"
  calls = 0
  readonly toolResultsSeen: string[] = []
  readonly toolNamesSeen: string[] = []
  constructor(private readonly scanText: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    for (const m of input.messages)
      for (const b of m.content) if (b.type === "tool_result") this.toolResultsSeen.push(b.content)
    // Record the tool menu the model is offered (so we can assert the tool was
    // actually registered when enabled / absent when not).
    for (const t of input.tools) this.toolNamesSeen.push(t.name)
    this.calls += 1
    if (this.calls === 1) {
      for (const e of toolUse("cs1", "check_secrets", { text: this.scanText })) yield e
      return
    }
    for (const e of text("done")) yield e
  }
}

const allToolResults = (out: { messages: import("@/llm").Message[] }): string[] =>
  out.messages.flatMap((m) =>
    m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])),
  )

const perm: PermissionContext = { mode: "acceptEdits" }

const run = async (scanText: string, enabled: boolean | undefined, label: string) => {
  const llm = new CheckSecretsLLM(scanText)
  const out = await withTimeout(
    runAgent(
      cfg({
        llm,
        stream: new RecordingStream(),
        registry: new ToolRegistry(defaultTools),
        permission: perm,
        cwd: "/tmp",
        maxTurns: 6,
        ...(enabled !== undefined ? { secretCheckToolEnabled: enabled } : {}),
      }),
    ),
    15_000,
    label,
  )
  return { out, llm }
}

describe("check-secrets-llm-tool — real loop + fake LLM, tool dispatch returns real verdict", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("dirty input ⇒ check_secrets dispatches through runAgent and returns a real FINDING to the next turn", async () => {
    const { out, llm } = await run(`export KEY=${AWS_KEY}`, true, "check-secrets-dirty")
    expect(out.reason).toBe("completed")

    // The tool was actually offered to the model (registered via the enabled gate).
    expect(llm.toolNamesSeen).toContain("check_secrets")

    // GROUND TRUTH: the real scanner found the AWS key and the verdict reached
    // the model on the follow-up turn's tool_result.
    const results = allToolResults(out)
    const verdict = results.find((c) => c.includes("check_secrets:"))
    expect(verdict).toBeDefined()
    expect(verdict ?? "").toContain("finding(s)")
    expect(verdict ?? "").not.toContain("0 findings (clean)")
    // The model observed the verdict across the turn boundary.
    expect(llm.toolResultsSeen.some((c) => c.includes("finding(s)"))).toBe(true)
  })

  test("PAIRED CONTROL: clean input ⇒ same tool dispatches and returns `0 findings (clean)`", async () => {
    const { out, llm } = await run(CLEAN_TEXT, true, "check-secrets-clean")
    expect(out.reason).toBe("completed")
    expect(llm.toolNamesSeen).toContain("check_secrets")

    // GROUND TRUTH: the SAME tool, over clean input, returns the clean verdict —
    // the verdict is derived from the real scan, not a fixed per-call string.
    const results = allToolResults(out)
    const verdict = results.find((c) => c.includes("check_secrets:"))
    expect(verdict).toBeDefined()
    expect(verdict ?? "").toContain("0 findings (clean)")
    expect(verdict ?? "").not.toContain("finding(s)")
    expect(llm.toolResultsSeen.some((c) => c.includes("0 findings (clean)"))).toBe(true)
  })

  test("CONTROL (non-vacuity): gate OFF ⇒ check_secrets is NOT registered ⇒ dispatch yields Unknown tool", async () => {
    // Without `secretCheckToolEnabled`, `buildCheckSecretsBlock` returns [] so the
    // tool is never in the effective registry. The model's attempt to call it
    // dispatches to an "Unknown tool" deny — proving the DIRTY test's finding is
    // the ENABLED registration's doing, not an always-on tool.
    const { out, llm } = await run(`export KEY=${AWS_KEY}`, undefined, "check-secrets-off")
    expect(out.reason).toBe("completed")
    // The tool was never offered to the model.
    expect(llm.toolNamesSeen).not.toContain("check_secrets")
    const results = allToolResults(out)
    // No real scan verdict was ever produced; the call resolved as unknown tool.
    expect(results.some((c) => c.includes("check_secrets:"))).toBe(false)
    expect(results.some((c) => c.includes("Unknown tool: check_secrets"))).toBe(true)
  })
})
