/**
 * RFC-05 E4/E5 — posture front-door + question-guard COMPOSITION-ROOT wiring
 * hellgate (audit findings H2 / H3 / M1).
 *
 * The E4 control (`buildLivePosture`) and the E5 question guard were BUILT and
 * unit-tested in isolation, but had ZERO production callers: the bootstrap wired
 * only the mode-only `buildLivePermissionModeState`, so `base.postureControl` was
 * never set (⇒ `/posture` = "not wired", host `session.posture.set` silently
 * dropped sandbox/askOutsidePlan, `describe()` echoed no posture) and
 * `AgentConfig.questionGuard` was never assigned (⇒ the guard subtracted nothing).
 * The isolated unit tests passed because they INJECTED the seam by hand.
 *
 * This file closes that gap by driving the REAL composition seams end to end —
 * NOT a hand-injected control:
 *   • `buildLivePosture` (the ONE bootstrap seam) → one authority, three views.
 *   • `buildBaseFromBootstrap` (the REAL host base builder) → lifts
 *     `boot.postureControl`/`boot.questionGuard` onto the base.
 *   • `assembleAgentConfig` (the REAL per-turn assembler) → base → cfg.questionGuard.
 *   • the REAL SessionHost (`setPosture` / `describe`) over that base.
 *   • the REAL CLI compose slot (`buildPostureEditorSlot`) + the REAL `/posture`
 *     command.
 *   • the REAL dispatch predicate (`questionAvailability`).
 *
 * RED-on-injection (proven by in-tree revert):
 *   - drop `whenDefined("postureControl", …)` in context-binding/base.ts ⇒ §3/§4
 *     go RED (host echoes no posture, mode-only fallback drops the full patch).
 *   - drop `whenDefined("questionGuard", …)` ⇒ §5 goes RED (cfg.questionGuard
 *     undefined ⇒ ask-deny no longer blocks).
 *   - revert the M1 retry loop in `createPermissionModeAdapter` ⇒ §6 goes RED
 *     (the racing mode-cycle write is silently lost).
 *   - drop the `postureEditor` slot in dispatch-compose ⇒ §2 goes RED
 *     (`/posture show` prints "not wired").
 */
import { describe, expect, test } from "bun:test"
import { livePostureQuestionReader, questionAvailability } from "@/agent/dispatch-guard"
import type { SessionSetupResult } from "@/apps/cli/repl/session-setup"
import { buildPostureEditorSlot } from "@/apps/cli/repl/surface-compose/dispatch-compose"
import { postureCmd } from "@/apps/cli/slash/posture"
import type { SlashContext } from "@/apps/cli/slash-contract"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import { buildBaseFromBootstrap } from "@/host/runtime/internal/context-binding/base"
import type { PostureProjectionView } from "@/protocol/session"
import { buildLivePosture } from "@/runner/assemble/session-authorities"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

// ── shared helpers ─────────────────────────────────────────────────────────

const stubStream = () => ({ emit: (_e: unknown) => void 0 })

/** Minimal AgentConfig-shaped base double (mirrors goal-compose test) — the
 *  posture/question seams read only stream/cwd/llm/permission/registry/messages. */
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0))
}

const makeCtx = (postureEditor: SlashContext["postureEditor"]) => {
  const out: string[] = []
  const err: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    ...(postureEditor !== undefined ? { postureEditor } : {}),
  } as unknown as SlashContext
  return { ctx, out, err }
}

/* ================================================================== */
/*  1. buildLivePosture surfaces the ONE authority (H3 prerequisite)  */
/* ================================================================== */

describe("buildLivePosture · one authority, three views (H3 prerequisite)", () => {
  test("HELL-POS-authority-surfaced: `.authority` is present so the E5 reader can be built", () => {
    const lp = buildLivePosture("default")
    // The dead wire returned only { modeState, control } — the reader had no
    // authority to adapt. The fix surfaces it.
    expect(lp.authority).toBeDefined()
    expect(typeof lp.authority.read).toBe("function")
  })

  test("HELL-POS-one-authority: control, modeState and the E5 reader all read the SAME live authority", async () => {
    const lp = buildLivePosture("default")
    const reader = livePostureQuestionReader(lp.authority)
    // default seed: askOutsidePlan true, mode default
    expect(reader.askOutsidePlan()).toBe(true)
    expect(lp.modeState.get()).toBe("default")

    // a control mutation (the E4 front door) is observed on BOTH the mode adapter
    // (gate seam) AND the reader — proving one authority, not three cells.
    await lp.control.apply({
      patch: { mode: "acceptEdits", askOutsidePlan: false },
      scope: "current",
    })
    expect(lp.modeState.get()).toBe("acceptEdits")
    expect(reader.askOutsidePlan()).toBe(false)
    expect(lp.authority.read().effective.effectiveMode).toBe("acceptEdits")
  })
})

