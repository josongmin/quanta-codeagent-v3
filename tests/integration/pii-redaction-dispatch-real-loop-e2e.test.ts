import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { z } from "zod"
import { RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the PII-redaction dispatch wire
 * (`pii-redaction-dispatch-wire` feature). Prior coverage
 * (`tests/unit/dispatch-pii-redaction-hellgate.test.ts`) drives the masking by
 * calling `dispatchTool(...)` DIRECTLY and inspecting the RETURNED
 * `DispatchResult.preview` — it never runs a real loop, so it does NOT prove
 * the masking survives onto the tool_result the NEXT turn's LLM actually sees
 * (`runAgent × scripted-LLM == 0`).
 *
 * REACHABILITY (the dead-end this suite closes): the masking chokepoint
 * (`dispatch/execute.ts#applyRedaction`, application point #2) fires only when
 * `config.redaction.pii.enabled === true`, but NO production composition root
 * populated that field — so the whole PII pass was unreachable by any operator.
 * The fix wired an env switch (`QUANTA_PII_REDACTION=1`) through the SHARED
 * composition root (`agent-config-assembler.ts#maybeWirePiiRedaction`). This
 * suite drives that REAL seam — it sets the env and lets `assembleAgentConfig`
 * populate `cfg.redaction.pii`, rather than hand-injecting the config — so it
 * proves the feature is REACHABLE end-to-end, not merely that the chokepoint
 * masks a hand-built config.
 *
 * THE WIRED CONTRACT (`dispatch/execute.ts#applyRedaction`, application point
 * #2): after the secret pass, when `config.redaction.pii.enabled === true`, a
 * `compositePiiScanner().redactText(...)` pass masks PII in the tool's
 * `result.output`. That masked output becomes the `tool_result` block appended
 * to the conversation and fed to the model on its follow-up turn.
 *
 * GROUND TRUTH — capture the NEXT turn's `StreamInput.messages` and assert the
 * `tool_result` the model sees is masked:
 *   - PII ON  (`QUANTA_PII_REDACTION=1` through the assembler) + a tool output
 *     carrying an email + a phone ⇒ the follow-up turn's tool_result shows
 *     `[EMAIL]` / `[PHONE]` and the raw values are GONE (masking actually
 *     applied in-band, mid-loop, via the operator switch).
 *   - PAIRED CONTROL: PII OFF (env unset) ⇒ the assembler leaves `redaction`
 *     unset, the SAME output reaches the next turn UNCHANGED (raw email/phone
 *     survive) — proving the masking is the wired enable-path's doing, not
 *     something else scrubbing every tool_result.
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

/** Build the assembler base (surface-specific AgentConfig core). The assembler
 *  adds `modePolicy` + `budgetMeter` and — the point of this suite — populates
 *  `cfg.redaction.pii` from the env gate via `maybeWirePiiRedaction`. */
const baseFor = (llm: LLMPort): RuntimeAgentConfigBase =>
  ({
    llm,
    stream: new RecordingStream(),
    registry: registryWithPiiTool(),
    permission: perm,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 6,
    signal: new AbortController().signal,
    onConfirm: async () => false,
  }) as unknown as RuntimeAgentConfigBase

/** Drive the REAL composition seam: assemble the config from the given
 *  operator `env` (so the enable path — NOT a hand-injected `redaction` — is
 *  what turns PII masking on), then run the real loop. */
const run = async (env: AssemblerEnv, label: string) => {
  const llm = new PiiLLM()
  const assembled = assembleAgentConfig({ mode: "interactive", base: baseFor(llm) }, env)
  const out = await withTimeout(runAgent(assembled), 15_000, label)
  return { out, assembled, llm }
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

  test("PII ON via QUANTA_PII_REDACTION ⇒ assembler populates cfg.redaction.pii AND the NEXT turn's tool_result is MASKED", async () => {
    const { assembled, llm } = await run({ QUANTA_PII_REDACTION: "1" }, "pii-on")

    // REACHABILITY: the operator switch went THROUGH the composition root — the
    // assembler minted the pii block on cfg (NOT hand-injected by the test).
    expect(assembled.redaction?.pii?.enabled).toBe(true)

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

  test("PAIRED CONTROL: env unset ⇒ assembler leaves redaction UNSET ⇒ the SAME tool_result reaches the next turn UNCHANGED", async () => {
    const { assembled, llm } = await run({}, "pii-off")

    // REACHABILITY (default-OFF): no gate ⇒ the assembler wired NO pii block, so
    // the dispatch chokepoint's strict `=== true` toggle can never fire.
    expect(assembled.redaction?.pii).toBeUndefined()

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

  test("CONTROL: QUANTA_PII_REDACTION=0 ⇒ gate OFF at the composition root ⇒ redaction UNSET, tool_result UNCHANGED (non-vacuity)", async () => {
    // A non-truthy gate token must be treated as OFF by the assembler — proving
    // the ON test's masking is keyed on the actual operator switch, not on the
    // env var merely being PRESENT.
    const { assembled, llm } = await run({ QUANTA_PII_REDACTION: "0" }, "pii-gate-off")
    expect(assembled.redaction?.pii).toBeUndefined()
    const seen = followUpToolResults(llm)
    const result = seen.find((c) => c.includes(EMAIL) || c.includes("[EMAIL]"))
    expect(result).toBeDefined()
    expect(result ?? "").toContain(EMAIL)
    expect(result ?? "").not.toContain("[EMAIL]")
  })
})
