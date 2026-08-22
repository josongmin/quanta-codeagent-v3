/**
 * HELLGATE (E2E) — jun-7-misc 04: auto-mode user-rule overlay + tool-switch
 * circumvention detection, driven through the REAL seam end-to-end.
 *
 * This is the conclusive gap-closure test. Unlike the per-unit hellgates (which
 * probe `circumvention.ts` / `policy.ts` in isolation), this drives the ACTUAL
 * production chain with ZERO seam mocked:
 *
 *   runAdmissibilityGate (real gate)
 *     → withResolvedShellCommand (real registry.extractShellCommand)
 *     → runModePolicy → resolveModeDecision
 *     → buildEvaluateAutoOptions (REAL runtimeConfig() knob reads:
 *         autoModeRules / circumventDetect, strict `=== "1"`)
 *         → snapshotToLayeredRules (REAL RulesStore.snapshot — layer provenance
 *           is stamped by the REAL parser, NOT inferred from file content)
 *         → buildAutoModeOverlay (REAL untrusted-source fence)
 *         → withUserRuleOverlay (REAL prompt composer)
 *         → extractWriteEffects (REAL shell write-effect parser)
 *     → evaluateAuto (REAL precheck/note/clear)
 *         → CircumventionTracker (REAL stateful denied-effect memory)
 *
 * The ONLY injected boundary is the classifier *port* (`PermissionContext.
 * classify`) — that is the LLM call, which is necessarily a test double in any
 * deterministic test. Everything between the gate entry and the port is real.
 *
 * THREE PILLARS asserted here:
 *
 *  1. FEATURE WORKS E2E (knob ON):
 *     1a. Untrusted-source fence — a REAL `project`-layer DSL `allow` rule does
 *         NOT reach the classifier prompt (a repo cannot loosen the AFK
 *         boundary); a REAL `user`-layer `allow` DOES. Proven by inspecting the
 *         system prompt the port actually receives.
 *     1b. Tool-switch circumvention — a soft-deny of a `Write` to /repo/X
 *         (recorded through the REAL gate→policy→tracker path) makes a SUBSEQUENT
 *         `bash` redirect to the SAME /repo/X (via a DIFFERENT tool) raise the
 *         advisory circumvention signal, threaded into the prompt the port sees.
 *         The whole round-trip is the real gate; nothing is hand-fed to the
 *         tracker.
 *
 *  2. DEFAULT-OFF BYTE-IDENTITY (both knobs unset):
 *     The system prompt the port receives is BYTE-FOR-BYTE `CLASSIFIER_SYSTEM_
 *     PROMPT` — no overlay slot, no circumvention line — EVEN with a wired
 *     rules store carrying an `allow`/`deny` AND a wired tracker holding a live
 *     prior deny of the same path. No new prompt-drift, no tracker consultation.
 *
 *  3. RED-ON-INJECTION:
 *     3a. Fence: if the overlay stopped dropping an untrusted `project` allow,
 *         the OFF-vs-ON prompt assertions invert (the e2e proves the live drop).
 *     3b. Circumvention: if the tracker stopped matching a same-path-different-
 *         tool write, the threaded-advisory assertion fails.
 *     Both are pinned by the negative-control cases below (a project `allow`
 *     that must NOT appear; a different-path write that must NOT match).
 *
 * Run with the knobs ON inside each ON test, OFF (deleted) inside the OFF test —
 * via the REAL `runtimeConfig()` cache, reset per case.
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

const RULES_KNOB = "QUANTA_AUTO_MODE_RULES"
const CIRC_KNOB = "QUANTA_CIRCUMVENT_DETECT"

let savedRules: string | undefined
let savedCirc: string | undefined

beforeEach(() => {
  savedRules = process.env[RULES_KNOB]
  savedCirc = process.env[CIRC_KNOB]
  // Each test sets the knobs it needs; start from a clean cache + clean default.
  delete process.env[RULES_KNOB]
  delete process.env[CIRC_KNOB]
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (savedRules === undefined) delete process.env[RULES_KNOB]
  else process.env[RULES_KNOB] = savedRules
  if (savedCirc === undefined) delete process.env[CIRC_KNOB]
  else process.env[CIRC_KNOB] = savedCirc
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

/* ----------------------------------------------------------------------- *
 * REAL tools: a bash tool exposing extractShellCommand, and a Write tool.
 * Both are real `Tool` objects in a real `ToolRegistry` — the gate's
 * `withResolvedShellCommand` calls the registry, not a stub.
 * ----------------------------------------------------------------------- */
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

