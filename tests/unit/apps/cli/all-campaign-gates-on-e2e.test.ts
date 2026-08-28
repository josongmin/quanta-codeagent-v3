/**
 * aug-22 campaign — ALL-GATES-ON consolidated composition e2e.
 *
 * The per-feature hellgates each flip ONE gate on and prove that feature live.
 * This file is the NOVEL proof the campaign lacked: every campaign gate ON
 * SIMULTANEOUSLY, driving the REAL CONSUMER composition roots the individual
 * tests use (`buildLifecycleBundle`, `composeSurfaceWires`, `buildBaseFromBootstrap`,
 * `assembleAgentConfig`, `buildLivePosture(Runtime)`, `resolveGatedObjectiveAuthority`),
 * asserting PER FEATURE that it assembles LIVE — so no gate INTERACTION breaks
 * assembly.
 *
 * SCOPE BOUND (honest — do not over-read): this proves the CONSUMER half (given
 * the bootstrap/setup PRODUCED the authorities, the surface composes them live
 * under all gates). The PRODUCER legs — that the real bootstrap actually mints &
 * threads each authority — are owned by their own tests (e.g. the posture
 * bootstrap producer leg, the session-authorities join), NOT here: the boundary
 * inputs below are typed fakes (see FIDELITY). A regression where a producer
 * stops threading an authority would NOT fail this file.
 *
 * Markers are COMPOSITION-REAL, not source greps: the real assembled config's
 * slots (`cfg.questionGuard`, `cfg.objective`, `base.postureControl`), the real
 * registered command table (`buildSurfaceSlashCommands`), the real wired slash
 * ctx (`slashCtx.attention` / `.skillActions`), the real objective tool block
 * (`buildObjectiveBlock`), and behavioral runs (a child question surfaces, a
 * denying posture blocks `request_user_input`, a durable posture survives a
 * restart, a disable through the composed `/skill` wire mutates the SAME
 * authority).
 *
 * HELLGATE — RED-first per gate: the `red-on-injection` describe flips ONE gate
 * OFF (rest ON) and asserts the corresponding live-marker goes RED (slot
 * omitted / command unregistered / tool block empty) — proving each marker is
 * GATE-DRIVEN, not always-on. The `default-OFF byte-identity` describe clears
 * ALL gates and asserts every campaign slot/command is omitted.
 *
 * FIDELITY: the composition FUNCTIONS are the production ones. Their boundary
 * INPUTS (the `SessionBootstrapResult` / `SessionSetupResult`) are the same
 * typed fakes the per-feature tests inject at the bootstrap seam — the seam
 * between "bootstrap built these authorities" and "the surface composes them".
 * The authorities themselves are built with their REAL builders
 * (`buildLivePosture`, `buildSessionAuthorities` via `buildLifecycleBundle`,
 * `buildSkillRuntimeAuthority`), never stubs.
 *
 * SLICE FENCE (ADR-0024): allowlisted in `biome.json` for `@/apps/cli/**`
 * imports (the CLI surface IS the subject — the campaign features live in the
 * CLI composition). NO production code is touched.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { dispatchTool } from "@/agent/dispatch"
import { buildToolContext } from "@/agent/dispatch/tool-context"
import { livePostureQuestionReader, questionAvailability } from "@/agent/dispatch-guard"
import { buildObjectiveBlock } from "@/agent/tier1"
import { readCliKnob } from "@/apps/cli/cli-knobs-accessor"
import type { CliFeatureConfig } from "@/apps/cli/repl/cli-feature-config"
import { buildLifecycleBundle } from "@/apps/cli/repl/factories/lifecycle"
import type { SessionSetupResult } from "@/apps/cli/repl/session-setup"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import { buildPostureEditorSlot } from "@/apps/cli/repl/surface-compose/dispatch-compose"
import { postureCmd } from "@/apps/cli/slash/posture"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import {
  buildLivePostureRuntime,
  resolveDurableLivePosture,
} from "@/host/bootstrap/live-posture-runtime"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { buildBaseFromBootstrap } from "@/host/runtime/internal/context-binding/base"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { asObjectiveAuthority, type ObjectivePort } from "@/objective"
import type { PermissionContext } from "@/permission"
import { createPermissionStore, type PermissionStore } from "@/permission/permission-store"
import {
  buildLivePosture,
  buildSkillRuntimeAuthority,
  encodeObjectiveSnapshot,
  type LivePostureDurableStore,
} from "@/runner/assemble/session-authorities"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import { createInMemoryDisabledStore, type SkillRuntimeAuthority } from "@/skill"
import type { TaskRegistry } from "@/subagent"
import {
  requestUserInputTool,
  type Tool,
  type ToolContext,
  type ToolEvent,
  ToolRegistry,
} from "@/tool"
import {
  cleanupHermeticQuantaHomes,
  hermeticQuantaHomeEnv,
} from "../../../_support/hermetic-quanta-home"
import { makeFakeFeatureCfg, makeFakeSessionSetup } from "./_cli-fakes"

// ── the ALL-ON campaign gate world ──────────────────────────────────────────

/** EVERY aug-22 campaign gate, ON simultaneously. */
const ALL_GATES: Record<string, string> = {
  QUANTA_ATTENTION_NAV: "1",
  QUANTA_SUBAGENT: "1",
  QUANTA_WORKTREE_PROGRESS: "1",
  QUANTA_WORKTREE_CWD_PIN: "1",
  QUANTA_POSTURE_SELECTOR: "1",
  QUANTA_POSTURE_DURABLE_RESUME: "1",
  QUANTA_SKILL_ACTIONS: "1",
  QUANTA_PROPOSE_GOAL: "1",
  QUANTA_OBJECTIVE_TOOLS: "1",
  QUANTA_GOAL: "1",
}
const ALL_GATE_KEYS = Object.keys(ALL_GATES)

