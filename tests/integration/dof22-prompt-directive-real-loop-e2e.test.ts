import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import type { Message, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream, text, withTimeout } from "./_harness"

/**
 * DOF-22 — GATE-SPECIFIC behavior-regression proof for prompt-directive
 * (QUANTA_DIRECTIVE_AUTONOMOUS, gate-read src/agent/prompt-reminders.ts:159
 * `resolveDirectiveConfig` → `selectActiveDirectives` (prompt-directives.ts:191)
 * → the directive text spliced into the per-turn DYNAMIC `<system-reminder>`).
 *
 * WHY NOT REDUNDANT WITH `prompt-directives-hellgate.test.ts`:
 * that sibling drives `buildTurnContext(...)` DIRECTLY (a synthetic
 * TurnContextInput). It proves the directive lands in the assembled reminder
 * tail, but the FULL `runAgent × scripted-LLM` chain — the loop actually
 * building that per-turn reminder and threading it onto the `StreamInput.messages`
 * the model consumes — was `runAgent = 0`. This drives the REAL loop and reads
 * GROUND TRUTH off the stream input the model saw.
 *
 * WHY THE GENERIC 8-AXIS A/B *DOES* move on `systemBytes` but still MIS-ATTRIBUTES:
 * a directive rides the per-turn USER-side system-reminder message, NOT the FIRST
 * system prompt whose byte length the harness captures as `systemBytes` — so the
 * generic harness's `systemBytes` axis is UNCHANGED (byte-identical) and it
 * reports a FALSE NO-REGRESSION even though the model's per-turn input DID change.
 * The specific observable is the directive marker text in a turn's reminder
 * message; asserted directly here.
 *
 * OBSERVABLE       : the marker `AUTONOMOUS MODE:` in a `<system-reminder>` text
 *                    block of some turn's `StreamInput.messages`.
 * ON  (env=1)      : marker present.
 * OFF (control)    : env unset ⇒ marker absent (byte-identical reminder tail).
 * RED-ON-INJECTION : gate off in the ON scenario ⇒ the marker vanishes.
 *
 * We use QUANTA_DIRECTIVE_AUTONOMOUS as the representative directive of the
 * bundle (all nine share the same `resolveDirectiveConfig` gate-read + splice
 * mechanism, exhaustively unit-tested in the hellgate); one real-loop witness
 * proves the wire lands.
 */

const GATE = "QUANTA_DIRECTIVE_AUTONOMOUS"
const MARKER = "AUTONOMOUS MODE:"
const ENVELOPE = "system-reminder"

/** Records every per-turn `StreamInput.messages` so the test can inspect the
 *  reminder tail the model actually saw. */
class MessageCapturingLLM {
  readonly model = "dof22-prompt-directive"
  readonly seen: Message[][] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input.messages)
    yield* text("done")
  }
}

/** Flatten every text block across all captured turns' messages. The directive
 *  rides a user-role `<system-reminder>` text block. */
const reminderText = (seen: Message[][]): string =>
  seen
    .flat()
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")

/** Empty base system keeps the real dynamic reminder assembly while satisfying
 * the required AgentConfig contract. */
const directiveConfig = (llm: MessageCapturingLLM): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as AgentConfig["permission"],
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  system: "",
  cwd: "/tmp",
  maxTurns: 3,
  signal: new AbortController().signal,
  onConfirm: async () => false,
})

const runAndCaptureReminders = async (label: string): Promise<string> => {
  const llm = new MessageCapturingLLM()
  const out = await withTimeout(runAgent(directiveConfig(llm)), 15_000, label)
  expect(out.reason).toBe("completed")
  return reminderText(llm.seen)
}

describe("DOF-22 prompt-directive — real runAgent loop threads the directive into the per-turn reminder the model sees", () => {
  const orig = process.env[GATE]
  beforeEach(() => {
    delete process.env[GATE]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (orig === undefined) delete process.env[GATE]
    else process.env[GATE] = orig
    __resetRuntimeConfig()
  })

  test("ON (env=1) ⇒ the directive marker is spliced into a reminder the model saw", async () => {
    process.env[GATE] = "1"
    __resetRuntimeConfig()
    const txt = await runAndCaptureReminders("dof22-directive-on")
    // A reminder envelope was assembled AND it carries the directive marker.
    expect(txt).toContain(ENVELOPE)
    expect(txt).toContain(MARKER)
  })

  test("OFF CONTROL (env unset) ⇒ the marker is ABSENT from every turn's reminder", async () => {
    const txt = await runAndCaptureReminders("dof22-directive-off")
    // The reminder still assembles (date/cwd), but carries NO directive text.
    expect(txt).toContain(ENVELOPE)
    expect(txt).not.toContain(MARKER)
  })

  // RED-ON-INJECTION: run BOTH sides identically; only the env gate differs. If
  // the gate-read were inert (directive always/never spliced), the two reminder
  // corpora would not differ on the marker and this fails.
  test("RED-ON-INJECTION: the directive marker presence is CONTROLLED BY the env gate (ON≠OFF, same config)", async () => {
    process.env[GATE] = "1"
    __resetRuntimeConfig()
    const on = await runAndCaptureReminders("dof22-directive-inj-on")

    delete process.env[GATE]
    __resetRuntimeConfig()
    const off = await runAndCaptureReminders("dof22-directive-inj-off")

    expect(on).toContain(MARKER)
    expect(off).not.toContain(MARKER)
    expect(on.includes(MARKER)).not.toBe(off.includes(MARKER))
  })
})