/* ================================================================== */
/*  2. dispatch-compose · the REAL `/posture` slot + command (H2)      */
/* ================================================================== */

describe("dispatch-compose · buildPostureEditorSlot + /posture command (H2)", () => {
  const setupWith = (control: ReturnType<typeof buildLivePosture>["control"] | undefined) =>
    ({
      ...(control !== undefined ? { postureControl: control } : {}),
    }) as unknown as SessionSetupResult

  test("HELL-POS-slot-gate-off: QUANTA_POSTURE_SELECTOR unset ⇒ NO slot ⇒ /posture prints 'not wired' (default-OFF byte-identical)", async () => {
    const prev = process.env.QUANTA_POSTURE_SELECTOR
    delete process.env.QUANTA_POSTURE_SELECTOR
    try {
      const lp = buildLivePosture("default")
      const slot = buildPostureEditorSlot(setupWith(lp.control))
      expect(slot).toBeUndefined() // gate off ⇒ omitted even with a live control
      const { ctx, out } = makeCtx(undefined)
      const code = await postureCmd.run([], ctx)
      expect(code).toBe(0)
      expect(out.join("")).toContain("not wired")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_POSTURE_SELECTOR
      else process.env.QUANTA_POSTURE_SELECTOR = prev
    }
  })

  test("HELL-POS-slot-live: gate ON + wired control ⇒ /posture show echoes a REAL projection (NOT 'not wired')", async () => {
    const prev = process.env.QUANTA_POSTURE_SELECTOR
    process.env.QUANTA_POSTURE_SELECTOR = "1"
    try {
      const lp = buildLivePosture("default")
      const slot = buildPostureEditorSlot(setupWith(lp.control))
      expect(slot).toBeDefined()
      const { ctx, out } = makeCtx(slot)
      const code = await postureCmd.run(["show"], ctx)
      expect(code).toBe(0)
      const text = out.join("")
      expect(text).not.toContain("not wired")
      expect(text).toContain("Posture")
      expect(text).toContain("rev 0")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_POSTURE_SELECTOR
      else process.env.QUANTA_POSTURE_SELECTOR = prev
    }
  })

  test("HELL-POS-slot-full-patch: a /posture set applies the FULL patch through the SHARED control (next-turn gate reads it)", async () => {
    const prev = process.env.QUANTA_POSTURE_SELECTOR
    process.env.QUANTA_POSTURE_SELECTOR = "1"
    try {
      const lp = buildLivePosture("default")
      const slot = buildPostureEditorSlot(setupWith(lp.control))
      const { ctx } = makeCtx(slot)
      const code = await postureCmd.run(["mode", "acceptEdits"], ctx)
      expect(code).toBe(0)
      // the SAME authority's mode adapter (the gate seam) now reads the new mode
      expect(lp.modeState.get()).toBe("acceptEdits")
      expect(lp.control.describe().revision).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.QUANTA_POSTURE_SELECTOR
      else process.env.QUANTA_POSTURE_SELECTOR = prev
    }
  })

  test("HELL-POS-slot-null-control-control: NO control on setup ⇒ slot omitted even with gate ON (paired control)", () => {
    const prev = process.env.QUANTA_POSTURE_SELECTOR
    process.env.QUANTA_POSTURE_SELECTOR = "1"
    try {
      expect(buildPostureEditorSlot(setupWith(undefined))).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.QUANTA_POSTURE_SELECTOR
      else process.env.QUANTA_POSTURE_SELECTOR = prev
    }
  })
})

/* ================================================================== */
/*  3. bootstrap → base leg (REAL buildBaseFromBootstrap)              */
/* ================================================================== */

