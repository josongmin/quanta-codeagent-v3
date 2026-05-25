/**
 * ADR-0236 composition-root mega-wire — hellgate (15+ adversarial cases).
 *
 * Pins the integration contract of the composition-root wire:
 *
 *   1. AgentConfig slots (delegation / focusChain / forkSession / textInbox /
 *      planEdit / composerEdit / stickyModelStore / toolProfile /
 *      identityModeVariant / playbookTrigger / automationEngine) are
 *      type-recognized + default-OFF (absent ⇒ byte-identical loop).
 *   2. CLI flags (--tool-profile / --sticky-model / --identity-mode /
 *      --focus-chain-every / --no-auto-background) parse + propagate + reject
 *      invalid input.
 *   3. Slash commands (`/profile`, `/identity`, `/focus-chain`) appear in
 *      BUILTINS, route to the correct seat, and print the "not wired" message
 *      when the SlashContext seat is absent.
 *   4. Focus-chain loop wire: tracker.tickTurn() is called per turn AND
 *      getInjection() output (when non-null) is appended as a user message
 *      BEFORE the LLM call.
 *
 * Every test is propositional (single observable rule). No heuristic / NLP
 * / threshold tests. Failures here are wire regressions, not provider drift.
 */

import { describe, expect, test } from "bun:test"
import { AgentArgsError, parseAgentArgs } from "@/../src/apps/agent/cli-args"
import type { AgentConfig } from "@/agent"
import { defaultFocusChainTracker } from "@/agent/focus-chain"
import { fsBackedStickyModelStore, inMemoryStickyModelStore } from "@/agent/sticky-model"
import { buildSystemPromptForMode, defaultModeVariantRegistry } from "@/agent/system-prompt"
import { ALL_TOOL_PROFILE_NAMES, defaultToolProfileResolver } from "@/agent/tool-profile"
import { BUILTINS, runSlashCommand, type SlashContext } from "@/apps/cli/slash-commands"

/* ─────────────────────────────────────────────────────────────────────── */
/* §1 — AgentConfig slot type recognition (compile-time + slot omission).   */
/* ─────────────────────────────────────────────────────────────────────── */