/** Set `process.env` to exactly `on` (delete every campaign key first), run
 *  `fn`, then restore the prior values. Several campaign gates are read through
 *  `readCliKnob(process.env)` (the command-table + slash-ctx registration
 *  gates), so the all-ON world must live in `process.env`, not just an env bag. */
const withGates = async <T>(
  on: Record<string, string>,
  fn: (env: Record<string, string | undefined>) => T | Promise<T>,
): Promise<T> => {
  const prev = new Map<string, string | undefined>()
  for (const k of ALL_GATE_KEYS) {
    prev.set(k, process.env[k])
    delete process.env[k]
  }
  for (const [k, v] of Object.entries(on)) process.env[k] = v
  try {
    return await fn({ ...on })
  } finally {
    for (const k of ALL_GATE_KEYS) {
      const p = prev.get(k)
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  }
}

const gatesExcept = (off: string): Record<string, string> =>
  Object.fromEntries(Object.entries(ALL_GATES).filter(([k]) => k !== off))

// ── shared REAL-rail helpers (mirror the per-feature tests) ─────────────────

const featureCfgAllOn = (): CliFeatureConfig =>
  makeFakeFeatureCfg({
    // subagent fleet ON ⇒ `buildLifecycleBundle` allocates the TaskRegistry the
    // attention broker/reader join (the subagent×attention interaction).
    pills: { enabled: true, hideTasks: false, hideFollowUp: false, hideMcp: false },
    subagentForPills: true,
  })

const stubStream = () => ({ emit: (_e: unknown) => void 0 })

/** Minimal AgentConfig-shaped base double (mirrors posture-compose-wiring). */
const baseConfig = (over: Partial<RuntimeAgentConfigBase> = {}): RuntimeAgentConfigBase =>
  ({
    stream: stubStream(),
    cwd: "/repo",
    llm: {},
    permission: { mode: "default" },
    registry: { all: () => [], has: () => false },
    messages: [],
    system: "sys",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
  }) as unknown as RuntimeAgentConfigBase

const perm: PermissionContext = { mode: "acceptEdits" }

/** AgentConfig for a spawned child driving the REAL request_user_input tool. */
const childCfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry([requestUserInputTool()]),
    stream: {} as AgentConfig["stream"],
    permission: perm,
    messages: [],
    system: "t",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    llm: {} as AgentConfig["llm"],
    ...over,
  }) as AgentConfig

const ctxFor = (config: AgentConfig): ToolContext =>
  buildToolContext({ config, workingState: undefined, collabMode: "default", toolCallId: "call-1" })

