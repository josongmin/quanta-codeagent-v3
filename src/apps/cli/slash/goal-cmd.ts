/**
 * `/goal` — the operator's Goal control (GOAL-05A).
 *
 * This file PARSES ONLY. `goal-args.ts` turns argv into one typed command,
 * `buildGoalControl` (the single CLI adapter over the authority / read /
 * verifier ports) commits it exactly once, and `goal-render.ts` renders the
 * FRESH re-read report. Nothing here decides a transition, mutates a store,
 * or predicts a status — every verdict is the authority's typed rejection.
 *
 *   /goal <text>                         create once (a second create is refused: use edit)
 *   /goal                                show the report
 *   /goal edit [--keep-contract] <text>  new generation (evidence reset; contract cleared unless kept)
 *   /goal pause | stop | resume | clear  explicit status / deletion
 *   /goal criterion add|edit|remove|complete|reopen …
 *   /goal check add|edit|remove … -- <argv>
 *   /goal budget --max-turns=N --max-tokens=N
 *   /goal verify                          run the verifier (no agent turn)
 *   /goal work <instruction>              one foreground turn with user-requested provenance
 *
 * Present iff the surface wired the goal control (`ctx.goal`); absent ⇒ prints
 * the not-wired posture + exit 0 (default-OFF byte-identical). Whether a goal
 * is AUTONOMOUSLY pursued is the `QUANTA_GOAL_ENFORCE` gate's business.
 */

import type { CommitRejection } from "@/objective"
import { parseGoalArgs } from "../goal/goal-args"
import type { GoalCommandResult } from "../goal/goal-control"
import { renderGoalReport } from "../goal/goal-render"
import type { SlashCommand, SlashContext } from "../slash-contract"

/** Operator wording for every authority rejection (drift-guarded Record). */
export const GOAL_REJECTION_MESSAGE: Record<CommitRejection, string> = {
  stale: "the goal changed under you — run /goal and retry",
  "approval-required": "this change needs an approval that was not granted",
  "approval-unavailable": "this change needs an approval but no confirmation surface is available",
  "forbidden-completion": "completion is owned by the authority; it cannot be set directly",
  "checked-verifier-only":
    "that is a CHECKED criterion — only the verifier can complete it (run /goal verify)",
  "objective-exists": "a goal already exists — use `/goal edit <text>` to replace it",
  "objective-missing": "no goal is set — use `/goal <text>` first",
  "objective-mismatch": "the evidence belongs to a previous goal generation",
  "attempt-replayed": "that attempt was already settled",
  "goal-too-long": "the goal text exceeds the 4000-character ceiling",
  "actor-forbidden": "the operator surface may not issue that change",
  "invalid-transition": "that status change is not allowed from the goal's current state",
  "terminal-objective":
    "the goal is completed — create a new goal (`/goal edit <text>`) instead of amending it",
  "definition-change-forbidden": "the goal definition is user-owned; this path may not change it",
  "manual-attestation-required": "a manual criterion can only be completed by you",
  "validation-contract-missing":
    "the goal has no criteria or checks yet — add one with `/goal criterion add` or `/goal check add`",
  "attempt-in-flight":
    "an attributed attempt is still running — wait for it to settle (or pause first)",
  "hard-cap-exhausted":
    "the product autonomous attempt cap (20) for this goal is exhausted — create a new goal generation",
  "budget-exhausted":
    "the goal's turn budget is exhausted — amend it with `/goal budget --max-turns=N`",
  invalid: "the change could not be applied",
}

const NOT_WIRED =
  "/goal: not wired in this surface (objective store unavailable).\n" +
  "  Boot with QUANTA_OBJECTIVE_TOOLS=1 to record goals, and\n" +
  "  QUANTA_GOAL_ENFORCE=1 to have the agent keep pursuing them.\n"

const VERIFY_LINE: Record<string, string> = {
  verified: "verifier ran",
  "no-checks": "no runnable checks on this goal (add one with `/goal check add … -- <argv>`)",
  "stale-source": "the workspace changed while checks ran — nothing was recorded; retry",
  "source-unavailable": "workspace evidence unavailable",
  "cap-exceeded": "workspace evidence cap exceeded",
  "runner-unavailable": "check runner unavailable",
  cancelled: "verification cancelled",
  "freshness-unresolved": "source freshness could not be resolved",
  rejected: "the authority refused the verification batch",
}

/** Map a control result to operator output + exit code (report is always re-read). */
export const reportGoalResult = (
  ctx: SlashContext,
  result: GoalCommandResult,
  okHeadline: string | undefined,
): number => {
  switch (result.kind) {
    case "ok":
      ctx.out(
        `${okHeadline === undefined ? "" : `${okHeadline}\n`}${renderGoalReport(result.report)}`,
      )
      return 0
    case "rejected":
      ctx.err(`/goal: ${GOAL_REJECTION_MESSAGE[result.reason]}\n`)
      if (result.report !== null) ctx.out(renderGoalReport(result.report))
      return 1
    case "no-objective":
      ctx.out(renderGoalReport(null))
      return 0
    case "invalid":
      ctx.err(`${result.message}\n`)
      return 1
    case "verified": {
      const o = result.outcome
      const detail =
        o.kind === "verified"
          ? `verifier ran: ${o.passed} passed · ${o.failed} failed (rev ${o.revision})`
          : `${VERIFY_LINE[o.kind] ?? o.kind}${"reason" in o ? ` — ${o.reason}` : ""}`
      ctx.out(`${detail}\n${renderGoalReport(result.report)}`)
      return o.kind === "verified" || o.kind === "no-checks" ? 0 : 1
    }
    case "work-queued":
      ctx.out(
        "Goal work queued — one foreground turn will run with user-requested goal provenance " +
          "(charges the goal's turn budget, not the autonomous cap).\n" +
          renderGoalReport(result.report),
      )
      return 0
  }
}

const OK_HEADLINE: Record<string, string> = {
  create:
    "🎯 Pursuing goal set. The agent keeps working toward it whenever the session goes idle\n" +
    "  (requires QUANTA_GOAL_ENFORCE=1; otherwise the goal is recorded only).",
  edit: "Goal replaced (new generation; evidence reset).",
  pause: "Goal paused — auto-pursuit suppressed.",
  resume: "Goal resumed — auto-pursuit re-armed.",
  clear: "Goal cleared — the agent will stop auto-pursuing it.",
  budget: "Budget amended (same goal; evidence kept).",
}

export const goalCmd: SlashCommand = {
  name: "/goal",
  describe:
    "Goal control: set/show, edit, pause/resume/clear, criterion, check, budget, verify, work",
  category: "session",

  async run(args, ctx): Promise<number> {
    const wired = ctx.goal
    if (wired === undefined) {
      ctx.out(NOT_WIRED)
      return 0
    }
    const parsed = parseGoalArgs(args)
    if (!parsed.ok) {
      ctx.err(`${parsed.error}\n`)
      return 1
    }
    const result = await wired.control.run(parsed.command)
    if (result.kind === "ok" && parsed.command.kind === "clear") {
      ctx.out(`${OK_HEADLINE.clear}\n`)
      return 0
    }
    return reportGoalResult(ctx, result, OK_HEADLINE[parsed.command.kind])
  },
}
