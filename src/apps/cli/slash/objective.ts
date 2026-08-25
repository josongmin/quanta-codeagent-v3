/**
 * `/objective` — DEPRECATED alias of `/goal` (GOAL-05A).
 *
 * RFC-03 C3 introduced `/objective` as the CAS-guarded editor; GOAL-05A folds
 * it into the single Goal control. The alias translates its historical verbs
 * onto the `/goal` grammar and calls the SAME control instance (`ctx.goal`),
 * so `/objective edit x` and `/goal edit x` emit deep-equal commands and one
 * authority commit each (rail 11). It prints a one-line deprecation notice.
 *
 *   /objective | /objective show   → /goal
 *   /objective edit <text>         → /goal edit <text>
 *   /objective pause|resume|clear  → /goal pause|resume|clear
 *   /objective <text…>             → /goal <text…>   (create; refused if one exists)
 *
 * DEFAULT-OFF registration: only when `QUANTA_PROPOSE_GOAL` is on (unchanged;
 * GOAL-05B makes the public preset the sole owner of command discovery).
 */

import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand, SlashContext } from "../slash-contract"
import { goalCmd } from "./goal-cmd"

/** RFC-03 C3 — `/objective` registration gate (default-OFF, opt-IN). */
export const isObjectiveEditorEnabled = (): boolean =>
  readCliKnob("QUANTA_PROPOSE_GOAL", "bool") ?? false

const DEPRECATION = "/objective is deprecated — use /goal (same control, same commands).\n"

/** Translate `/objective` argv onto the `/goal` grammar (pure). */
export const translateObjectiveArgs = (args: readonly string[]): readonly string[] => {
  const [sub, ...rest] = args
  if (sub === undefined || sub === "show") return []
  if (sub === "edit" || sub === "pause" || sub === "resume" || sub === "clear")
    return [sub, ...rest]
  return [...args]
}

export const objectiveCmd: SlashCommand = {
  name: "/objective",
  describe: "Deprecated alias of /goal (show | edit <text> | pause | resume | clear)",
  category: "session",
  async run(args, ctx) {
    if (ctx.goal === undefined) {
      ctx.out("/objective: not wired in this surface\n")
      return 0
    }
    ctx.out(DEPRECATION)
    return goalCmd.run(translateObjectiveArgs(args), ctx)
  },
}

export type { SlashContext }