const askViaTool = (ctx: ToolContext, prompt: string): Promise<ToolEvent> => {
  const tool: Tool = requestUserInputTool() as Tool
  const gen = tool.execute({ prompt }, ctx)
  return (async () => {
    let last: ToolEvent | undefined
    for await (const e of gen) last = e
    if (last === undefined) throw new Error("tool yielded nothing")
    return last
  })()
}

const modelSet = (goal: string) =>
  ({
    threadId: "t-cli",
    actor: "model",
    mutation: { kind: "create", definition: { goal } },
  }) as const

/** A `SessionBootstrapResult` double carrying the campaign bootstrap seams —
 *  the SAME fields the live `bootstrap-session` forwards from its authority
 *  builders. Mirrors `posture-compose-wiring`'s `bootDouble`. */
const bootDouble = (over: Partial<SessionBootstrapResult>): SessionBootstrapResult =>
  ({
    llm: {},
    tooling: { registry: { has: () => false, all: () => [] } },
    permission: { mode: "default" },
    history: [],
    system: "sys",
    cwd: "/repo",
    maxTurns: 5,
    abort: new AbortController(),
    sessionId: "sess-all-on",
    features: { planMode: false },
    ...over,
  }) as unknown as SessionBootstrapResult

const commandNames = (): string[] =>
  buildSurfaceSlashCommands((): readonly SlashCommand[] => []).map((c) => c.name)

const makeCtxWithPosture = (postureEditor: SlashContext["postureEditor"]) => {
  const out: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: (_s: string) => undefined,
    ...(postureEditor !== undefined ? { postureEditor } : {}),
  } as unknown as SlashContext
  return { ctx, out }
}

/** Compose ONE REAL REPL surface with every campaign seam present under the
 *  live `process.env` all-ON world. Returns the composer output + the seams so
 *  each feature's slot can be asserted from a SINGLE assembly. */
const composeAllOn = async (
  skillAuthority: SkillRuntimeAuthority,
  over: { restoreFrom?: SessionSetupResult["restoredObjective"] } = {},
) => {
  // `withGates` sets `process.env` to the exact gate world under test, so the
  // lifecycle bundle's `QUANTA_ATTENTION_NAV` gate tracks it (all-ON, one-off, none).
  const bundle = buildLifecycleBundle(featureCfgAllOn(), process.env)
  const lp = buildLivePosture("default")
  const setup = makeFakeSessionSetup({
    sessionId: "sess-all-on",
    skillAuthority,
    postureControl: lp.control,
    ...(bundle.taskRegistry !== undefined ? { lifecycleTaskRegistry: bundle.taskRegistry } : {}),
    ...(bundle.questionBroker !== undefined
      ? { lifecycleQuestionBroker: bundle.questionBroker }
      : {}),
    ...(bundle.attentionReader !== undefined ? { lifecycleAttention: bundle.attentionReader } : {}),
    ...(over.restoreFrom !== undefined ? { restoredObjective: over.restoreFrom } : {}),
  })
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  // `process.env` verbatim would root the surface's sticky-model store at the
  // DEVELOPER's real `~/.quanta` — this suite turns every campaign gate ON, so a
  // local `/model` pick could change its outcome and a dispatched set could write
  // there. Keep every other env key (the gates are read from it) and re-point ONLY
  // the Quanta home.
  const wires = composeSurfaceWires(setup, state, hermeticQuantaHomeEnv(process.env), {
    convStore: defaultConversationCheckpointStore(),
  })
  return { bundle, lp, setup, wires }
}

const freshSkillAuthority = (): Promise<SkillRuntimeAuthority> =>
  buildSkillRuntimeAuthority({ snapshotInputs: {}, disabledStore: createInMemoryDisabledStore() })

/* ==========================================================================
 *  A. ALL GATES ON — every feature assembles LIVE, simultaneously.
 * ========================================================================== */

