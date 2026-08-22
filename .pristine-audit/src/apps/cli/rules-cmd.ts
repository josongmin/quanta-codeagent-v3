/**
 * `/rules` slash command — surface the rule inventory built by
 * {@link buildRuleInventory}.
 *
 * Three sub-commands (all read-only — this command NEVER edits rule files):
 *
 *   /rules                 — short summary: pill text + matched-rule list
 *   /rules list            — full inventory: matched + unmatched
 *   /rules path <pattern>  — simulate which rules would fire for a path
 *
 * Slice: this file lives in `src/apps/cli` and imports `@/agent` indirectly
 * through `./rule-indicator`. No LLM call — surface-only.
 *
 * Default-OFF safe: when the rule indicator is gated OFF
 * (`QUANTA_RULE_INDICATOR=0`) the command still answers; it just paints the
 * empty inventory. Disabling rules in the prompt is a SEPARATE concern owned
 * by the loop (the loop is the writer; this command is the reader).
 */

import {
  buildRuleInventory,
  isRuleIndicatorEnabled,
  type RuleInventory,
  type RuleSource,
  renderRuleList,
  simulatePath,
  stripAnsi,
} from "./rule-indicator"
import type { SlashCommand, SlashContext } from "./slash-commands"

/** Render the short summary form: pill + active list (no inactive rules). */
const renderSummary = (inv: RuleInventory): string => {
  if (inv.totalCount === 0) return "(no rules configured)\n"
  const lines: string[] = []
  lines.push(`rules: ${inv.activeCount}/${inv.totalCount} matched\n`)
  const active = inv.sources.filter((s) => s.active)
  if (active.length > 0) {
    lines.push("matched:\n")
    for (const s of active) {
      lines.push(`  ${s.path}${formatScope(s)}\n`)
    }
  }
  const inactive = inv.totalCount - inv.activeCount
  if (inactive > 0) lines.push(`(${inactive} inactive; use "/rules list" to see all)\n`)
  return lines.join("")
}

/** Compact scope label for the short summary (e.g. ` (glob: src/**\/*.ts)`). */
const formatScope = (s: RuleSource): string => {
  if (s.kind === "global") return ""
  if (s.matchedPattern === "always") return " (always)"
  if (s.matchedPattern !== undefined) return ` (${s.matchedPattern})`
  return ""
}

/** Render the simulation result printed by `/rules path <pattern>`. */
const renderSimulation = (path: string, matched: RuleSource[]): string => {
  const lines: string[] = []
  lines.push(`simulating: ${path}\n`)
  if (matched.length === 0) {
    lines.push("  (no rules match this path)\n")
    return lines.join("")
  }
  lines.push(`  ${matched.length} rule${matched.length === 1 ? "" : "s"} would fire:\n`)
  for (const s of matched) {
    lines.push(`    ✓ ${s.path}${formatScope(s)}\n`)
  }
  return lines.join("")
}

export const rulesCmd: SlashCommand = {
  name: "/rules",
  describe: "Show / inspect repo-local rule files (AGENTS.md / .quanta/rules)",
  category: "config",
  async run(args, ctx: SlashContext) {
    if (!isRuleIndicatorEnabled()) {
      ctx.out("rules: indicator disabled (QUANTA_RULE_INDICATOR=0)\n")
      return 0
    }

    const sub = args[0]

    // /rules path <pattern>
    if (sub === "path") {
      const pat = args[1]
      if (pat === undefined || args.length > 2) {
        ctx.err('/rules: expected exactly one argument after "path"\n')
        return 1
      }
      const inv = await buildRuleInventory({ cwd: ctx.cwd })
      const { path, matched } = await simulatePath(inv, pat)
      ctx.out(stripAnsi(renderSimulation(path, matched)))
      return 0
    }

    // /rules list
    if (sub === "list") {
      if (args.length > 1) {
        ctx.err('/rules: "list" takes no further arguments\n')
        return 1
      }
      const inv = await buildRuleInventory({ cwd: ctx.cwd })
      ctx.out(`${stripAnsi(renderRuleList(inv))}\n`)
      return 0
    }

    // /rules (no args) — short summary
    if (sub === undefined) {
      const inv = await buildRuleInventory({ cwd: ctx.cwd })
      ctx.out(stripAnsi(renderSummary(inv)))
      return 0
    }

    ctx.err(`/rules: unknown sub-command: ${sub}\n`)
    ctx.out("Usage: /rules | /rules list | /rules path <pattern>\n")
    return 1
  },
  complete(args, partial) {
    if (args.length === 0) {
      const subs = ["list", "path"]
      return subs
        .filter((s) => s.startsWith(partial))
        .map((value) => ({ value, kind: "argument" as const }))
    }
    return []
  },
}
