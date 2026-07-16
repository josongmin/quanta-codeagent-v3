/**
 * ADR-0239 §C hellgate — identity per-turn reminder splice
 * (loop-helpers `shouldSpliceIdentityReminder` + `buildIdentityReminderText`).
 *
 * 11 closed cases pinning:
 *
 *   §C1 architect mode + default knob ⇒ reminder rendered (mode-conditional auto-ON).
 *   §C2 editor mode + default knob ⇒ reminder rendered (mode-conditional auto-ON).
 *   §C3 default mode + default knob ⇒ NO reminder (mode-conditional auto-OFF).
 *   §C4 plan / review / audit + default knob ⇒ NO reminder (already get modeNotice).
 *   §C5 perTurnReminderEnabled=false ⇒ NO reminder for any mode (explicit opt-out).
 *   §C6 perTurnReminderEnabled=true + non-architect/editor mode ⇒ reminder rendered.
 *   §C7 absent identityModeVariant slot ⇒ NO reminder (default-OFF byte-identical).
 *   §C8 reminder text wrapped in <system-reminder>...</system-reminder>.
 *   §C9 reminder body matches the variant's identity lines (multi-line join).
 *   §C10 empty-identity variant ⇒ NO reminder (no useful nudge).
 *   §C11 throwing registry ⇒ NO reminder (defense-in-depth, no crash).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildIdentityReminderText, shouldSpliceIdentityReminder } from "@/agent/loop-helpers"
import { prepareTurnIteration } from "@/agent/loop/turn-iteration"
import type { AgentMode } from "@/agent/prompt"
import { defaultModeVariantRegistry, type SystemPromptVariantRegistry } from "@/agent/system-prompt"
import { createWorkingMemory } from "@/memory"

const cfgWith = (block: NonNullable<AgentConfig["identityModeVariant"]> | undefined): AgentConfig =>
  ({
    identityModeVariant: block,
  }) as unknown as AgentConfig

describe("ADR-0239 §C — identity per-turn reminder splice", () => {
  // ── §C1 ── architect + default knob ⇒ reminder ───────────────────────────
  test("C1: architect mode with default knob renders the reminder", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    expect(shouldSpliceIdentityReminder(cfgWith(block), "architect")).toBe(true)
    const text = buildIdentityReminderText(cfgWith(block), "architect")
    expect(text).toBeDefined()
    // jul-13 identity SSOT consolidation (166fdc408): DEFAULT_MODE_VARIANTS now
    // PROJECTS from DEFAULT_IDENTITIES, whose canonical architect body renders
    // "**architect mode**" (lowercase mode name) — NOT the pre-consolidation
    // capitalized "Architect mode". Pin the distinctive architect posture phrase.
    expect(text).toContain("architect mode")
    expect(text).toContain("design-first")
  })

  // ── §C2 ── editor + default knob ⇒ reminder ──────────────────────────────
  test("C2: editor mode with default knob renders the reminder", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    expect(shouldSpliceIdentityReminder(cfgWith(block), "editor")).toBe(true)
    const text = buildIdentityReminderText(cfgWith(block), "editor")
    expect(text).toBeDefined()
    // jul-13 SSOT (166fdc408): editor body renders "**editor mode**" (lowercase);
    // pin the distinctive editor posture phrase (minimal-diff discipline).
    expect(text).toContain("editor mode")
    expect(text).toContain("minimal diffs only")
  })

  // ── §C3 ── default mode + default knob ⇒ NO reminder ─────────────────────
  test("C3: default mode with default knob does NOT render (auto-OFF)", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    expect(shouldSpliceIdentityReminder(cfgWith(block), "default")).toBe(false)
    const text = buildIdentityReminderText(cfgWith(block), "default")
    expect(text).toBeUndefined()
  })

  // ── §C4 ── plan / review / audit + default knob ⇒ NO reminder ────────────
  test("C4: plan / review / audit with default knob do NOT render (modeNotice owns those)", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    for (const mode of ["plan", "review", "audit"] as const satisfies readonly AgentMode[]) {
      expect(shouldSpliceIdentityReminder(cfgWith(block), mode)).toBe(false)
      expect(buildIdentityReminderText(cfgWith(block), mode)).toBeUndefined()
    }
  })

  // ── §C5 ── explicit false ⇒ NO reminder for any mode ─────────────────────
  test("C5: perTurnReminderEnabled=false suppresses every mode", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
      perTurnReminderEnabled: false,
    }
    for (const mode of [
      "default",
      "plan",
      "review",
      "audit",
      "architect",
      "editor",
    ] as const satisfies readonly AgentMode[]) {
      expect(shouldSpliceIdentityReminder(cfgWith(block), mode)).toBe(false)
      expect(buildIdentityReminderText(cfgWith(block), mode)).toBeUndefined()
    }
  })

  // ── §C6 ── explicit true ⇒ reminder for non-architect/editor too ─────────
  test("C6: perTurnReminderEnabled=true enables every mode (explicit opt-in)", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
      perTurnReminderEnabled: true,
    }
    for (const mode of [
      "default",
      "plan",
      "review",
      "audit",
      "architect",
      "editor",
    ] as const satisfies readonly AgentMode[]) {
      expect(shouldSpliceIdentityReminder(cfgWith(block), mode)).toBe(true)
      const text = buildIdentityReminderText(cfgWith(block), mode)
      expect(text).toBeDefined()
      expect(text!.startsWith("<system-reminder>")).toBe(true)
    }
  })

  // ── §C7 ── absent slot ⇒ NO reminder (default-OFF byte-identical) ────────
  test("C7: absent identityModeVariant slot ⇒ no reminder, no allocation", () => {
    const cfg = cfgWith(undefined)
    expect(shouldSpliceIdentityReminder(cfg, "architect")).toBe(false)
    expect(buildIdentityReminderText(cfg, "architect")).toBeUndefined()
    expect(shouldSpliceIdentityReminder(cfg, "editor")).toBe(false)
    expect(buildIdentityReminderText(cfg, "editor")).toBeUndefined()
  })

  // ── §C8 ── reminder is wrapped in <system-reminder>...</system-reminder> ─
  test("C8: reminder text wrapped in <system-reminder> markers", () => {
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    const text = buildIdentityReminderText(cfgWith(block), "architect")
    expect(text!.startsWith("<system-reminder>\n")).toBe(true)
    expect(text!.endsWith("\n</system-reminder>")).toBe(true)
  })

  // ── §C9 ── reminder body matches the variant's identity lines ────────────
  test("C9: reminder body is the variant's identity lines joined by newline", () => {
    // Custom registry with a multi-line identity to pin join semantics.
    const customRegistry: SystemPromptVariantRegistry = {
      variantFor(mode) {
        return {
          mode: mode as never,
          identity: ["line A", "line B", "line C"],
        } as never
      },
    }
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: customRegistry,
      perTurnReminderEnabled: true,
    }
    const text = buildIdentityReminderText(cfgWith(block), "default")
    expect(text).toBe("<system-reminder>\nline A\nline B\nline C\n</system-reminder>")
  })

  // ── §C10 ── empty-identity variant ⇒ NO reminder ─────────────────────────
  test("C10: a variant with empty identity lines yields NO reminder", () => {
    const emptyRegistry: SystemPromptVariantRegistry = {
      variantFor(mode) {
        return { mode: mode as never, identity: [] as readonly string[] } as never
      },
    }
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: emptyRegistry,
      perTurnReminderEnabled: true,
    }
    // shouldSpliceIdentityReminder is true (knob says yes), but text builder
    // returns undefined because the variant carries no useful line.
    expect(shouldSpliceIdentityReminder(cfgWith(block), "architect")).toBe(true)
    expect(buildIdentityReminderText(cfgWith(block), "architect")).toBeUndefined()
  })

  // ── §C11 ── throwing registry ⇒ NO reminder, NO crash ────────────────────
  test("C11: a throwing registry.variantFor surfaces as no reminder (defense-in-depth)", () => {
    const throwingRegistry: SystemPromptVariantRegistry = {
      variantFor() {
        throw new Error("registry bug")
      },
    }
    const block: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: throwingRegistry,
      perTurnReminderEnabled: true,
    }
    expect(() => buildIdentityReminderText(cfgWith(block), "architect")).not.toThrow()
    expect(buildIdentityReminderText(cfgWith(block), "architect")).toBeUndefined()
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §D — LOOP WIRE: prepareTurnIteration splices the reminder into the       */
/* ASSEMBLED working memory (ALBB-14). These promote the §C unit-calls to   */
/* the real loop path: today the helpers exist but have ZERO call sites in  */
/* prepareTurnIteration, so every §D case is RED until injectIdentityReminder*/
/* is wired.                                                                 */
/* ─────────────────────────────────────────────────────────────────────── */

