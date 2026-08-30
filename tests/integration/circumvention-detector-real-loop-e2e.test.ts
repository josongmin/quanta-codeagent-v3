import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  CIRCUMVENTION_TAXONOMY_LINE,
  CircumventionTracker,
  type ClassifierPort,
  type PermissionContext,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the tool-switch CIRCUMVENTION detector
 * (`circumvention-detector` feature). Prior coverage was 12 predicate-level
 * hellgates that hand-build a `CircumventionTracker` and call `evaluateAuto` /
 * `runAdmissibilityGate` directly (`runAgent × scripted == 0`). NONE drove the
 * detector's CROSS-TURN denied-effect memory through the real loop, where the
 * `AutoModeClassifier` is built from `config.llm`, the `turn` clock comes from
 * `config.run.turn` (stamped per turn by `turn-iteration.ts`), and the tracker
 * is threaded via `config.admissibility.circumventionTracker` into
 * `dispatch.ts` → `runAdmissibilityGate` → `evaluateAuto`.
 *
 * THE WIRED CONTRACT (verified in `gates.ts#buildEvaluateAutoOptions`): the gate
 * never sets `posture`, so at runtime the detector is ADVISORY-only — a live
 * same-effect-different-tool match threads the verbatim
 * {@link CIRCUMVENTION_TAXONOMY_LINE} + advisory into the classifier's system
 * prompt (`withCircumventionContext`), and the classifier (the LLM) decides. So
 * "auto-denies the circumventing call" is realized end-to-end as: the advisory
 * reaches the real classifier prompt ⇒ the classifier blocks ⇒ the second-tool
 * write is denied through real dispatch and never executes.
 *
 * Scenario (all through ONE `runAgent`):
 *   turn 1  write → SECRET            → classifier DENIES → tracker records
 *                                        soft-deny of write:SECRET (cross-turn).
 *   turn 2  bash `echo > SECRET`      → CIRCUMVENTING (same path, diff tool):
 *                                        the advisory reaches the classifier ⇒
 *                                        blocked ⇒ SECRET is NEVER written.
 *   turn 3  bash `echo > OTHER`       → PAIRED CONTROL (diff path, no prior
 *                                        deny): NO advisory ⇒ classifier allows
 *                                        ⇒ OTHER IS written (ground-truth split).
 *
 * NON-VACUITY: the classifier blocks a `bash` write ONLY when the taxonomy line
 * is present in its system prompt. The control `bash` write to OTHER is
 * allowed, proving a bash write is not blocked per se — the ONLY thing that
 * denies the circumventing bash is the detector's threaded advisory. If the
 * cross-turn memory failed to arm, SECRET would be written (a real regression),
 * which the file-existence ground truth catches.
 */

const CLASSIFIER_MARKER = "security monitor for autonomous AI coding agents"

const isClassifierReq = (input: StreamInput): boolean => {
  const sys = input.system
  const sysText = typeof sys === "string" ? sys : (sys ?? []).map((b) => b.text).join("")
  return sysText.includes(CLASSIFIER_MARKER)
}

const systemText = (input: StreamInput): string => {
  const sys = input.system
  return typeof sys === "string" ? sys : (sys ?? []).map((b) => b.text).join("")
}

const transcriptText = (input: StreamInput): string =>
  input.messages.flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : ""))).join(" ")

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const ALLOW: StreamEvent[] = text("<block>no</block>")
const block = (reason: string): StreamEvent[] =>
  text(`<block>yes</block><reason>${reason}</reason>`)

const classifierResponse = (
  system: string,
  transcript: string,
  secretPath: string,
): StreamEvent[] => {
  if (system.includes(CIRCUMVENTION_TAXONOMY_LINE)) {
    return block("circumvention advisory present")
  }
  if (transcript.includes("write") && transcript.includes(secretPath)) {
    return block("seed deny of the protected path")
  }
  return ALLOW
}

/**
 * One LLM double for BOTH the main agent turns (positional model script) AND the
 * classifier round-trips. The classifier verdict is deterministically derived
 * from the request so the DETECTOR — not a hard-coded verdict-per-call — is the
 * load-bearing signal:
 *
 *   - The taxonomy line present in the classifier system prompt ⇒ BLOCK. This
 *     is the ONLY reason the circumventing `bash` write is denied.
 *   - The seeding `write` to SECRET (recognised by tool name + the SECRET path
 *     in the transcript) ⇒ BLOCK, to record the cross-turn soft-deny.
 *   - Everything else ⇒ ALLOW (so the control `bash` write to OTHER runs).
 *
 * Records every classifier system prompt so a test can assert exactly which
 * call carried the advisory.
 */
class CircumventionLLM implements LLMPort {
  readonly model = "circumvention-test-model"
  classifierCalls = 0
  modelCalls = 0
  /** System prompt of every classifier round-trip, in order. */
  readonly classifierPrompts: string[] = []
  constructor(
    private readonly modelScript: StreamEvent[][],
    private readonly secretPath: string,
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (isClassifierReq(input)) {
      this.classifierCalls += 1
      const sys = systemText(input)
      const txt = transcriptText(input)
      this.classifierPrompts.push(sys)
      // (1) Circumvention advisory reached the prompt ⇒ block. Load-bearing.
      for (const event of classifierResponse(sys, txt, this.secretPath)) yield event
      return
    }
    const next = this.modelScript.shift() ?? text("done")
    this.modelCalls += 1
    for (const e of next) yield e
  }
}