describe("buildBaseFromBootstrap · boot.postureControl/questionGuard ⇒ base (bootstrap→base)", () => {
  // The REAL host base builder. A minimal boot double carries the SAME fields the
  // live bootstrap sets from `buildLivePosture`; the whenDefined lines under test
  // copy them onto the base.
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
      sessionId: "sess-posture",
      features: { planMode: false },
      ...over,
    }) as unknown as SessionBootstrapResult

  const onConfirm = async () => true

  test("HELL-POS-boot-to-base: buildBaseFromBootstrap lifts BOTH the control and the guard onto the base (SAME instances)", () => {
    const lp = buildLivePosture("default")
    const guard = livePostureQuestionReader(lp.authority)
    const base = buildBaseFromBootstrap({
      boot: bootDouble({ postureControl: lp.control, questionGuard: guard }),
      stream: stubStream() as never,
      onConfirm,
    })
    // identity — NOT deep-equal: the host + gate must share the ONE live authority.
    expect((base as { postureControl?: unknown }).postureControl).toBe(lp.control)
    expect((base as { questionGuard?: unknown }).questionGuard).toBe(guard)
  })

  test("HELL-POS-boot-to-base-absent-control: a boot WITHOUT the fields ⇒ base omits them (whenDefined, byte-identical default)", () => {
    const base = buildBaseFromBootstrap({
      boot: bootDouble({}),
      stream: stubStream() as never,
      onConfirm,
    })
    expect(Object.hasOwn(base as object, "postureControl")).toBe(false)
    expect(Object.hasOwn(base as object, "questionGuard")).toBe(false)
  })
})

/* ================================================================== */
/*  4. host projection · setPosture full-patch + describe (H2)        */
/* ================================================================== */

describe("SessionHost · setPosture applies the FULL patch + describe echoes it (H2)", () => {
  const makeHost = async (base: RuntimeAgentConfigBase) => {
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base })
    return await binding
      .createRuntimeHost({
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})
  }

  test("HELL-POS-host-full-patch: with a wired control, session.posture.set applies mode+sandbox+askOutsidePlan and describe echoes it at rev 1", async () => {
    const lp = buildLivePosture("default")
    const base = baseConfig({
      // the live permission accessor is backed by the SAME authority (bootstrap parity)
      permission: {
        get mode() {
          return lp.modeState.get()
        },
        set mode(next: string) {
          lp.modeState.set(next as never)
        },
      } as never,
      postureControl: lp.control as never,
    })
    const host = await makeHost(base)

    const outcome = await host.setPosture?.({
      patch: { mode: "acceptEdits", askOutsidePlan: false, sandboxPolicy: { type: "read-only" } },
      scope: "current",
    })
    expect(outcome?.ok).toBe(true)

    const posture = host.describe().posture as PostureProjectionView | undefined
    expect(posture).toBeDefined()
    expect(posture?.revision).toBe(1)
    // the FULL patch reached the live view — NOT just the mode axis
    expect(posture?.effective.effectiveMode).toBe("acceptEdits")
    expect(posture?.effective.askOutsidePlan).toBe(false)
    // and the next turn's gate (the mode adapter over the SAME authority) reads it
    expect(lp.modeState.get()).toBe("acceptEdits")
  })

  test("HELL-POS-host-mode-only-fallback-control: NO wired control ⇒ describe echoes NO posture AND the full patch drops non-mode fields (paired control — the dead-wire behavior)", async () => {
    // A base WITHOUT postureControl but WITH a plain mode cell — the exact
    // pre-fix runtime. This is the H2 bug the wiring closes.
    let mode = "default"
    const base = baseConfig({
      permission: {
        get mode() {
          return mode
        },
        set mode(n: string) {
          mode = n
        },
      } as never,
    })
    const host = await makeHost(base)

    const outcome = await host.setPosture?.({
      patch: { mode: "acceptEdits", askOutsidePlan: false, sandboxPolicy: { type: "read-only" } },
      scope: "current",
    })
    expect(outcome?.ok).toBe(true)
    // describe echoes NO posture (no control wired)
    expect(host.describe().posture).toBeUndefined()
    // the mode axis applied via the compat fallback …
    expect(mode).toBe("acceptEdits")
    // … but askOutsidePlan/sandbox were SILENTLY DROPPED (no authority to hold them)
    // — nothing to read them back from, which is exactly the finding.
  })
})

/* ================================================================== */
/*  5. base → cfg.questionGuard live via the REAL assembler (H3)       */
/* ================================================================== */