type ErrorEvent = { type: string; message?: string }

/** Build a minimal loop-shaped AgentConfig: only the fields prepareTurnIteration
 *  touches (all optional slots absent ⇒ default-OFF), plus the identity slot +
 *  a mode + a capturing stream. */
const loopCfg = (args: {
  identityModeVariant?: NonNullable<AgentConfig["identityModeVariant"]>
  mode?: AgentMode
}): { cfg: AgentConfig; events: ErrorEvent[] } => {
  const events: ErrorEvent[] = []
  const cfg = {
    signal: new AbortController().signal,
    maxTurns: Number.POSITIVE_INFINITY, // unbounded ⇒ turn-budget injector is a no-op
    stream: { emit: (e: ErrorEvent) => events.push(e) },
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.identityModeVariant !== undefined
      ? { identityModeVariant: args.identityModeVariant }
      : {}),
  } as unknown as AgentConfig
  return { cfg, events }
}

const runTurn = async (cfg: AgentConfig, wm: ReturnType<typeof createWorkingMemory>) =>
  await prepareTurnIteration({
    cfg,
    wm: wm as never,
    sessionId: "s1",
    taskRegistry: undefined,
    turn: 1,
    localizePhaseState: undefined,
    dedupGate: undefined,
    shellSnapshotSession: undefined,
    hookPromptPending: [],
    tokenBaseline: undefined,
  })

