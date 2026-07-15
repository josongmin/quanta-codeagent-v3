import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { RedactionConfig } from "@/security"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { z } from "zod"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the PII-redaction dispatch wire
 * (`pii-redaction-dispatch-wire` feature). Prior coverage
 * (`tests/unit/dispatch-pii-redaction-hellgate.test.ts`) drives the masking by
 * calling `dispatchTool(...)` DIRECTLY and inspecting the RETURNED
 * `DispatchResult.preview` — it never runs a real loop, so it does NOT prove
 * the masking survives onto the tool_result the NEXT turn's LLM actually sees
 * (`runAgent × scripted-LLM == 0`).
 *
 * THE WIRED CONTRACT (`dispatch/execute.ts#applyRedaction`, application point
 * #2): after the secret pass, when `config.redaction.pii.enabled === true`, a
 * `compositePiiScanner().redactText(...)` pass masks PII in the tool's
 * `result.output`. That masked output becomes the `tool_result` block appended
 * to the conversation and fed to the model on its follow-up turn.
 *
 * GROUND TRUTH — capture the NEXT turn's `StreamInput.messages` and assert the
 * `tool_result` the model sees is masked:
 *   - PII ON  + a tool output carrying an email + a phone ⇒ the follow-up
 *     turn's tool_result shows `[EMAIL]` / `[PHONE]` and the raw values are
 *     GONE (masking actually applied in-band, mid-loop).
 *   - PAIRED CONTROL: PII OFF (config absent) ⇒ the SAME output reaches the
 *     next turn UNCHANGED (raw email/phone survive) — proving the masking is
 *     the PII branch's doing, not something else scrubbing every tool_result.
 *
 * We assert on the `StreamInput` the SCRIPTED LLM captured (what the model
 * literally received), not on `out.messages` alone — the whole point of the
 * gap is "does the NEXT turn's LLM see the masked text?".
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

const EMAIL = "alice@example.com"
const PHONE = "415-555-1234"
/** The real tool output the redaction chokepoint processes mid-loop. */
const PII_OUTPUT = `owner ${EMAIL} on-call ${PHONE} — escalate here`

/** A minimal deterministic tool whose `result.output` carries PII. The real
 *  `applyRedaction` chokepoint runs on ANY tool's output, so this is a faithful
 *  stand-in that keeps the PII string byte-exact (no shell-escaping noise). */
const piiEmitTool = (): Tool => ({
  name: "pii_emit",
  description: "emits a fixed PII-bearing string (test tool)",
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: PII_OUTPUT } }
  },
})

const registryWithPiiTool = (): ToolRegistry =>
  new ToolRegistry([...defaultTools, piiEmitTool()])

/** The tool_result content the LLM saw on each stream() call, in order — the
 *  authoritative view of what the NEXT turn's model actually received. */
const toolResultsInInput = (input: StreamInput): string[] =>
  input.messages.flatMap((m) =>
    m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])),
  )

/** Scripted LLM: turn 1 calls `pii_emit`, then finishes. Records the
 *  tool_result contents it received on EACH turn (so the follow-up turn's view
 *  of the tool_result is inspectable). */
class PiiLLM implements LLMPort {
  readonly model = "pii-redaction-test-model"
  calls = 0
  /** Per-turn snapshot of the tool_result contents the model saw. */
  readonly toolResultsPerTurn: string[][] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.toolResultsPerTurn.push(toolResultsInInput(input))
    this.calls += 1
    if (this.calls === 1) {
      for (const e of toolUse("p1", "pii_emit", {})) yield e
      return
    }
    for (const e of text("done")) yield e
  }
}

const perm: PermissionContext = { mode: "acceptEdits" }

const run = async (redaction: RedactionConfig | undefined, label: string) => {
  const llm = new PiiLLM()
  const out = await withTimeout(
    runAgent(
      cfg({
        llm,
        stream: new RecordingStream(),
        registry: registryWithPiiTool(),
        permission: perm,
        cwd: "/tmp",
        maxTurns: 6,
        ...(redaction !== undefined ? { redaction } : {}),
      }),
    ),
    15_000,
    label,
  )
  return { out, llm }
}

/** All tool_result contents the model saw on the FOLLOW-UP turn (turn 2+) —
 *  i.e. AFTER the pii_emit call, which is where the masked/unmasked output
 *  lands. */
const followUpToolResults = (llm: PiiLLM): string[] => llm.toolResultsPerTurn.slice(1).flat()

describe("pii-redaction-dispatch-wire — real loop + fake LLM, masking on the next turn's tool_result", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("PII ON ⇒ the tool_result the NEXT turn's LLM sees is MASKED ([EMAIL]/[PHONE], raw values gone)", async () => {
    const { llm } = await run({ pii: { enabled: true } }, "pii-on")

    // GROUND TRUTH: the model's follow-up turn received the MASKED tool_result.
    const seen = followUpToolResults(llm)
    const result = seen.find((c) => c.includes("[EMAIL]") || c.includes(EMAIL))
    expect(result).toBeDefined()
    expect(result ?? "").toContain("[EMAIL]")
    expect(result ?? "").toContain("[PHONE]")
    // The raw PII is GONE from what the model saw — masking actually applied
    // in-band on the tool_result, not merely on the DispatchResult preview.
    expect(result ?? "").not.toContain(EMAIL)
    expect(result ?? "").not.toContain(PHONE)
  })

  test("PAIRED CONTROL: PII OFF (config absent) ⇒ the SAME tool_result reaches the next turn UNCHANGED", async () => {
    const { llm } = await run(undefined, "pii-off")

    // The follow-up turn saw the RAW output — no PII masking (existing
    // secret-only baseline has no email/phone rule, so the values survive).
    const seen = followUpToolResults(llm)
    const result = seen.find((c) => c.includes(EMAIL) || c.includes("[EMAIL]"))
    expect(result).toBeDefined()
    expect(result ?? "").toContain(EMAIL)
    expect(result ?? "").toContain(PHONE)
    expect(result ?? "").not.toContain("[EMAIL]")
    expect(result ?? "").not.toContain("[PHONE]")
  })

  test("CONTROL: pii.enabled === false ⇒ strict-true gate OFF ⇒ tool_result UNCHANGED (non-vacuity)", async () => {
    // `enabled: false` is the explicit off form — the strict `=== true` gate
    // must NOT fire. Proves the ON test's masking is keyed on the exact flag,
    // not on any truthy `pii` block being present.
    const { llm } = await run({ pii: { enabled: false } }, "pii-false")
    const seen = followUpToolResults(llm)
    const result = seen.find((c) => c.includes(EMAIL) || c.includes("[EMAIL]"))
    expect(result).toBeDefined()
    expect(result ?? "").toContain(EMAIL)
    expect(result ?? "").not.toContain("[EMAIL]")
  })
})