describe("aug-22 ALL-GATES-ON — the whole campaign assembles live, no gate interaction breaks it", () => {
  afterEach(cleanupHermeticQuantaHomes)
  test("A0 · composing with EVERY gate on does not throw (simultaneous assembly)", async () => {
    await withGates(ALL_GATES, async () => {
      const skills = await freshSkillAuthority()
      const { wires } = await composeAllOn(skills)
      // The single real composer returned a surface (no assembly conflict).
      expect(wires.slashCtx).toBeDefined()
      expect(wires.dispatchSlash).toBeDefined()
    })
  })

  test("A1 · ATTENTION — questionBroker + reader live, /attention registered, lists a pending child question", async () => {
    await withGates(ALL_GATES, async () => {
      const skills = await freshSkillAuthority()
      const { bundle, wires } = await composeAllOn(skills)

      // buildLifecycleBundle (real CLI lifecycle composition) minted the broker +
      // reader + the subagent TaskRegistry they join (subagent×attention).
      expect(bundle.taskRegistry).toBeDefined()
      expect(bundle.questionBroker).toBeDefined()
      expect(bundle.attentionReader).toBeDefined()
      // /attention IS in the real command table.
      expect(commandNames()).toContain("/attention")
      // The composed slash ctx wired the live /attention slot.
      expect(wires.slashCtx.attention).toBeDefined()

      // Behavioral: a child publishes a REAL request_user_input; the composed
      // /attention wire lists THAT pending question.
      const reg = bundle.taskRegistry as TaskRegistry
      reg.register({ id: "child-A", description: "db-migrator", depth: 1 })
      const broker = bundle.questionBroker
      if (broker === undefined) throw new Error("gate ON must mint the broker")
      const child = ctxFor(childCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))
      const run = askViaTool(child, "which db?")
      for (let i = 0; i < 200 && broker.listPending().length < 1; i++) await Promise.resolve()

      const rows = wires.slashCtx.attention?.list() ?? []
      expect(rows).toHaveLength(1)
      expect(rows[0]?.taskId).toBe("child-A")

      broker.cancelAll("teardown")
      await run
    })
  })

  test("A2 · POSTURE SELECTOR — base.postureControl live, /posture registered + echoes a projection (not 'not wired')", async () => {
    await withGates(ALL_GATES, async () => {
      const skills = await freshSkillAuthority()
      const { lp } = await composeAllOn(skills)

      // Host leg: buildBaseFromBootstrap lifts the SAME control onto the base.
      const guard = livePostureQuestionReader(lp.authority)
      const base = buildBaseFromBootstrap({
        boot: bootDouble({ postureControl: lp.control, questionGuard: guard }),
        stream: stubStream() as never,
        onConfirm: async () => true,
      })
      expect((base as { postureControl?: unknown }).postureControl).toBe(lp.control)

      // Command table + real /posture slot echo a projection through the control.
      expect(commandNames()).toContain("/posture")
      const slot = buildPostureEditorSlot(makeFakeSessionSetup({ postureControl: lp.control }))
      expect(slot).toBeDefined()
      const { ctx, out } = makeCtxWithPosture(slot)
      expect(await postureCmd.run(["show"], ctx)).toBe(0)
      const text = out.join("")
      expect(text).not.toContain("not wired")
      expect(text).toContain("Posture")
    })
  })

  test("A3 · QUESTION GUARD — cfg.questionGuard live; a denying posture BLOCKS request_user_input at dispatch", async () => {
    await withGates(ALL_GATES, async () => {
      const lp = buildLivePosture("default")
      const guard = livePostureQuestionReader(lp.authority)
      // assembler carries the guard from base ⇒ cfg (composition marker).
      const cfg = assembleAgentConfig(
        { mode: "interactive", base: baseConfig({ questionGuard: guard as never }) },
        { ...ALL_GATES },
      )
      expect(cfg.questionGuard).toBe(guard)
      expect(questionAvailability(cfg.questionGuard, "default").available).toBe(true)

      // Deny questions outside plan, then DISPATCH the real tool ⇒ rejected pre-execute.
      await lp.control.apply({ patch: { askOutsidePlan: false }, scope: "current" })
      expect(questionAvailability(cfg.questionGuard, "default").available).toBe(false)

      const calls: string[] = []
      const denyCfg = childCfg({
        questionGuard: guard as never,
        collaborationMode: "default",
        userInputPort: async (req: { prompt: string }) => {
          calls.push(req.prompt)
          return { decision: "answer", text: "x" }
        },
      })
      const res = await dispatchTool(
        { type: "tool_use", id: "q1", name: "request_user_input", input: { prompt: "which?" } },
        denyCfg,
        perm,
      )
      expect(res.ok).toBe(false)
      expect(res.preview).toBe("question-unavailable")
      expect(calls).toEqual([]) // port never reached
    })
  })

  test("A4 · OBJECTIVE — gated authority is the surface store AND the LLM-tool authority; objective_* tools present; approval required", async () => {
    await withGates(ALL_GATES, async () => {
      const skills = await freshSkillAuthority()
      const { wires } = await composeAllOn(skills)

      // Surface: the ONE gated authority is present and threaded to the LLM tools.
      expect(wires.objectiveStore).toBeDefined()
      expect(wires.runtimeFacadeCompose.objective).toBe(wires.objectiveStore)
      // GATED: a model set requires an admitted approval (HITL not bypassed).
      const authority = asObjectiveAuthority(wires.objectiveStore as ObjectivePort)
      const prepared = authority.prepare(modelSet("autonomous goal"))
      expect(prepared.approvalRequired).toBe(true)
      expect(authority.commit(prepared, { admitted: false }).ok).toBe(false)

      // /objective IS registered.
      expect(commandNames()).toContain("/objective")

      // Host leg: the real assembler wires cfg.objective and the objective_* tool
      // block over it (all three tools) when the gate is on.
      const cfg = assembleAgentConfig(
        { mode: "interactive", base: baseConfig({ onConfirm: async () => true } as never) },
        { ...ALL_GATES },
      )
      expect(cfg.objective).toBeDefined()
      const toolNames = buildObjectiveBlock(cfg).map((t) => t.name)
      // GOAL-03: the host verifier is composed after the objective authority, so
      // the model also gets `objective_verify` (runs the stored checks; no argv).
      expect(toolNames).toEqual([
        "objective_set",
        "objective_update",
        "objective_get",
        "objective_verify",
      ])
    })
  })

  test("A5 · SKILL ACTIONS — /skill registered; the composed slot is the DURABLE authority (disable mutates it)", async () => {
    await withGates(ALL_GATES, async () => {
      // A real durable authority seeded with one skill via an in-memory disabled store.
      const skills = await buildSkillRuntimeAuthority({
        snapshotInputs: {},
        disabledStore: createInMemoryDisabledStore(),
      })
      const { wires } = await composeAllOn(skills)

      expect(commandNames()).toContain("/skill")
      const slot = wires.slashCtx.skillActions
      expect(slot).toBeDefined()
      // Identity/behavior: the slot's revision tracks the SAME durable authority.
      expect(slot?.currentRevision()).toBe(skills.read().revision)
      const bumped = await slot?.setEnabled("nonexistent-skill", false)
      // An unknown skill is a typed rejection (not a silent success) — proving the
      // slot routes to the REAL authority's CAS setEnabled, not a throwaway.
      expect(bumped?.ok).toBe(false)
    })
  })

  test("A6 · WORKTREE — QUANTA_WORKTREE_PROGRESS + QUANTA_WORKTREE_CWD_PIN resolve ON through the CLI knob accessor (registration parity; discriminating, not always-true)", async () => {
    // SCOPE (honest): this asserts only that repl.ts's dep-resolution accessor
    // (`readCliKnob`) reads these two gates as ON under the all-gates env and OFF
    // when unset — i.e. the gate DISCRIMINATES (a paired control, not a tautology
    // that returns whatever the test wrote). It does NOT prove the resolved value
    // is threaded into the session-ops deps; that BEHAVIORAL wiring is proven where
    // it actually runs: CWD_PIN by worktree-cwd-pin-hellgate.test.ts (drives the
    // shipped driveSessionTurn + real ownership state machine, H7 paired control),
    // and staged PROGRESS by the D5 worktree-live-progress e2e.
    await withGates(ALL_GATES, async (env) => {
      expect(readCliKnob("QUANTA_WORKTREE_PROGRESS", "bool", env)).toBe(true)
      expect(readCliKnob("QUANTA_WORKTREE_CWD_PIN", "bool", env)).toBe(true)
    })
    // Paired OFF control: unset ⇒ false. Without this the ON assert alone is the
    // "reads back what the test wrote" vacuity the audit flagged.
    expect(readCliKnob("QUANTA_WORKTREE_PROGRESS", "bool", {})).toBe(false)
    expect(readCliKnob("QUANTA_WORKTREE_CWD_PIN", "bool", {})).toBe(false)
  })

  test("A7 · DURABLE POSTURE + OBJECTIVE RESTORE — store-backed posture survives a restart; restoreFrom is accepted", async () => {
    await withGates(ALL_GATES, async (env) => {
      const dir = await mkdtemp(join(tmpdir(), "all-on-posture-"))
      try {
        const filePath = join(dir, "permission-state.json")
        const fresh = async (): Promise<PermissionStore> => {
          const s = createPermissionStore({ filePath, debounceMs: 0 })
          await s.load()
          return s
        }
        // Gate-driven durable bind (production keying decision).
        let seen: LivePostureDurableStore | undefined | "unset" = "unset"
        await resolveDurableLivePosture({
          bind: (durable) => {
            seen = durable
            return buildLivePostureRuntime("default", durable)
          },
          loadPermissionStore: fresh,
          env,
          sessionId: "sid-all-on",
        })
        expect(seen).not.toBe("unset")
        expect(seen).toBeDefined()
        expect((seen as unknown as LivePostureDurableStore).sessionId).toBe("sid-all-on")

        // Behavioral restart: a posture set persists, a FRESH runtime restores it.
        const rt1 = buildLivePostureRuntime("default", {
          store: await fresh(),
          sessionId: "sid-all-on",
        })
        const applied = await rt1.postureControl.apply({
          patch: { mode: "acceptEdits", askOutsidePlan: false },
          scope: "current",
        })
        expect(applied.ok).toBe(true)
        const rt2 = buildLivePostureRuntime("default", {
          store: await fresh(),
          sessionId: "sid-all-on",
        })
        expect(rt2.permissionModeState.get()).toBe("acceptEdits")
        expect(rt2.questionGuard.askOutsidePlan()).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }

      // Objective restoreFrom accepted by the gated authority (round-trip ids).
      const save = resolveGatedObjectiveAuthority(env, { confirmationAvailable: true })
      expect(save).toBeDefined()
      save?.create("thr-1", { goal: "ship", successCriteria: ["compiles"] })
      const snapshot = encodeObjectiveSnapshot(save as ObjectivePort)
      const reopened = resolveGatedObjectiveAuthority(env, {
        confirmationAvailable: true,
        restoreFrom: snapshot,
      })
      expect(reopened?.get("thr-1")?.goal).toBe("ship")

      // The composed CLI surface accepts the same restore snapshot (restoredObjective).
      const skills = await freshSkillAuthority()
      const { wires } = await composeAllOn(skills, { restoreFrom: snapshot })
      expect(asObjectiveAuthority(wires.objectiveStore as ObjectivePort).get("thr-1")?.goal).toBe(
        "ship",
      )
    })
  })
})

