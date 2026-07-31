/**
 * `/goal` — set / show the active "pursuing" objective (Codex `/goal` parity).
 *
 *   /goal <objective>   → set the objective, mark it `active`. The idle
 *                         goal-continuation ticker (`goal-continuation-hook.ts`,
 *                         gated by `QUANTA_GOAL_ENFORCE`) then keeps resuming
 *                         work on it whenever the thread goes idle, until it is
 *                         completed / blocked / limited.
 *   /goal               → show the current objective + status.
 *   /goal clear         → drop the pursuit (mark `paused`).
 *
 * Present iff the surface wired the shared objective store (`ctx.goal`); absent
 * ⇒ prints the not-wired posture + exit 0 (default-OFF byte-identical). Setting
 * a goal is always allowed; whether it is AUTONOMOUSLY pursued depends on the
 * `QUANTA_GOAL_ENFORCE` gate that arms the ticker — without it, the objective is
 * still recorded and surfaced, just not auto-continued.
 */

import type { SlashCommand } from "../slash-contract"

const MAX_GOAL_CHARS = 4000

export const goalCmd: SlashCommand = {
  name: "/goal",
  describe:
    "Set or show the active pursuing objective (define measurable outcomes for best results)",
  category: "session",

  async run(args, ctx): Promise<number> {
    const wired = ctx.goal
    if (wired === undefined) {
      ctx.out(
        "/goal: not wired in this surface (objective store unavailable).\n" +
          "  Boot with QUANTA_OBJECTIVE_TOOLS=1 to record goals, and\n" +
          "  QUANTA_GOAL_ENFORCE=1 to have the agent keep pursuing them.\n",
      )
      return 0
    }

    const { port, threadId } = wired
    const raw = args.join(" ").trim()

    // /goal clear — stop pursuing.
    if (raw === "clear" || raw === "stop") {
      const existing = port.get(threadId)
      if (existing === null) {
        ctx.out("/goal: no active objective to clear.\n")
        return 0
      }
      port.updateStatus(threadId, "paused")
      ctx.out("Goal paused — the agent will stop auto-pursuing it.\n")
      return 0
    }

    // /goal (no arg) — show current.
    if (raw === "") {
      const o = port.get(threadId)
      if (o === null) {
        ctx.out(
          "No goal set. Usage: /goal <objective>  (define measurable outcomes for best results)\n",
        )
        return 0
      }
      const b = o.budget
      const budgetLine =
        b.maxTokens !== undefined ? `  budget: ${b.tokensUsed}/${b.maxTokens} tokens\n` : ""
      ctx.out(`🎯 Pursuing goal: ${o.goal}\n  status: ${o.status}\n${budgetLine}`)
      return 0
    }

    if (raw.length > MAX_GOAL_CHARS) {
      ctx.out(`/goal: objective too long (${raw.length} > ${MAX_GOAL_CHARS} chars).\n`)
      return 1
    }

    // /goal <objective> — set + activate. The ticker (if armed) picks it up on
    // the next idle tick; the objective is recorded either way.
    port.set(threadId, { goal: raw })
    port.updateStatus(threadId, "active")
    ctx.out(
      `🎯 Pursuing goal set: ${raw}\n` +
        "  The agent will keep working toward it whenever the session goes idle\n" +
        "  (requires QUANTA_GOAL_ENFORCE=1; otherwise the goal is recorded only).\n",
    )
    return 0
  },
}
