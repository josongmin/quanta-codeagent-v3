/**
 * RFC-05 E5 — question availability at SPEC and DISPATCH (hellgate).
 *
 * Adversarial pins for the one-reader-two-sites contract:
 *
 *  1. STALE HANDLE (the RED rail): obtain a real `request_user_input` handle,
 *     bind a posture that DENIES questions, then dispatch it. The pre-dispatch
 *     consult must REJECT it BEFORE execute — the wired `userInputPort` is never
 *     called. Red-on-injection: without the consult (the pre-E5 path) the stale
 *     handle dispatches and the port fires → this test is RED.
 *  2. SPEC/DISPATCH PARITY TABLE: across the (askOutsidePlan × turnMode) matrix,
 *     the model-spec projection (E5b: the tool present in `registry.specs()` via
 *     its per-request `getSpec`) and the dispatch admission
 *     (`consultQuestionAvailability` null?) must AGREE cell-for-cell — they cannot
 *     diverge because they resolve through the SAME reader.
 *
 *  E5b (spec-staleness close): the model spec is LIVE per request via the tool's
 *  `getSpec` arm, not FROZEN at session build. The tool is now ALWAYS registered
 *  when a producer is wired; the live posture decides visibility per `specs()`
 *  read — closing both the false-visible (admit-then-deny) and the far worse
 *  false-INVISIBLE (a session that STARTS denying is hidden permanently) gaps.
 *  3. UNKNOWN plan-mode context ⇒ RESTRICTIVE (fail-safe deny), never permissive.
 *  4. GATE-OFF byte-identity: no `questionGuard` bound ⇒ tool present in spec AND
 *     dispatched (current-behavior default: question available).
 *  5. The `@/tool` slice never imports `@/permission` (duck-typed guard only).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { consultQuestionAvailability } from "@/agent/dispatch/preflight-consults"
import type { QuestionAvailabilityReader } from "@/agent/dispatch-guard"
import {
  livePostureQuestionReader,
  questionAvailability,
  turnModeFromCollab,
} from "@/agent/dispatch-guard"
import { buildUserInputBlock } from "@/agent/tier1"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { createPostureAuthority } from "@/permission/posture/authority"
import type { PosturePersistedRecord, PosturePersistencePort } from "@/permission/posture/ports"
import {
  ALL_QUESTION_DENY_REASONS,
  canRequestUserInput,
} from "@/permission/posture/question-policy"
import { requestUserInputTool, type Tool, ToolRegistry, type UserInputOutcome } from "@/tool"

const REQUEST_USER_INPUT = "request_user_input"

/** A reader over a FIXED askOutsidePlan (the live authority is exercised in the
 *  wiring test below; here we vary the knob directly). */
const reader = (askOutsidePlan: boolean): QuestionAvailabilityReader => ({
  askOutsidePlan: () => askOutsidePlan,
})

const perm: PermissionContext = { mode: "acceptEdits" }

const uiCall = (id = "q1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: REQUEST_USER_INPUT,
  input: { prompt: "which branch?" },
})

/** Config that registers the REAL `request_user_input` tool + a recording
 *  `userInputPort`, so a call that reaches execute is OBSERVABLE. */
const cfg = (over: Partial<AgentConfig>, calls: string[]): AgentConfig =>
  ({
    registry: new ToolRegistry([requestUserInputTool()]),
    cwd: "/tmp",
    signal: new AbortController().signal,
    permission: perm,
    userInputPort: async (req: { prompt: string }): Promise<UserInputOutcome> => {
      calls.push(req.prompt)
      return { decision: "answer", text: "main" }
    },
    ...over,
  }) as AgentConfig

describe("E5 — the drift-guard invariants", () => {
  test("ALL_QUESTION_DENY_REASONS matches the union (drift-guard)", () => {
    // The source `satisfies ReadonlyArray<QuestionDenyReason>` pins the tuple ⊆
    // union at compile time; this runtime check pins the reverse (no reason
    // dropped). Widen to string[] so the literal comparison typechecks.
    const reasons: readonly string[] = ALL_QUESTION_DENY_REASONS
    expect([...reasons].sort()).toEqual(["outside_plan_disabled", "unknown_turn_mode"].sort())
  })

  test("the tool-name constant tracks the real tool (no drift)", () => {
    expect(requestUserInputTool().name).toBe(REQUEST_USER_INPUT)
  })
})

