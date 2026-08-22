/**
 * HELLGATE — jun-7-misc 04 (b), round-2 finding: the LIVE gate's circumvention
 * posture MUST stay ADVISORY-ONLY.
 *
 * THE CONTRACT (runtime-config doc for `circumventDetect`, verbatim): a
 * circumvention signal surfaces "an advisory circumvention signal (NEVER an
 * auto-deny — advisory only)". The deterministic forced-HITL `escalate` posture
 * exists at the policy layer (`evaluateAuto`'s `posture: "escalate"`) and is
 * unit-tested there, but the LIVE wiring (`buildEvaluateAutoOptions` in the gate)
 * deliberately NEVER sets `posture`, so the gate can only take the advisory
 * branch: a match threads a context line and lets the CLASSIFIER decide.
 *
 * THE HOLE this closes (a ratchet, not a present bug): there was no test pinning
 * the advisory-only LIVE contract. If a future edit wired `posture: "escalate"`
 * into the gate, `precheckCircumvention` would short-circuit to a forced `ask`
 * BEFORE the classifier — silently breaking the documented "advisory only"
 * guarantee with no failing test.
 *
 * THE INVARIANT: with `QUANTA_CIRCUMVENT_DETECT=1` AND a live circumvention match
 * (a prior soft-deny of /repo/X via `Write`, then a `bash` redirect to /repo/X),
 * the classifier MUST STILL be consulted (advisory) — it is NOT short-circuited
 * to a forced `ask`. A mock classifier that returns `allow` therefore yields an
 * APPROVED action (the gate does not auto-block on the circumvention signal).
 *
 * RED-ON-INJECTION: wire `posture: "escalate"` into `buildEvaluateAutoOptions`
 * (or otherwise make the live gate force an `ask` on a circumvention match) and
 * the "classifier consulted" + "approved" assertions below fail.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import {
  __resetDefaultPermissionStore,
  AutoModeClassifier,
  CIRCUMVENTION_TAXONOMY_LINE,
  CircumventionTracker,
  type ClassifyDecision,
  type ClassifyRequest,
  type PermissionContext,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

const KNOB = "QUANTA_CIRCUMVENT_DETECT"
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KNOB]
  process.env[KNOB] = "1"
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (saved === undefined) delete process.env[KNOB]
  else process.env[KNOB] = saved
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const bashTool = (): Tool => {
  const tool: Tool = {
    name: "bash",
    description: "bash",
    inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }
  ;(tool as Tool & { extractShellCommand: (i: unknown) => string | null }).extractShellCommand = (
    i,
  ) => (i as { command: string }).command
  return tool
}

const recordingPort = () => {
  const prompts: string[] = []
  const port = (req: ClassifyRequest): Promise<ClassifyDecision> => {
    prompts.push(req.systemPrompt)
    return Promise.resolve({ verdict: "allow", reason: "allow (mock)" })
  }
  return { port, prompts }
}

const cfg = (): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    registry: new ToolRegistry([bashTool()]),
    run: { turn: 5 },
  }) as AgentConfig

const call = (command: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "bash",
  input: { command },
})

const actionOf = (command: string): AdmissibilityAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
})

const autoPermission = (
  port: (r: ClassifyRequest) => Promise<ClassifyDecision>,
): PermissionContext => ({ mode: "auto", classify: port }) as PermissionContext

describe("LIVE gate — circumvention is ADVISORY ONLY (never a forced ask)", () => {
  test("a live circumvention match STILL consults the classifier (not short-circuited)", async () => {
    const tracker = new CircumventionTracker()
    // Prior soft-deny of a Write to /repo/X.
    tracker.noteDenied({ kind: "write", path: "/repo/X" }, "Write", 1)
    const { port, prompts } = recordingPort()
    const classifier = new AutoModeClassifier(port)

    // bash redirect to the SAME path /repo/X via a DIFFERENT tool ⇒ a match.
    const result = await runAdmissibilityGate(
      call("echo hi > /repo/X"),
      cfg(),
      autoPermission(port),
      actionOf("echo hi > /repo/X"),
      classifier,
      { circumventionTracker: tracker },
    )

    // ADVISORY: the classifier IS consulted (a forced `escalate` ask would
    // short-circuit BEFORE the classifier, leaving prompts empty).
    expect(prompts.length).toBeGreaterThan(0)
    // The advisory taxonomy line WAS threaded (proves the match fired — this is
    // not a "no signal" false pass).
    expect(prompts[0]).toContain(CIRCUMVENTION_TAXONOMY_LINE)
    // And because the (mock) classifier ALLOWED, the gate did NOT auto-block:
    // an approved auto-mode action returns `null` (proceed), never a HITL ask.
    expect(result).toBeNull()
  })
})