const writeTool = (): Tool => ({
  name: "Write",
  description: "write a file",
  inputSchema: z.object({ path: z.string(), content: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "wrote" } }
  },
})

const registry = (): ToolRegistry => new ToolRegistry([bashTool(), writeTool()])

const cfg = (): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    registry: registry(),
    run: { turn: 5 },
  }) as AgentConfig

/** Recording classifier port — captures every system prompt it receives so we
 *  can assert exactly what the REAL chain composed. Returns a fixed verdict. */
const recordingPort = (verdict: ClassifyDecision["verdict"]) => {
  const prompts: string[] = []
  const port = (req: ClassifyRequest): Promise<ClassifyDecision> => {
    prompts.push(req.systemPrompt)
    return Promise.resolve({ verdict, reason: `${verdict} (mock)` })
  }
  return { port, prompts }
}

const autoPermission = (
  port: (r: ClassifyRequest) => Promise<ClassifyDecision>,
): PermissionContext => ({ mode: "auto", classify: port }) as PermissionContext

const bashCall = (command: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c-bash",
  name: "bash",
  input: { command },
})
const bashAction = (command: string): AdmissibilityAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
})

const writeCall = (path: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c-write",
  name: "Write",
  input: { path, content: "x" },
})
const writeAction = (path: string): AdmissibilityAction => ({
  tool: "Write",
  input: { path, content: "x" },
  isReadOnly: false,
})

/* ======================================================================= *
 * PILLAR 1a — Untrusted-source fence, end-to-end through the REAL store.
 * ======================================================================= */
describe("E2E pillar 1a — untrusted-source fence (real RulesStore → real gate)", () => {
  test("a REAL user-layer `allow` reaches the classifier prompt; a REAL project-layer `allow` is DROPPED", async () => {
    process.env[RULES_KNOB] = "1"
    __resetRuntimeConfig()

    // REAL store: parse REAL DSL text into the user + project layers. The layer
    // provenance is stamped by the REAL parser from the loadLayer() call, NOT
    // inferred from the rule text — this is the security crux.
    const store = new RulesStore()
    store.loadLayer("user", "allow user-trusted-prefix\n", "user.rules")
    store.loadLayer("project", "allow repo-injected-prefix\n", ".quanta/project.rules")

    const { port, prompts } = recordingPort("allow")
    const classifier = new AutoModeClassifier(port)

    const result = await runAdmissibilityGate(
      writeCall("/repo/anything"),
      cfg(),
      autoPermission(port),
      writeAction("/repo/anything"),
      classifier,
      { rulesStore: store },
    )

    expect(prompts.length).toBeGreaterThan(0)
    const seen = prompts[0] ?? ""
    // TRUSTED user `allow` is composed into the overlay → appears in the prompt.
    expect(seen).toContain("user-trusted-prefix")
    // UNTRUSTED (repo-controllable) project `allow` is the security crux: it must
    // NEVER reach the classifier (a repo cannot loosen the AFK boundary). This is
    // the live red-on-injection control — if `buildAutoModeOverlay` stopped
    // dropping a project `allow`, this assertion fails.
    expect(seen).not.toContain("repo-injected-prefix")
    // The action was (mock-)allowed end-to-end ⇒ gate returns null (proceed).
    expect(result).toBeNull()
  })

  test("a REAL project-layer `deny` (TIGHTENING) IS applied as soft_deny", async () => {
    process.env[RULES_KNOB] = "1"
    __resetRuntimeConfig()

    const store = new RulesStore()
    // Project layer may only TIGHTEN — a `deny` is allowed through as soft_deny.
    store.loadLayer("project", "deny repo-tightening-prefix\n", ".quanta/project.rules")

    const { port, prompts } = recordingPort("allow")
    const classifier = new AutoModeClassifier(port)

    await runAdmissibilityGate(
      writeCall("/repo/anything"),
      cfg(),
      autoPermission(port),
      writeAction("/repo/anything"),
      classifier,
      { rulesStore: store },
    )

    expect(prompts.length).toBeGreaterThan(0)
    // A project `deny` TIGHTENS — it is admissible and lands in the prompt.
    expect(prompts[0] ?? "").toContain("repo-tightening-prefix")
  })
})

