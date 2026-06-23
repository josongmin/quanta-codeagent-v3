/**
 * Surface slash cluster — `/focus-chain`, `/effort`, `/brief` (extracted from
 * `registry-surface.ts` to keep that module under the god-module ceiling).
 *
 * These three session-posture config commands share no state with each other,
 * but each carries its own private helpers (the Focus Chain subcommand
 * vocabulary, the effort-line formatter, the brief on/off arg sets) that live
 * only here. None of the three consts are part of the surface public API — the
 * assembler in `registry-surface.ts` imports them by name into
 * `buildSurfaceSlashCommands`.
 */

import type { SlashCommand } from "../../slash-contract"

const FOCUS_CHAIN_SUBCMDS = ["show", "reset", "skip"] as const
type FocusChainSubcmd = (typeof FOCUS_CHAIN_SUBCMDS)[number]
const isFocusChainSubcmd = (s: string): s is FocusChainSubcmd =>
  (FOCUS_CHAIN_SUBCMDS as readonly string[]).includes(s)

export const focusChainCmd: SlashCommand = {
  name: "/focus-chain",
  describe: "Show / reset / skip the Focus Chain todo tracker (ADR-0219)",
  category: "config",
  async run(args, ctx) {
    if (ctx.focusChain === undefined) {
      ctx.out("/focus-chain: not wired in this surface\n")
      return 0
    }
    const sub: FocusChainSubcmd =
      args.length === 0
        ? "show"
        : isFocusChainSubcmd(args[0] as string)
          ? (args[0] as FocusChainSubcmd)
          : (() => {
              ctx.err(
                `/focus-chain: unknown subcommand '${args[0]}'; known = ${FOCUS_CHAIN_SUBCMDS.join(", ")}\n`,
              )
              return "show" as FocusChainSubcmd
            })()
    if (args.length > 0 && !isFocusChainSubcmd(args[0] as string)) {
      // The IIFE above already printed the error and degraded to `show`,
      // but we need to exit 1 for unknown subcommand.
      return 1
    }
    if (args.length > 1) {
      ctx.err(`/focus-chain: subcommands take no arguments; got ${args.length - 1} extra\n`)
      return 1
    }
    if (sub === "reset") {
      ctx.focusChain.reset()
      ctx.out("/focus-chain: cleared\n")
      return 0
    }
    if (sub === "skip") {
      ctx.focusChain.skip()
      ctx.out("/focus-chain: skipped one cycle\n")
      return 0
    }
    const snap = ctx.focusChain.snapshot()
    ctx.out(`/focus-chain: current turn = ${snap.currentTurn}\n`)
    if (snap.todos.length === 0) {
      ctx.out("/focus-chain: (no todos)\n")
    } else {
      ctx.out(`/focus-chain: ${snap.todos.length} todo(s):\n`)
      for (let i = 0; i < snap.todos.length; i++) {
        const t = snap.todos[i] as { readonly text: string; readonly state: string }
        ctx.out(`  ${i + 1}. [${t.state}] ${t.text}\n`)
      }
    }
    if (snap.driftWarning !== null) {
      ctx.out(`/focus-chain: drift — ${snap.driftWarning}\n`)
    }
    return 0
  },
}

/** `/effort` — session-level reasoning-effort picker. Codex `/model`-style UX
 *  but effort-only (model swap is `/retry-with`'s job). No args ⇒ status
 *  line + level list; one named arg ⇒ set the new tier (the wire callback
 *  mutates the surface-owned EffortStore AND repaints the chrome pill). The
 *  five tiers map to thinking budgets via `effortToTokenBudget` — `"default"`
 *  emits NO `thinking` field on LLMInput (provider default behavior). */
const formatEffortLine = (level: string, budget: number | undefined, current: boolean): string => {
  const marker = current ? "*" : " "
  const tag =
    budget === undefined
      ? "provider default (no thinking budget)"
      : `~${budget.toLocaleString("en-US")} tokens`
  return ` ${marker} ${level.padEnd(8)} ${tag}\n`
}