const reminderPresent = (wm: ReturnType<typeof createWorkingMemory>): boolean =>
  (wm.snapshot() as ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string }> }>).some(
    (m) =>
      m.content.some((b) => b.type === "text" && (b.text ?? "").includes("<system-reminder>")),
  )

describe("ALBB-14 §D — identity reminder is spliced into assembled working memory", () => {
  // ── §D1 ── architect + default knob ⇒ reminder PRESENT in wm ────────────
  test("D1: architect turn splices the <system-reminder> identity line into wm", async () => {
    const { cfg } = loopCfg({
      identityModeVariant: { registry: defaultModeVariantRegistry() },
      mode: "architect",
    })
    const wm = createWorkingMemory([])
    const outcome = await runTurn(cfg, wm)
    expect(outcome).toBe("continue")
    expect(reminderPresent(wm)).toBe(true)
  })

  // ── §D2 ── editor + explicit true ⇒ reminder PRESENT ────────────────────
  test("D2: editor turn with perTurnReminderEnabled=true splices the reminder", async () => {
    const { cfg } = loopCfg({
      identityModeVariant: {
        registry: defaultModeVariantRegistry(),
        perTurnReminderEnabled: true,
      },
      mode: "editor",
    })
    const wm = createWorkingMemory([])
    await runTurn(cfg, wm)
    expect(reminderPresent(wm)).toBe(true)
  })

  // ── §D3 ── default mode + default knob ⇒ ABSENT (byte-identical) ────────
  test("D3: default mode with default knob does NOT splice (auto-OFF)", async () => {
    const { cfg } = loopCfg({
      identityModeVariant: { registry: defaultModeVariantRegistry() },
      mode: "default",
    })
    const wm = createWorkingMemory([])
    await runTurn(cfg, wm)
    expect(reminderPresent(wm)).toBe(false)
  })

  // ── §D4 ── explicit false ⇒ ABSENT for architect ───────────────────────
  test("D4: perTurnReminderEnabled=false suppresses the splice even for architect", async () => {
    const { cfg } = loopCfg({
      identityModeVariant: {
        registry: defaultModeVariantRegistry(),
        perTurnReminderEnabled: false,
      },
      mode: "architect",
    })
    const wm = createWorkingMemory([])
    await runTurn(cfg, wm)
    expect(reminderPresent(wm)).toBe(false)
  })

  // ── §D5 ── absent slot ⇒ byte-identical (no message appended at all) ────
  test("D5: absent identityModeVariant slot ⇒ wm unchanged (default-OFF byte-identical)", async () => {
    const { cfg } = loopCfg({ mode: "architect" })
    const wm = createWorkingMemory([])
    const before = wm.snapshot().length
    await runTurn(cfg, wm)
    expect(reminderPresent(wm)).toBe(false)
    // No synthetic message appended (turn-budget is a no-op for unbounded maxTurns).
    expect(wm.snapshot().length).toBe(before)
  })

  // ── §D6 ── registry-throw observability: warn/metric, NOT silent vanish ─
  test("D6: a throwing registry surfaces an observable warn (not a silent undefined)", async () => {
    const throwingRegistry: SystemPromptVariantRegistry = {
      variantFor() {
        throw new Error("registry bug")
      },
    }
    const { cfg, events } = loopCfg({
      identityModeVariant: {
        registry: throwingRegistry,
        perTurnReminderEnabled: true,
      },
      mode: "architect",
    })
    const wm = createWorkingMemory([])
    await runTurn(cfg, wm)
    // No reminder spliced (registry threw), but the failure MUST be observable.
    expect(reminderPresent(wm)).toBe(false)
    expect(
      events.some(
        (e) => e.type === "error" && (e.message ?? "").toLowerCase().includes("identity"),
      ),
    ).toBe(true)
  })
})