/* ======================================================================= *
 * PILLAR 1b — Tool-switch circumvention, full round-trip through the gate.
 * The tracker is NEVER hand-fed; the prior soft-deny is recorded by the REAL
 * gate→policy path and the SUBSEQUENT bash redirect matches it live.
 * ======================================================================= */
describe("E2E pillar 1b — circumvention detection (real gate records deny, then catches the tool-switch)", () => {
  test("Write /repo/X soft-denied via the gate, then bash `> /repo/X` raises the advisory through the REAL chain", async () => {
    process.env[CIRC_KNOB] = "1"
    __resetRuntimeConfig()

    const tracker = new CircumventionTracker()

    // STEP 1 — drive the REAL gate for a Write to /repo/X with a classifier that
    // DENIES. evaluateAuto's soft-deny arm calls tracker.noteDenied for us — we
    // do NOT touch the tracker directly. This is the production record path.
    const denyPort = recordingPort("block")
    const denyClassifier = new AutoModeClassifier(denyPort.port)
    const denyResult = await runAdmissibilityGate(
      writeCall("/repo/X"),
      cfg(),
      autoPermission(denyPort.port),
      writeAction("/repo/X"),
      denyClassifier,
      { circumventionTracker: tracker },
    )
    // The Write was soft-denied end-to-end.
    expect(denyResult).not.toBeNull()
    // And the REAL gate recorded the denied write effect (no hand-feeding).
    expect(tracker.size()).toBe(1)

    // STEP 2 — a SUBSEQUENT bash redirect to the SAME canonical path via a
    // DIFFERENT tool. The REAL extractWriteEffects parses `> /repo/X`; the REAL
    // matchCircumvention fires; the advisory is threaded into the prompt.
    const allowPort = recordingPort("allow")
    const allowClassifier = new AutoModeClassifier(allowPort.port)
    const circResult = await runAdmissibilityGate(
      bashCall("echo evil > /repo/X"),
      cfg(),
      autoPermission(allowPort.port),
      bashAction("echo evil > /repo/X"),
      allowClassifier,
      { circumventionTracker: tracker },
    )

    expect(allowPort.prompts.length).toBeGreaterThan(0)
    const seen = allowPort.prompts[0] ?? ""
    // The advisory circumvention taxonomy line WAS threaded (the match fired).
    expect(seen).toContain(CIRCUMVENTION_TAXONOMY_LINE)
    // The advisory names the SAME path and the prior tool (Write) — proving the
    // round-trip carried the real recorded signature, not a generic line.
    expect(seen).toContain("/repo/X")
    expect(seen).toContain("Write")
    // ADVISORY ONLY: the (mock) classifier allowed, so the gate did NOT auto-block.
    expect(circResult).toBeNull()
  })

  test("NEGATIVE control — a bash write to a DIFFERENT path does NOT raise circumvention (red-on-injection guard)", async () => {
    process.env[CIRC_KNOB] = "1"
    __resetRuntimeConfig()

    const tracker = new CircumventionTracker()
    // Soft-deny a Write to /repo/X through the real gate.
    const denyPort = recordingPort("block")
    await runAdmissibilityGate(
      writeCall("/repo/X"),
      cfg(),
      autoPermission(denyPort.port),
      writeAction("/repo/X"),
      new AutoModeClassifier(denyPort.port),
      { circumventionTracker: tracker },
    )

    // bash writes a DIFFERENT path /repo/Y — must NOT match.
    const allowPort = recordingPort("allow")
    await runAdmissibilityGate(
      bashCall("echo ok > /repo/Y"),
      cfg(),
      autoPermission(allowPort.port),
      bashAction("echo ok > /repo/Y"),
      new AutoModeClassifier(allowPort.port),
      { circumventionTracker: tracker },
    )

    const seen = allowPort.prompts[0] ?? ""
    // No same-path match ⇒ the advisory line is absent. If the detector started
    // matching different paths (a false-positive regression), this fails.
    expect(seen).not.toContain(CIRCUMVENTION_TAXONOMY_LINE)
  })
})

