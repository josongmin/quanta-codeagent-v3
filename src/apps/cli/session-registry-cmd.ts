/**
 * ADR-0370 — `/session-registry stats` slash command.
 *
 * Operator visibility for the `SessionResourceRegistry` slice
 * (ADR-0345 in-memory / ADR-0348 disk / ADR-0361 sqlite). Mirrors
 * Codex's admin habit of running `sqlite3 ~/.codex/logs_2.sqlite
 * 'SELECT COUNT(*), SUM(estimated_bytes) FROM …'` without giving
 * the operator a sql shell.
 *
 * # Subcommands
 *
 *   - `/session-registry` (no args)        — alias for `stats`
 *   - `/session-registry stats`            — print the stats block
 *   - `/session-registry help`             — short help
 *
 * Future write subcommands (`evict <id>`, `clear`, `vacuum`) are
 * intentionally OUT OF SCOPE for this ADR — they require a separate
 * mutation-policy ADR (the closed port's `evict` / `clear` is
 * deliberately not exposed through a slash because an operator
 * typo dropping a hot session is a foot-gun without a confirm
 * gesture).
 *
 * # NO-THROW
 *
 * The inspector (see `@/agent/session-resource-registry/inspector`)
 * is itself NO-THROW; this command wraps each invocation in a
 * defence-in-depth try/catch so a regression there cannot crash the
 * REPL. On any failure we render "unavailable" and exit 0 (an
 * operator stats call is informational — non-zero exit would
 * misleadingly suggest the registry itself is wedged).
 */

import {
  formatRegistryStats,
  inspectGlobalRegistry,
} from "@/agent/session-resource-registry/inspector"
import type { SlashCommand, SlashContext } from "./slash-commands"

const HELP_LINES: readonly string[] = [
  "/session-registry          — alias for `/session-registry stats`",
  "/session-registry stats    — print backend + sessions/events/bytes",
  "/session-registry help     — this menu",
]

const SUBCOMMANDS = ["stats", "help"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
const isSubcommand = (s: string): s is Subcommand => (SUBCOMMANDS as readonly string[]).includes(s)

const renderStats = async (ctx: SlashContext): Promise<number> => {
  try {
    const stats = await inspectGlobalRegistry()
    ctx.out(formatRegistryStats(stats))
    return 0
  } catch {
    // Defence-in-depth: the inspector is NO-THROW but a future
    // regression must not crash the REPL. Render an unambiguous
    // "unavailable" line and exit 0 (informational).
    ctx.out("## Session Registry — unavailable\n\n(inspect call failed)\n")
    return 0
  }
}

const renderHelp = (ctx: SlashContext): number => {
  ctx.out(`${HELP_LINES.join("\n")}\n`)
  return 0
}

/**
 * `/session-registry` slash command. Default subcommand is `stats`.
 * `category: "other"` because the registry sits below the user-
 * facing surface — operator-only.
 */
export const sessionRegistryCmd: SlashCommand = {
  name: "/session-registry",
  category: "other",
  describe: "Show session-resource-registry stats (operator visibility)",
  complete(args, partial) {
    if (args.length === 0) {
      return SUBCOMMANDS.filter((s) => s.startsWith(partial)).map((value) => ({
        value,
        kind: "argument" as const,
      }))
    }
    return []
  },
  async run(args, ctx) {
    const sub = args[0] ?? "stats"
    if (!isSubcommand(sub)) {
      ctx.err(
        `/session-registry: unknown subcommand: ${sub} (use one of ${SUBCOMMANDS.join(", ")})\n`,
      )
      return 1
    }
    if (sub === "help") return renderHelp(ctx)
    return renderStats(ctx)
  },
}