export const effortCmd: SlashCommand = {
  name: "/effort",
  describe: "Show or switch session reasoning effort (default|low|medium|high|max)",
  category: "config",
  async run(args, ctx) {
    if (ctx.effort === undefined) {
      ctx.out("/effort: not wired in this surface\n")
      return 0
    }
    const { get, set, levels, budgetTokens } = ctx.effort
    if (args.length === 0) {
      const cur = get()
      const curBudget = budgetTokens(cur)
      ctx.out(
        `🧠 reasoning effort: ${cur}${curBudget !== undefined ? ` (~${curBudget.toLocaleString("en-US")} tokens)` : " (provider default)"}\n`,
      )
      for (const lvl of levels) ctx.out(formatEffortLine(lvl, budgetTokens(lvl), lvl === cur))
      ctx.out("use: /effort <level>\n")
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/effort: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const arg = (args[0] as string).trim().toLowerCase()
    const next = levels.find((l) => l === arg)
    if (next === undefined) {
      ctx.err(`/effort: unknown level '${arg}'; known = ${levels.join(", ")}\n`)
      return 1
    }
    set(next)
    const nextBudget = budgetTokens(next)
    ctx.out(
      nextBudget === undefined
        ? `🧠 effort: ${next} (provider default — no thinking budget)\n`
        : `🧠 effort: ${next} (~${nextBudget.toLocaleString("en-US")} tokens)\n`,
    )
    return 0
  },
  complete: (args, partial, ctx) => {
    if (ctx.effort === undefined || args.length >= 1) return []
    const seed = partial.toLowerCase()
    return ctx.effort.levels
      .filter((lvl) => lvl.startsWith(seed))
      .map((lvl) => ({ value: lvl, kind: "argument" as const }))
  },
}

/** `/brief` — toggle the brief-mode session posture (C3, jun-4-brief-mode RFC).
 *  No args ⇒ flip the current state; an explicit `on`/`off` arg sets it. When
 *  ON, the model condenses its FINAL prose (correctness reporting is exempt).
 *  ORTHOGONAL to `/effort` — both can be set ("think deeply, answer tersely").
 *  Mirrors Claude's `"Brief-only mode enabled"` echo; the NEXT turn's
 *  `buildTurnContext({ brief })` reads the store and emits the directive. */
const BRIEF_ON_ARGS: ReadonlySet<string> = new Set(["on", "true", "1", "yes"])
const BRIEF_OFF_ARGS: ReadonlySet<string> = new Set(["off", "false", "0", "no"])
export const briefCmd: SlashCommand = {
  name: "/brief",
  describe: "Show or toggle brief mode (condensed final prose; correctness reporting kept)",
  category: "config",
  async run(args, ctx) {
    if (ctx.brief === undefined) {
      ctx.out("/brief: not wired in this surface\n")
      return 0
    }
    const { get, set } = ctx.brief
    if (args.length === 0) {
      set(!get())
      ctx.out(`📝 brief mode ${get() ? "on" : "off"}\n`)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/brief: takes at most one argument; got ${args.length}\n`)
      return 1
    }
    const arg = (args[0] as string).trim().toLowerCase()
    if (BRIEF_ON_ARGS.has(arg)) set(true)
    else if (BRIEF_OFF_ARGS.has(arg)) set(false)
    else {
      ctx.err(`/brief: unknown arg '${arg}'; use on|off (or no arg to toggle)\n`)
      return 1
    }
    ctx.out(`📝 brief mode ${get() ? "on" : "off"}\n`)
    return 0
  },
  complete: (args, partial, ctx) => {
    if (ctx.brief === undefined || args.length >= 1) return []
    const seed = partial.toLowerCase()
    return ["on", "off"]
      .filter((v) => v.startsWith(seed))
      .map((v) => ({ value: v, kind: "argument" as const }))
  },
}