/* ======================================================================= *
 * PILLAR 2 — DEFAULT-OFF BYTE-IDENTITY through the REAL chain.
 * Both knobs UNSET. A wired rules store (with an allow) AND a wired tracker
 * (with a live prior deny of the same path) are present but INERT.
 * ======================================================================= */
describe("E2E pillar 2 — default-OFF byte-identity (both knobs unset → byte-for-byte legacy prompt)", () => {
  test("with knobs unset, the classifier sees EXACTLY CLASSIFIER_SYSTEM_PROMPT despite a wired store + tracker", async () => {
    // Knobs left UNSET by beforeEach. runtimeConfig() reads them as off.
    const store = new RulesStore()
    store.loadLayer("user", "allow user-trusted-prefix\n", "user.rules")
    store.loadLayer("project", "allow repo-injected-prefix\n", ".quanta/project.rules")

    const tracker = new CircumventionTracker()
    // A live prior deny that WOULD match the bash write below if the knob were on.
    tracker.noteDenied({ kind: "write", path: "/repo/X" }, "Write", 1)

    const { port, prompts } = recordingPort("allow")
    const classifier = new AutoModeClassifier(port)

    const result = await runAdmissibilityGate(
      bashCall("echo hi > /repo/X"),
      cfg(),
      autoPermission(port),
      bashAction("echo hi > /repo/X"),
      classifier,
      { rulesStore: store, circumventionTracker: tracker },
    )

    expect(prompts.length).toBeGreaterThan(0)
    const seen = prompts[0] ?? ""
    // BYTE-IDENTITY: the prompt is EXACTLY the canonical constant — no overlay
    // slot text, no circumvention line. This is the OFF ratchet: any drift
    // (a new field/method/allocation that leaks into the prompt absent the knob)
    // breaks this equality.
    expect(seen).toBe(CLASSIFIER_SYSTEM_PROMPT)
    // No overlay leak.
    expect(seen).not.toContain("user-trusted-prefix")
    expect(seen).not.toContain("repo-injected-prefix")
    // No circumvention leak — even though the tracker holds a live matching deny.
    expect(seen).not.toContain(CIRCUMVENTION_TAXONOMY_LINE)
    // And the tracker was NEVER consulted (its prior record is untouched: the
    // OFF path neither matches nor clears it).
    expect(tracker.size()).toBe(1)
    expect(result).toBeNull()
  })

  test("RED-ON-INJECTION pin — toggling ON makes the SAME setup diverge (proves the OFF assertion is load-bearing)", async () => {
    // This case proves the byte-identity above is not vacuous: with the knobs
    // FLIPPED ON, the identical store + tracker DO alter the prompt. If the OFF
    // path ever started behaving like this (drift), the equality test above
    // would already have failed; conversely if the ON path stopped composing,
    // this test fails. Together they bracket the gate behavior.
    process.env[RULES_KNOB] = "1"
    process.env[CIRC_KNOB] = "1"
    __resetRuntimeConfig()

    const store = new RulesStore()
    store.loadLayer("user", "allow user-trusted-prefix\n", "user.rules")

    const tracker = new CircumventionTracker()
    tracker.noteDenied({ kind: "write", path: "/repo/X" }, "Write", 1)

    const { port, prompts } = recordingPort("allow")
    const classifier = new AutoModeClassifier(port)

    await runAdmissibilityGate(
      bashCall("echo hi > /repo/X"),
      cfg(),
      autoPermission(port),
      bashAction("echo hi > /repo/X"),
      classifier,
      { rulesStore: store, circumventionTracker: tracker },
    )

    const seen = prompts[0] ?? ""
    // ON: the prompt is NO LONGER the bare constant — both halves composed in.
    expect(seen).not.toBe(CLASSIFIER_SYSTEM_PROMPT)
    expect(seen).toContain("user-trusted-prefix")
    expect(seen).toContain(CIRCUMVENTION_TAXONOMY_LINE)
  })
})
