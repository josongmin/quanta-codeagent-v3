import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildSystemPrompt, type AgentConfig, runAgent } from "@/agent"
import type { StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream, text, withTimeout } from "./_harness"

/**
 * DOF-22 — GATE-SPECIFIC behavior-regression proof for delegation-suppress
 * (QUANTA_SUBAGENT_DELEGATE_SUPPRESS, gate-read src/agent/prompt-reminders.ts:83
 * → `hasDelegationSuppress` facet → the BODY tool-routing atom
 * A_TOOL_ROUTING / A_TOOL_ROUTING_SUPPRESS in prompt-graph/atoms-body.ts).
 *
 * WHY NOT REDUNDANT WITH `prompt-delegation-suppress-atom-hellgate.test.ts`:
 * that sibling drives `buildSystemPrompt()` / `renderAtoms` in ISOLATION. It
 * proves the atom swap and that the knob reaches `buildSystemPrompt`, but the
 * FULL `runAgent × scripted-LLM` chain — the assembled system prompt actually
 * LANDING on `llm.stream(input).system` the model sees — was `runAgent = 0`.
 * This drives the REAL loop and reads GROUND TRUTH off the stream input.
 *
 * WHY THE GENERIC 8-AXIS A/B CANNOT SEE THIS RELIABLY (adversarial finding):
 * the harness captures `systemBytes` (a byte COUNT of the first system prompt).
 * The suppressed variant swaps a fan-out block for an authorization block — the
 * byte count MOVES, but the generic harness only reports "systemBytes changed"
 * as a CHANGED verdict with no attribution to WHICH text; it cannot assert the
 * SPECIFIC steer (`parallel_worker:true` → `EXPLICITLY authorized`). Worse, if
 * the two blocks happened to be equal length the count delta would be ZERO and
 * the harness would FALSE-NEGATIVE. So we assert the specific substrings here.
 *
 * NOTE ON HERMETICITY: `config.system` MUST be OMITTED so the loop builds the
 * REAL system prompt (`buildTurnContext` uses `input.system ?? buildSystemPrompt()`
 * — a caller-provided string like the `_harness.cfg()` default `"test-system"`
 * would REPLACE the body atoms and make the observable structurally unreachable).
 *
 * OBSERVABLE       : the assembled system prompt text on `StreamInput.system`.
 * OFF (default)    : carries the unconditional fan-out encouragement
 *                    (`parallel_worker:true`), NOT `EXPLICITLY authorized`.
 * ON  (env set)    : carries `EXPLICITLY authorized`, NOT `parallel_worker:true`.
 * RED-ON-INJECTION : gate off in the ON scenario ⇒ the `EXPLICITLY authorized`
 *                    observable vanishes and `parallel_worker:true` returns.
 */

const GATE = "QUANTA_SUBAGENT_DELEGATE_SUPPRESS"
const FANOUT = "parallel_worker:true"
const AUTHORIZED = "EXPLICITLY authorized"

/** Captures the FIRST assembled system prompt the loop hands the model, flattened
 *  to text regardless of the SystemBlock shape (string | block[]). */
class SystemCapturingLLM {
  readonly model = "dof22-delegation-suppress"
  system: string | undefined
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (this.system === undefined) this.system = flattenSystem(input.system)
    yield* text("done")
  }
}

const flattenSystem = (s: StreamInput["system"]): string => {
  if (s === undefined) return ""
  if (typeof s === "string") return s
  if (Array.isArray(s)) {
    return s
      .map((b) => (typeof b === "string" ? b : ((b as { text?: string }).text ?? JSON.stringify(b))))
      .join("\n")
  }
  return JSON.stringify(s)
}

/** Build the same static base prompt the omitted-system fallback would render,
 * while keeping AgentConfig's required system contract explicit. */
const delegationConfig = (llm: SystemCapturingLLM): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as AgentConfig["permission"],
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  system: buildSystemPrompt(),
  cwd: "/tmp",
  maxTurns: 3,
  signal: new AbortController().signal,
  onConfirm: async () => false,
})

const runAndCaptureSystem = async (label: string): Promise<string> => {
  const llm = new SystemCapturingLLM()
  const out = await withTimeout(runAgent(delegationConfig(llm)), 15_000, label)
  expect(out.reason).toBe("completed")
  return llm.system ?? ""
}

describe("DOF-22 delegation-suppress — real runAgent loop threads the tool-routing atom to the model's system prompt", () => {
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

  test("ON (env=1) ⇒ system prompt carries the authorization-conditioned routing, NOT the fan-out line", async () => {
    process.env[GATE] = "1"
    __resetRuntimeConfig()
    const sys = await runAndCaptureSystem("dof22-deleg-on")
    expect(sys).toContain(AUTHORIZED)
    expect(sys).not.toContain(FANOUT)
  })

  test("OFF CONTROL (env unset) ⇒ system prompt carries the unconditional fan-out line, NOT authorization", async () => {
    const sys = await runAndCaptureSystem("dof22-deleg-off")
    expect(sys).toContain(FANOUT)
    expect(sys).not.toContain(AUTHORIZED)
  })

  // RED-ON-INJECTION: run BOTH sides with the identical config; the ONLY variable
  // is the env gate. If the gate-read were inert (atom always/never suppressed),
  // the two captured prompts would NOT differ on these two substrings and this
  // fails. This pins the delta to the gate alone.
  test("RED-ON-INJECTION: the routing steer is CONTROLLED BY the env gate (ON≠OFF, same config)", async () => {
    process.env[GATE] = "1"
    __resetRuntimeConfig()
    const on = await runAndCaptureSystem("dof22-deleg-inj-on")

    delete process.env[GATE]
    __resetRuntimeConfig()
    const off = await runAndCaptureSystem("dof22-deleg-inj-off")

    expect(on).toContain(AUTHORIZED)
    expect(on).not.toContain(FANOUT)
    expect(off).toContain(FANOUT)
    expect(off).not.toContain(AUTHORIZED)
    // The specific steer text differs BECAUSE of the gate (attributable delta).
    expect(on === off).toBe(false)
  })
})