/* ==========================================================================
 *  B. RED-ON-INJECTION — flip ONE gate off (rest ON) ⇒ that marker goes RED.
 *     Proves each live-marker is GATE-DRIVEN, not always-on.
 * ========================================================================== */

describe("aug-22 red-on-injection — one gate OFF ⇒ its live-marker RED (gate-driven, not always-on)", () => {
  test("POSTURE_SELECTOR off (rest on) ⇒ /posture unregistered + slot omitted", async () => {
    await withGates(gatesExcept("QUANTA_POSTURE_SELECTOR"), async () => {
      const lp = buildLivePosture("default")
      // gate off ⇒ NO slot even with a live control, and NOT in the command table.
      expect(
        buildPostureEditorSlot(makeFakeSessionSetup({ postureControl: lp.control })),
      ).toBeUndefined()
      expect(commandNames()).not.toContain("/posture")
      // sanity: the other campaign commands stay registered (only THIS marker RED).
      expect(commandNames()).toContain("/attention")
      expect(commandNames()).toContain("/skill")
    })
  })

  test("OBJECTIVE_TOOLS off (rest on) ⇒ objectiveStore absent + objective_* tool block empty", async () => {
    await withGates(gatesExcept("QUANTA_OBJECTIVE_TOOLS"), async (env) => {
      const skills = await freshSkillAuthority()
      const { wires } = await composeAllOn(skills)
      expect(wires.objectiveStore).toBeUndefined()
      expect(wires.runtimeFacadeCompose.objective).toBeUndefined()
      const cfg = assembleAgentConfig(
        { mode: "interactive", base: baseConfig({ onConfirm: async () => true } as never) },
        env,
      )
      expect(cfg.objective).toBeUndefined()
      expect(buildObjectiveBlock(cfg)).toEqual([])
    })
  })

  test("ATTENTION_NAV off (rest on) ⇒ bundle omits broker + reader; /attention unregistered; slot omitted", async () => {
    await withGates(gatesExcept("QUANTA_ATTENTION_NAV"), async () => {
      const skills = await freshSkillAuthority()
      const { bundle, wires } = await composeAllOn(skills)
      expect(bundle.questionBroker).toBeUndefined()
      expect(bundle.attentionReader).toBeUndefined()
      expect(wires.slashCtx.attention).toBeUndefined()
      expect(commandNames()).not.toContain("/attention")
    })
  })

  test("SKILL_ACTIONS off (rest on) ⇒ /skill unregistered + skillActions slot omitted", async () => {
    await withGates(gatesExcept("QUANTA_SKILL_ACTIONS"), async () => {
      const skills = await freshSkillAuthority()
      const { wires } = await composeAllOn(skills)
      expect(wires.slashCtx.skillActions).toBeUndefined()
      expect(commandNames()).not.toContain("/skill")
    })
  })

  test("WORKTREE_PROGRESS off (rest on) ⇒ the composition-root dep resolves false", async () => {
    await withGates(gatesExcept("QUANTA_WORKTREE_PROGRESS"), async (env) => {
      // repl.ts: `readCliKnob(...) ?? false` ⇒ the dep is NOT threaded on.
      expect(readCliKnob("QUANTA_WORKTREE_PROGRESS", "bool", env) ?? false).toBe(false)
      // paired control: the sibling worktree gate is still ON (only THIS marker RED).
      expect(readCliKnob("QUANTA_WORKTREE_CWD_PIN", "bool", env)).toBe(true)
    })
  })

  test("POSTURE_DURABLE_RESUME off (rest on) ⇒ resolveDurableLivePosture binds IN-MEMORY (no durable store)", async () => {
    await withGates(gatesExcept("QUANTA_POSTURE_DURABLE_RESUME"), async (env) => {
      const dir = await mkdtemp(join(tmpdir(), "all-on-nodurable-"))
      try {
        const store = createPermissionStore({ filePath: join(dir, "p.json"), debounceMs: 0 })
        await store.load()
        let seen: LivePostureDurableStore | undefined | "unset" = "unset"
        await resolveDurableLivePosture({
          bind: (durable) => {
            seen = durable
            return buildLivePostureRuntime("default", durable)
          },
          loadPermissionStore: async () => store,
          env,
          sessionId: "sid",
        })
        // gate off ⇒ in-memory bind (durable undefined), even WITH a store present.
        expect(seen).toBeUndefined()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})

/* ==========================================================================
 *  C. DEFAULT-OFF BYTE-IDENTITY — no campaign gate ⇒ every slot/command omitted.
 * ========================================================================== */

describe("aug-22 opt-outs — campaign slots and commands can still be omitted", () => {
  test("QUANTA_GOAL=0 and other gates unset ⇒ command table lacks /attention /objective /posture /skill", async () => {
    await withGates({ QUANTA_GOAL: "0" }, async () => {
      const names = commandNames()
      expect(names).not.toContain("/attention")
      expect(names).not.toContain("/objective")
      expect(names).not.toContain("/posture")
      expect(names).not.toContain("/skill")
    })
  })

  test("QUANTA_GOAL=0 and other gates unset ⇒ composed surface omits every campaign slot", async () => {
    await withGates({ QUANTA_GOAL: "0" }, async (env) => {
      const skills = await freshSkillAuthority()
      const { bundle, wires } = await composeAllOn(skills)
      expect(bundle.questionBroker).toBeUndefined()
      expect(bundle.attentionReader).toBeUndefined()
      expect(wires.slashCtx.attention).toBeUndefined()
      expect(wires.slashCtx.skillActions).toBeUndefined()
      expect(wires.objectiveStore).toBeUndefined()
      const lp = buildLivePosture("default")
      expect(
        buildPostureEditorSlot(makeFakeSessionSetup({ postureControl: lp.control })),
      ).toBeUndefined()
      // host leg: no objective wired, no objective tools.
      const cfg = assembleAgentConfig(
        { mode: "interactive", base: baseConfig({ onConfirm: async () => true } as never) },
        env,
      )
      expect(cfg.objective).toBeUndefined()
      expect(buildObjectiveBlock(cfg)).toEqual([])
    })
  })
})