/** Truthy stub so `evaluateAuto` composes the canonical taxonomy (+ the
 *  circumvention advisory) as the classifier system prompt. The ACTUAL port is
 *  the features-built `config.llm`-backed one — this only selects the prompt. */
const stubPort: ClassifierPort = async () => ({ verdict: "allow", reason: "stub" })
const autoPerm = (): PermissionContext => ({ mode: "auto", classify: stubPort })

describe("circumvention-detector — real loop + fake LLM, cross-turn denied-effect memory", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "circumvent-e2e-"))
    process.env.QUANTA_CIRCUMVENT_DETECT = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    process.env.QUANTA_CIRCUMVENT_DETECT = undefined
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("turn-2 bash circumventing a turn-1 write-deny is AUTO-DENIED; control write to a fresh path is ALLOWED", async () => {
    const secret = join(dir, "secret.txt")
    const other = join(dir, "other.txt")
    const tracker = new CircumventionTracker()
    const llm = new CircumventionLLM(
      [
        // turn 1: first-party write to the protected path (will be soft-denied).
        toolUse("w1", "write", { path: secret, content: "first-party" }),
        // turn 2: TOOL-SWITCH — same path via bash redirect (the circumvention).
        toolUse("b2", "bash", { command: `echo circumvented > ${secret}` }),
        // turn 3: PAIRED CONTROL — a bash write to a DIFFERENT, un-denied path.
        toolUse("b3", "bash", { command: `echo control > ${other}` }),
        // turn 4: wrap up.
        text("done"),
      ],
      secret,
    )
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          permission: autoPerm(),
          cwd: dir,
          maxTurns: 8,
          admissibility: { circumventionTracker: tracker },
        }),
      ),
      15_000,
      "circumvention-real-loop",
    )

    expect(out.reason).toBe("completed")

    // GROUND TRUTH on the filesystem: the protected path was NEVER written —
    // neither the denied first-party write NOR the circumventing tool-switch.
    expect(await Bun.file(secret).exists()).toBe(false)
    // The paired control (fresh path, no prior deny) DID run — proving a bash
    // write is not blocked per se; only the circumventing one is.
    expect(await Bun.file(other).text()).toBe("control\n")

    // The tracker actually accumulated the cross-turn soft-deny (not inert).
    expect(tracker.size()).toBeGreaterThanOrEqual(1)

    // The classifier prompt for the circumventing bash carried the verbatim
    // taxonomy line + the protected path; the control bash prompt did NOT.
    const withAdvisory = llm.classifierPrompts.filter((p) =>
      p.includes(CIRCUMVENTION_TAXONOMY_LINE),
    )
    expect(withAdvisory.length).toBeGreaterThanOrEqual(1)
    expect(withAdvisory.some((p) => p.includes(secret))).toBe(true)
    expect(withAdvisory.some((p) => p.includes(other))).toBe(false)

    // Real dispatch surfaced a denial tool_result for the circumventing call.
    const denied = out.messages.flatMap((m) =>
      m.content.filter(
        (b) =>
          b.type === "tool_result" &&
          b.is_error === true &&
          b.content.includes("circumvention advisory present"),
      ),
    )
    expect(denied.length).toBeGreaterThanOrEqual(1)
  })

  test("CONTROL: same tool-switch with the detector OFF ⇒ the second-tool write EXECUTES (non-vacuous)", async () => {
    // Detector OFF ⇒ no denied-effect memory ⇒ the taxonomy advisory is never
    // threaded ⇒ the classifier allows the bash write ⇒ SECRET IS created. This
    // proves the ON-path denial above is the detector's doing, not some other
    // gate silently blocking every bash redirect.
    process.env.QUANTA_CIRCUMVENT_DETECT = undefined
    __resetRuntimeConfig()
    const secret = join(dir, "secret.txt")
    const tracker = new CircumventionTracker()
    const llm = new CircumventionLLM(
      [
        toolUse("w1", "write", { path: secret, content: "first-party" }),
        toolUse("b2", "bash", { command: `echo circumvented > ${secret}` }),
        text("done"),
      ],
      secret,
    )
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          permission: autoPerm(),
          cwd: dir,
          maxTurns: 8,
          admissibility: { circumventionTracker: tracker },
        }),
      ),
      15_000,
      "circumvention-off-control",
    )
    expect(out.reason).toBe("completed")
    // No advisory was ever threaded (detector inert) — the classifier saw the
    // canonical prompt for the bash write and allowed it.
    expect(llm.classifierPrompts.some((p) => p.includes(CIRCUMVENTION_TAXONOMY_LINE))).toBe(false)
    // The tool-switch write SUCCEEDED — the detector was the only thing standing
    // between the agent and the protected path.
    expect(await Bun.file(secret).text()).toBe("circumvented\n")
  })
})