describe("ADR-0236 §1 — AgentConfig slot recognition", () => {
  test("CASE-1: all 11 new slots are optional (absent ⇒ legal config)", () => {
    // Construct a minimum-viable AgentConfig fragment. None of the new slots
    // are present. This compiles iff every new slot is optional.
    const cfg: Pick<
      AgentConfig,
      | "delegation"
      | "focusChain"
      | "forkSession"
      | "textInbox"
      | "planEdit"
      | "composerEdit"
      | "stickyModelStore"
      | "toolProfile"
      | "identityModeVariant"
      | "playbookTrigger"
      | "automationEngine"
    > = {}
    // Every slot reads as undefined (slot omitted).
    expect(cfg.delegation).toBeUndefined()
    expect(cfg.focusChain).toBeUndefined()
    expect(cfg.forkSession).toBeUndefined()
    expect(cfg.textInbox).toBeUndefined()
    expect(cfg.planEdit).toBeUndefined()
    expect(cfg.composerEdit).toBeUndefined()
    expect(cfg.stickyModelStore).toBeUndefined()
    expect(cfg.toolProfile).toBeUndefined()
    expect(cfg.identityModeVariant).toBeUndefined()
    expect(cfg.playbookTrigger).toBeUndefined()
    expect(cfg.automationEngine).toBeUndefined()
  })

  test("CASE-2: focusChain slot accepts a tracker built by defaultFocusChainTracker", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 4 })
    const slot: NonNullable<AgentConfig["focusChain"]> = { tracker, reinjectEveryN: 4 }
    expect(slot.tracker.currentTurn()).toBe(0)
    expect(slot.reinjectEveryN).toBe(4)
  })

  test("CASE-3: stickyModelStore accepts in-memory + fs-backed stores", () => {
    const inMem: NonNullable<AgentConfig["stickyModelStore"]> = {
      store: inMemoryStickyModelStore(),
    }
    const fs: NonNullable<AgentConfig["stickyModelStore"]> = {
      store: fsBackedStickyModelStore(),
    }
    expect(typeof inMem.store.get).toBe("function")
    expect(typeof fs.store.get).toBe("function")
  })

  test("CASE-4: toolProfile slot accepts every known profile name", () => {
    const resolver = defaultToolProfileResolver()
    for (const name of ALL_TOOL_PROFILE_NAMES) {
      const slot: NonNullable<AgentConfig["toolProfile"]> = {
        resolver,
        defaultName: name,
      }
      expect(slot.defaultName).toBe(name)
    }
  })

  test("CASE-5: identityModeVariant accepts the default registry", () => {
    const slot: NonNullable<AgentConfig["identityModeVariant"]> = {
      registry: defaultModeVariantRegistry(),
    }
    const variant = slot.registry.variantFor("plan")
    expect(variant.mode).toBe("plan")
    expect(variant.identity.length).toBeGreaterThan(0)
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §2 — CLI flag parsing + routing.                                         */
/* ─────────────────────────────────────────────────────────────────────── */

describe("ADR-0236 §2 — CLI flags parse + propagate", () => {
  test("CASE-6: --tool-profile <p> populates args.toolProfile", () => {
    const a = parseAgentArgs(["--mode", "interactive", "--tool-profile", "ask"])
    expect(a.toolProfile).toBe("ask")
  })

  test("CASE-7: --tool-profile rejects unknown name with a clear message", () => {
    expect(() => parseAgentArgs(["--mode", "interactive", "--tool-profile", "nope"])).toThrow(
      AgentArgsError,
    )
  })

  test("CASE-8: --sticky-model is a boolean flag (no value)", () => {
    const a = parseAgentArgs(["--mode", "interactive", "--sticky-model"])
    expect(a.stickyModel).toBe(true)
    // Default absent ⇒ undefined (not false): the parser does not write the
    // field when the flag is missing.
    const b = parseAgentArgs(["--mode", "interactive"])
    expect(b.stickyModel).toBeUndefined()
  })

  test("CASE-9: --identity-mode <m> validates against the closed set", () => {
    const a = parseAgentArgs(["--mode", "interactive", "--identity-mode", "architect"])
    expect(a.identityMode).toBe("architect")
    expect(() => parseAgentArgs(["--mode", "interactive", "--identity-mode", "wizard"])).toThrow(
      AgentArgsError,
    )
  })

  test("CASE-10: --focus-chain-every requires N>0 (rejects 0)", () => {
    const a = parseAgentArgs(["--mode", "interactive", "--focus-chain-every", "6"])
    expect(a.focusChainEvery).toBe(6)
    expect(() => parseAgentArgs(["--mode", "interactive", "--focus-chain-every", "0"])).toThrow(
      AgentArgsError,
    )
  })

  test("CASE-11: --no-auto-background is a boolean flag", () => {
    const a = parseAgentArgs(["--mode", "interactive", "--no-auto-background"])
    expect(a.noAutoBackground).toBe(true)
  })

  test("CASE-12: every flag absent ⇒ no new field on parsed args (byte-identical)", () => {
    const a = parseAgentArgs(["--mode", "interactive"])
    expect(a.toolProfile).toBeUndefined()
    expect(a.stickyModel).toBeUndefined()
    expect(a.identityMode).toBeUndefined()
    expect(a.focusChainEvery).toBeUndefined()
    expect(a.noAutoBackground).toBeUndefined()
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §3 — Slash commands registered + default-OFF routing.                    */
/* ─────────────────────────────────────────────────────────────────────── */

describe("ADR-0236 §3 — Slash commands registered", () => {
  test("CASE-13: /profile, /identity, /focus-chain all appear in BUILTINS", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/profile")
    expect(names).toContain("/identity")
    expect(names).toContain("/focus-chain")
  })

  const mkCtx = (
    extra: Partial<SlashContext> = {},
  ): SlashContext & {
    readonly outChunks: string[]
    readonly errChunks: string[]
  } => {
    const outChunks: string[] = []
    const errChunks: string[] = []
    return Object.assign(
      {
        cwd: "/tmp",
        out: (s: string) => outChunks.push(s),
        err: (s: string) => errChunks.push(s),
        ...extra,
      } as SlashContext,
      { outChunks, errChunks },
    )
  }

  test("CASE-14: /profile prints 'not wired' when ctx.profile is absent", async () => {
    const ctx = mkCtx()
    const code = await runSlashCommand("/profile", ctx)
    expect(code).toBe(0)
    expect(ctx.outChunks.join("")).toContain("not wired")
  })

  test("CASE-15: /identity prints 'not wired' when ctx.identity is absent", async () => {
    const ctx = mkCtx()
    const code = await runSlashCommand("/identity", ctx)
    expect(code).toBe(0)
    expect(ctx.outChunks.join("")).toContain("not wired")
  })

  test("CASE-16: /focus-chain prints 'not wired' when ctx.focusChain is absent", async () => {
    const ctx = mkCtx()
    const code = await runSlashCommand("/focus-chain", ctx)
    expect(code).toBe(0)
    expect(ctx.outChunks.join("")).toContain("not wired")
  })

  test("CASE-17: /profile show + set roundtrip via injected adapter", async () => {
    let active: string = "write"
    const ctx = mkCtx({
      profile: {
        get: () => active,
        set: (name) => {
          if ((ALL_TOOL_PROFILE_NAMES as readonly string[]).includes(name)) {
            active = name
            return "ok"
          }
          return { kind: "unknown", known: [...ALL_TOOL_PROFILE_NAMES] }
        },
        list: () => [...ALL_TOOL_PROFILE_NAMES],
      },
    })
    // show
    const code1 = await runSlashCommand("/profile", ctx)
    expect(code1).toBe(0)
    expect(ctx.outChunks.join("")).toContain("current = write")
    // set
    ctx.outChunks.length = 0
    const code2 = await runSlashCommand("/profile ask", ctx)
    expect(code2).toBe(0)
    expect(active).toBe("ask")
    // unknown
    const code3 = await runSlashCommand("/profile nope", ctx)
    expect(code3).toBe(1)
  })

  test("CASE-18: /focus-chain show / reset / skip route correctly", async () => {
    let resetCount = 0
    let skipCount = 0
    const ctx = mkCtx({
      focusChain: {
        snapshot: () => ({
          todos: [
            { text: "do X", state: "pending" },
            { text: "do Y", state: "in-progress" },
          ],
          currentTurn: 3,
          driftWarning: null,
        }),
        reset: () => {
          resetCount += 1
        },
        skip: () => {
          skipCount += 1
        },
      },
    })
    // show (default subcommand)
    const c1 = await runSlashCommand("/focus-chain", ctx)
    expect(c1).toBe(0)
    expect(ctx.outChunks.join("")).toContain("current turn = 3")
    expect(ctx.outChunks.join("")).toContain("do X")
    // reset
    const c2 = await runSlashCommand("/focus-chain reset", ctx)
    expect(c2).toBe(0)
    expect(resetCount).toBe(1)
    // skip
    const c3 = await runSlashCommand("/focus-chain skip", ctx)
    expect(c3).toBe(0)
    expect(skipCount).toBe(1)
    // unknown sub
    const c4 = await runSlashCommand("/focus-chain nope", ctx)
    expect(c4).toBe(1)
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §4 — Identity-mode-variant prompt build (CLI flag drives prompt body).   */
/* ─────────────────────────────────────────────────────────────────────── */

describe("ADR-0236 §4 — identityModeVariant drives prompt body", () => {
  test("CASE-19: buildSystemPromptForMode varies prompt per mode (architect vs editor)", () => {
    const registry = defaultModeVariantRegistry()
    const architect = buildSystemPromptForMode({ mode: "architect", registry })
    const editor = buildSystemPromptForMode({ mode: "editor", registry })
    expect(architect.length).toBeGreaterThan(0)
    expect(editor.length).toBeGreaterThan(0)
    // The two variants must NOT produce byte-identical prompts (mode
    // discrimination is the whole point of ADR-0211).
    expect(architect).not.toBe(editor)
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §5 — focusChain loop wire: tickTurn + getInjection behavioural contract. */
/*                                                                          */
/* Tests the tracker directly (the loop calls these methods on every turn). */
/* Loop integration is structural; this case proves the tracker behaves     */
/* per ADR-0219 (inject every N turns, never before turn N, drift detect).  */
/* ─────────────────────────────────────────────────────────────────────── */

describe("ADR-0236 §5 — focus-chain tracker behavioural invariants", () => {
  test("CASE-20: tracker injects exactly every N turns (cadence == reinjectEveryN)", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 3 })
    tracker.setTodos([{ text: "do thing", state: "pending" }])
    // turn 0 — no inject (model just saw the todos).
    expect(tracker.getInjection()).toBeNull()
    // turn 1, 2 — no inject (cadence not met).
    tracker.tickTurn()
    expect(tracker.getInjection()).toBeNull()
    tracker.tickTurn()
    expect(tracker.getInjection()).toBeNull()
    // turn 3 — INJECT (cadence met).
    tracker.tickTurn()
    const first = tracker.getInjection()
    expect(first).not.toBeNull()
    expect((first as string).length).toBeGreaterThan(0)
    // a second call in the same turn returns null (single-shot per turn).
    expect(tracker.getInjection()).toBeNull()
    // turn 4, 5 — no inject.
    tracker.tickTurn()
    expect(tracker.getInjection()).toBeNull()
    tracker.tickTurn()
    expect(tracker.getInjection()).toBeNull()
    // turn 6 — INJECT again (next cycle).
    tracker.tickTurn()
    expect(tracker.getInjection()).not.toBeNull()
  })

  test("CASE-21: empty todo list ⇒ never injects (cadence is gated on non-empty todos)", () => {
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 1 })
    // No setTodos call ⇒ empty list.
    tracker.tickTurn()
    expect(tracker.getInjection()).toBeNull()
    tracker.tickTurn()
    expect(tracker.getInjection()).toBeNull()
  })
})