describe("assembleAgentConfig · base.questionGuard ⇒ cfg.questionGuard drives the REAL dispatch predicate (H3)", () => {
  test("HELL-POS-guard-live: an ask-deny posture (askOutsidePlan false) BLOCKS request_user_input outside plan through the assembled cfg", async () => {
    const lp = buildLivePosture("default")
    const guard = livePostureQuestionReader(lp.authority)
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseConfig({ questionGuard: guard as never }) },
      {},
    )
    // the assembler carried the guard onto the config (…req.base spread)
    expect(cfg.questionGuard).toBe(guard)

    // default posture ⇒ available (byte-identical, default-OFF)
    expect(questionAvailability(cfg.questionGuard, "default").available).toBe(true)

    // `/posture ask off` denies OUTSIDE plan …
    await lp.control.apply({ patch: { askOutsidePlan: false }, scope: "current" })
    const denied = questionAvailability(cfg.questionGuard, "default")
    expect(denied.available).toBe(false)
    // … but plan mode is always allowed (the tool is designed for plan)
    expect(questionAvailability(cfg.questionGuard, "plan").available).toBe(true)
  })

  test("HELL-POS-guard-absent-control: NO questionGuard on the base ⇒ cfg.questionGuard undefined ⇒ ask-deny CANNOT block (paired control — the dead-wire behavior)", async () => {
    const lp = buildLivePosture("default")
    await lp.control.apply({ patch: { askOutsidePlan: false }, scope: "current" }) // a denying posture EXISTS
    const cfg = assembleAgentConfig({ mode: "interactive", base: baseConfig() }, {})
    expect(cfg.questionGuard).toBeUndefined()
    // with no guard bound the predicate is unconditionally AVAILABLE even though a
    // denying posture exists elsewhere — the exact H3 gap.
    expect(questionAvailability(cfg.questionGuard, "default").available).toBe(true)
  })
})

/* ================================================================== */
/*  6. M1 · a mode-cycle racing a /posture mutation is NOT lost       */
/* ================================================================== */

describe("M1 · mode adapter CAS-loser retries (racing /posture never loses the mode write)", () => {
  test("HELL-POS-M1-no-lost-write: a concurrent mode-cycle set + /posture ask off BOTH commit (mode preserved, non-mode preserved)", async () => {
    // Run the race repeatedly — the interleaving varies, but with the M1 retry the
    // OUTCOME is deterministic: both writes land. (Reverting the retry loop makes
    // the losing mode set silently vanish ⇒ RED.)
    for (let i = 0; i < 8; i++) {
      const lp = buildLivePosture("default")
      // both writers target the SAME starting revision (a genuine race)
      const posture = lp.control.apply({ patch: { askOutsidePlan: false }, scope: "current" })
      lp.modeState.set("bypass") // the mode-cycle (fire-and-forget)
      await posture
      await settle()
      // the mode-cycle write survived the CAS conflict …
      expect(lp.modeState.get()).toBe("bypass")
      // … AND the posture write is intact (composed, not clobbered) …
      expect(lp.authority.read().effective.askOutsidePlan).toBe(false)
      // … at TWO committed revisions (one per writer — nothing was lost).
      expect(lp.authority.read().revision).toBe(2)
    }
  })
})

/* ================================================================== */
/*  7. default-OFF byte-identity                                      */
/* ================================================================== */

describe("default-OFF byte-identity · no gate + no posture change ⇒ mode/dispatch/spec unchanged", () => {
  test("HELL-POS-default-off: a wired-but-unmutated posture leaves mode=default, questionGuard AVAILABLE, and the /posture command hidden without the gate", async () => {
    const prev = process.env.QUANTA_POSTURE_SELECTOR
    delete process.env.QUANTA_POSTURE_SELECTOR
    try {
      const lp = buildLivePosture("default")
      const guard = livePostureQuestionReader(lp.authority)
      // no mutation ⇒ the mode adapter reads the seed …
      expect(lp.modeState.get()).toBe("default")
      // … the guard is AVAILABLE (askOutsidePlan seeded true) at BOTH turn modes …
      expect(questionAvailability(guard, "default").available).toBe(true)
      expect(questionAvailability(guard, "plan").available).toBe(true)
      // … and the /posture slot is omitted (gate off) ⇒ command hidden / "not wired".
      const slot = buildPostureEditorSlot({
        postureControl: lp.control,
      } as unknown as SessionSetupResult)
      expect(slot).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.QUANTA_POSTURE_SELECTOR
      else process.env.QUANTA_POSTURE_SELECTOR = prev
    }
  })
})