describe("E5 RED rail — stale handle cannot bypass a posture that denies", () => {
  test("deny posture + outside plan ⇒ dispatch REJECTED before execute (port never called)", async () => {
    const calls: string[] = []
    // askOutsidePlan=false + collaborationMode default (outside plan) ⇒ DENY.
    const config = cfg({ questionGuard: reader(false), collaborationMode: "default" }, calls)
    const res = await dispatchTool(uiCall(), config, perm)
    // GREEN contract: the stale handle is rejected pre-dispatch.
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("question-unavailable")
    // The port was NEVER reached — execution did not happen.
    expect(calls).toEqual([])
  })

  test("admitted posture ⇒ dispatch runs (port called) — non-vacuous control", async () => {
    const calls: string[] = []
    const config = cfg({ questionGuard: reader(true), collaborationMode: "default" }, calls)
    const res = await dispatchTool(uiCall(), config, perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("main")
    expect(calls).toEqual(["which branch?"])
  })

  test("deny knob but IN PLAN mode ⇒ dispatch runs (plan always allows the ask tool)", async () => {
    const calls: string[] = []
    const config = cfg({ questionGuard: reader(false), collaborationMode: "plan" }, calls)
    const res = await dispatchTool(uiCall(), config, perm)
    expect(res.ok).toBe(true)
    expect(calls).toEqual(["which branch?"])
  })
})

describe("E5 — spec/dispatch PARITY table (one reader, both sites)", () => {
  type Cell = {
    askOutsidePlan: boolean
    collab: "plan" | "default"
    expectAvailable: boolean
  }
  const table: readonly Cell[] = [
    { askOutsidePlan: true, collab: "plan", expectAvailable: true },
    { askOutsidePlan: true, collab: "default", expectAvailable: true },
    { askOutsidePlan: false, collab: "plan", expectAvailable: true },
    { askOutsidePlan: false, collab: "default", expectAvailable: false },
  ]

  for (const c of table) {
    test(`askOutsidePlan=${c.askOutsidePlan} collab=${c.collab} ⇒ spec==dispatch==${c.expectAvailable}`, () => {
      const calls: string[] = []
      const config = cfg(
        { questionGuard: reader(c.askOutsidePlan), collaborationMode: c.collab },
        calls,
      )
      // (a) model-spec projection — E5b: PER REQUEST via getSpec, not registration.
      //     The block ALWAYS registers the tool when a producer is wired; the
      //     live posture decides whether it appears in `registry.specs()`.
      const tool = buildUserInputBlock(config)
      expect(tool).not.toBeUndefined()
      const specVisible = new ToolRegistry([tool as Tool])
        .specs()
        .some((s) => s.name === REQUEST_USER_INPUT)
      // (b) pre-dispatch admission: does the consult admit (null)?
      const dispatchAdmitted = consultQuestionAvailability(uiCall(), config) === null
      // PARITY: the two sites agree cell-for-cell (ONE reader drives both).
      expect(specVisible).toBe(dispatchAdmitted)
      // …and both match the expected availability.
      expect(specVisible).toBe(c.expectAvailable)
    })
  }
})

/** A reader whose `askOutsidePlan` can be flipped AFTER the tool is built, to
 *  prove the model-spec projection tracks the LIVE posture per request (not a
 *  build-time snapshot). */
const mutableReader = (
  initial: boolean,
): { reader: QuestionAvailabilityReader; set: (v: boolean) => void } => {
  let v = initial
  return { reader: { askOutsidePlan: () => v }, set: (n) => (v = n) }
}

const specHas = (registry: ToolRegistry): boolean =>
  registry.specs().some((s) => s.name === REQUEST_USER_INPUT)

describe("E5b — the model spec is LIVE per request (getSpec), not FROZEN at build", () => {
  test("RED→GREEN false-visible: a posture flip to DENY hides the tool WITHOUT a rebuild", () => {
    const calls: string[] = []
    const m = mutableReader(true) // admits at build
    const config = cfg({ questionGuard: m.reader, collaborationMode: "default" }, calls)
    const tool = buildUserInputBlock(config)
    expect(tool).not.toBeUndefined()
    // The registry is built ONCE (session build); specs() is re-read per request.
    const registry = new ToolRegistry([tool as Tool])
    expect(specHas(registry)).toBe(true) // admitting ⇒ visible
    m.set(false) // LIVE posture flips to deny — NO rebuild
    // Pre-E5b (no getSpec) the spec was frozen ⇒ still visible (RED). E5b ⇒ hidden.
    expect(specHas(registry)).toBe(false)
  })

  test("RED→GREEN false-INVISIBLE: a session that STARTS denying reappears when the posture later admits (no rebuild)", () => {
    const calls: string[] = []
    const m = mutableReader(false) // DENIES at build (outside plan)
    const config = cfg({ questionGuard: m.reader, collaborationMode: "default" }, calls)
    const tool = buildUserInputBlock(config)
    // E5b: REGISTERED despite the denying start. Pre-E5b `buildUserInputBlock`
    // returned `undefined` here → the tool was hidden PERMANENTLY (this assert RED).
    expect(tool).not.toBeUndefined()
    const registry = new ToolRegistry([tool as Tool])
    expect(specHas(registry)).toBe(false) // denying start ⇒ hidden this request
    m.set(true) // operator later admits questions — NO rebuild
    expect(specHas(registry)).toBe(true) // same registry ⇒ tool REAPPEARS live
  })

  test("the collab-mode leg is ALSO live: outside-plan DENY hidden, a later PLAN turn reveals it", () => {
    const calls: string[] = []
    // Deny knob + outside plan ⇒ hidden; the mode is the OTHER live input.
    const config = cfg({ questionGuard: reader(false), collaborationMode: "default" }, calls)
    const tool = buildUserInputBlock(config)
    expect(tool).not.toBeUndefined()
    const registry = new ToolRegistry([tool as Tool])
    expect(specHas(registry)).toBe(false)
    // The turn transitions INTO plan mode (live). getSpec re-reads
    // resolveCollaborationMode(config), so a mid-session mode flip is honored.
    ;(config as { collaborationMode?: string }).collaborationMode = "plan"
    expect(specHas(registry)).toBe(true) // plan always admits the ask tool
  })

  test("red-on-injection: DROP the getSpec arm (static tool) ⇒ the spec goes STALE — always visible under DENY", () => {
    // A tool built WITHOUT the availability arm has NO getSpec → static spec →
    // ALWAYS present, so it can never track a denying posture (the pre-E5b bug).
    const staticTool = requestUserInputTool()
    expect(staticTool.getSpec).toBeUndefined()
    expect(specHas(new ToolRegistry([staticTool]))).toBe(true)
    // The SAME tool WITH a denying availability arm IS hidden — proving the arm
    // (not anything else) is what drives the live hide.
    const guarded = requestUserInputTool({ available: () => false })
    expect(specHas(new ToolRegistry([guarded]))).toBe(false)
  })

  test("default-OFF byte-identity: no questionGuard ⇒ NO getSpec + spec bytes identical to the static tool", () => {
    const calls: string[] = []
    // No questionGuard bound — the default-OFF surface.
    const offTool = buildUserInputBlock(cfg({ collaborationMode: "default" }, calls))
    expect(offTool).not.toBeUndefined()
    expect((offTool as Tool).getSpec).toBeUndefined() // no dynamic arm at all
    const offSpec = JSON.stringify(new ToolRegistry([offTool as Tool]).specs())
    const staticSpec = JSON.stringify(new ToolRegistry([requestUserInputTool()]).specs())
    expect(offSpec).toBe(staticSpec) // byte-identical prompt-cache surface
  })

  test("byte-identity under ADMIT: the getSpec spec equals the static spec byte-for-byte (only visibility differs)", () => {
    // When the guard ADMITS, the dynamic spec must not perturb bytes/ordering.
    const admitSpec = JSON.stringify(
      new ToolRegistry([requestUserInputTool({ available: () => true })]).specs(),
    )
    const staticSpec = JSON.stringify(new ToolRegistry([requestUserInputTool()]).specs())
    expect(admitSpec).toBe(staticSpec)
  })
})

describe("E5 — unknown plan-mode context resolves RESTRICTIVE (fail-safe deny)", () => {
  test("policy: unknown turnMode + askOutsidePlan=false ⇒ denied unknown_turn_mode", () => {
    const r = canRequestUserInput({ askOutsidePlan: false, turnMode: undefined })
    expect(r).toEqual({ available: false, reason: "unknown_turn_mode" })
  })

  test("policy: unknown turnMode + askOutsidePlan=true ⇒ available (explicit operator grant)", () => {
    expect(canRequestUserInput({ askOutsidePlan: true, turnMode: undefined })).toEqual({
      available: true,
    })
  })

  test("policy: known outside_plan + askOutsidePlan=false ⇒ outside_plan_disabled (distinct reason)", () => {
    expect(canRequestUserInput({ askOutsidePlan: false, turnMode: "outside_plan" })).toEqual({
      available: false,
      reason: "outside_plan_disabled",
    })
  })

  test("guard: unresolved collaboration mode maps to unknown ⇒ restrictive deny", () => {
    expect(turnModeFromCollab(undefined)).toBeUndefined()
    // The agent bridge with an unknown mode + deny knob fails safe:
    expect(questionAvailability(reader(false), undefined)).toEqual({
      available: false,
      reason: "unknown_turn_mode",
    })
    // …but an explicit askOutsidePlan grant still stands even when mode is unknown.
    expect(questionAvailability(reader(true), undefined)).toEqual({ available: true })
  })
})

describe("E5 — GATE-OFF byte-identity (no reader bound ⇒ available by default)", () => {
  test("no questionGuard ⇒ tool in spec AND dispatch admitted (both sites)", async () => {
    const calls: string[] = []
    // No questionGuard, collaborationMode default (would deny IF a false reader
    // were bound) — proves absence defaults to AVAILABLE, not restrictive.
    const config = cfg({ collaborationMode: "default" }, calls)
    expect(buildUserInputBlock(config)).not.toBeUndefined()
    expect(consultQuestionAvailability(uiCall(), config)).toBeNull()
    const res = await dispatchTool(uiCall(), config, perm)
    expect(res.ok).toBe(true)
    expect(calls).toEqual(["which branch?"])
  })
})

const inMemoryPersistence = (): PosturePersistencePort => {
  const store = new Map<string, PosturePersistedRecord>()
  return {
    readRequested: (id) => store.get(id),
    writeRequested: async (id, rec) => {
      store.set(id, rec)
    },
  }
}

describe("E5 — reader binds the LIVE posture (not a build-time snapshot)", () => {
  test("livePostureQuestionReader re-reads askOutsidePlan after a posture mutation", async () => {
    const authority = createPostureAuthority({
      threadId: "t",
      persistence: inMemoryPersistence(),
      reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
    })
    const reader2 = livePostureQuestionReader(authority)
    // Fresh authority ⇒ current-behavior default askOutsidePlan=true ⇒ available.
    expect(reader2.askOutsidePlan()).toBe(true)
    expect(canRequestUserInput({ askOutsidePlan: reader2.askOutsidePlan() })).toEqual({
      available: true,
    })
    // Mutate the bound posture to DENY questions.
    const res = await authority.set({ askOutsidePlan: false }, authority.read().revision)
    expect(res.ok).toBe(true)
    // The SAME reader now reflects the new live value (proves not a snapshot).
    expect(reader2.askOutsidePlan()).toBe(false)
    expect(canRequestUserInput({ askOutsidePlan: reader2.askOutsidePlan() })).toEqual({
      available: false,
      reason: "unknown_turn_mode",
    })
  })
})

describe("E5 — mode transition: a handle valid IN plan is rejected AFTER leaving plan", () => {
  test("spec built in plan (visible) ⇒ dispatch outside plan (deny knob) REJECTS the stale handle", async () => {
    const calls: string[] = []
    // askOutsidePlan=false. At session start the turn was in PLAN mode:
    const planCfg = cfg({ questionGuard: reader(false), collaborationMode: "plan" }, calls)
    // …so the model-spec projection INCLUDED the tool (the model has a handle):
    expect(buildUserInputBlock(planCfg)).not.toBeUndefined()
    // A later turn transitions OUT of plan mode; the cached handle is now stale.
    const outsideCfg = cfg({ questionGuard: reader(false), collaborationMode: "default" }, calls)
    const res = await dispatchTool(uiCall(), outsideCfg, perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("question-unavailable")
    expect(calls).toEqual([])
  })
})

describe("E5 — the tool slice never imports @/permission (duck-typed guard only)", () => {
  test("request_user_input.ts has no @/permission import", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "tool", "request-user-input.ts"),
      "utf8",
    )
    expect(src.includes("@/permission")).toBe(false)
  })
})
