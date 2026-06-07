/**
 * HELLGATE — jun-7-misc 04: GATE-LEVEL default-OFF byte-identity + ON activation.
 *
 * The most load-bearing ratchet of the slice. Drives the REAL
 * `runAdmissibilityGate` in "auto" mode with a recording classifier port and
 * asserts:
 *
 *  - KNOBS OFF (default): the classifier sees the canonical
 *    `CLASSIFIER_SYSTEM_PROMPT` — NO operator-rule overlay section even when a
 *    rules store carrying a user `allow` is wired, and NO circumvention line
 *    even when a tracker is wired. This is the byte-identity guarantee: absent
 *    the strict `=1` knobs, the auto-mode gate path is unchanged.
 *  - `QUANTA_AUTO_MODE_RULES=1`: the wired rules-store overlay NOW composes
 *    onto the classifier prompt (the user `allow` line appears).
 *  - `QUANTA_CIRCUMVENT_DETECT=1`: the wired tracker is NOW consulted (a prior
 *    soft-denied effect, hit via a different tool, threads the advisory line).
 *
 * RED-ON-INJECTION: loosening the gate (e.g. consuming the overlay/tracker
 * without the strict knob, or defaulting the knob ON) flips the OFF assertions.
 *
 * Source under test:
 *   src/agent/admissibility-gate.ts — buildEvaluateAutoOptions (knob gating)
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
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifyDecision,
  type ClassifyRequest,
  type PermissionContext,
} from "@/permission"
import { RulesStore } from "@/rules"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

const KNOBS = ["QUANTA_AUTO_MODE_RULES", "QUANTA_CIRCUMVENT_DETECT"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KNOBS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

/** A bash-equivalent tool exposing `extractShellCommand`. */
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
  return { port: port as ClassifyRequest extends never ? never : typeof port, prompts }
}

const cfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    registry: new ToolRegistry([bashTool()]),
    run: { turn: 5 },
    ...over,
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

/** A rules store with a TRUSTED user-layer `allow` line. */
const storeWithUserAllow = (): RulesStore => {
  const s = new RulesStore()
  s.loadLayer("user", "allow terraform apply", "user.rules")
  return s
}

describe("KNOBS OFF (default) — classifier sees canonical prompt, no wiring", () => {
  test("overlay store wired but knob OFF ⇒ NO operator-rule section", async () => {
    const { port, prompts } = recordingPort()
    const classifier = new AutoModeClassifier(port)
    await runAdmissibilityGate(
      call("ls"),
      cfg({}),
      autoPermission(port),
      actionOf("ls"),
      classifier,
      {
        rulesStore: storeWithUserAllow(),
      },
    )
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts[0]).toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(prompts[0]).not.toContain("Operator Rules")
    expect(prompts[0]).not.toContain("terraform apply")
  })

  test("tracker wired but knob OFF ⇒ NO circumvention line (and no recording)", async () => {
    const tracker = new CircumventionTracker()
    tracker.noteDenied({ kind: "write", path: "/repo/X" }, "Write", 1)
    const { port, prompts } = recordingPort()
    const classifier = new AutoModeClassifier(port)
    await runAdmissibilityGate(
      call("echo > /repo/X"),
      cfg({}),
      autoPermission(port),
      actionOf("echo > /repo/X"),
      classifier,
      { circumventionTracker: tracker },
    )
    expect(prompts[0]).toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(prompts[0]).not.toContain(CIRCUMVENTION_TAXONOMY_LINE)
    // The OFF tracker is never touched — the prior signature survives untouched.
    expect(tracker.size()).toBe(1)
  })
})

describe("QUANTA_AUTO_MODE_RULES=1 — overlay composes onto the prompt", () => {
  test("a TRUSTED user-layer allow line appears in the classifier prompt", async () => {
    process.env.QUANTA_AUTO_MODE_RULES = "1"
    __resetRuntimeConfig()
    const { port, prompts } = recordingPort()
    const classifier = new AutoModeClassifier(port)
    await runAdmissibilityGate(
      call("ls"),
      cfg({}),
      autoPermission(port),
      actionOf("ls"),
      classifier,
      {
        rulesStore: storeWithUserAllow(),
      },
    )
    expect(prompts[0]).not.toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(prompts[0]).toContain("Operator Rules")
    expect(prompts[0]).toContain("terraform apply")
  })

  test("loose value (=on, not the strict =1) does NOT activate", async () => {
    process.env.QUANTA_AUTO_MODE_RULES = "on"
    __resetRuntimeConfig()
    const { port, prompts } = recordingPort()
    const classifier = new AutoModeClassifier(port)
    await runAdmissibilityGate(
      call("ls"),
      cfg({}),
      autoPermission(port),
      actionOf("ls"),
      classifier,
      {
        rulesStore: storeWithUserAllow(),
      },
    )
    // Security knob is strict `=== "1"`; a loose "on" must NOT loosen the gate.
    expect(prompts[0]).toBe(CLASSIFIER_SYSTEM_PROMPT)
  })
})

describe("QUANTA_CIRCUMVENT_DETECT=1 — tracker consulted", () => {
  test("a prior soft-deny + same-path different-tool write threads the advisory", async () => {
    process.env.QUANTA_CIRCUMVENT_DETECT = "1"
    __resetRuntimeConfig()
    const tracker = new CircumventionTracker()
    tracker.noteDenied({ kind: "write", path: "/repo/X" }, "Write", 1)
    const { port, prompts } = recordingPort()
    const classifier = new AutoModeClassifier(port)
    await runAdmissibilityGate(
      call("echo > /repo/X"),
      cfg({}),
      autoPermission(port),
      actionOf("echo > /repo/X"),
      classifier,
      { circumventionTracker: tracker },
    )
    expect(prompts[0]).toContain(CIRCUMVENTION_TAXONOMY_LINE)
    expect(prompts[0]).toContain("/repo/X")
  })
})
