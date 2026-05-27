/**
 * ADR-0370 + ADR-0374 + ADR-0376 — `/session-registry` slash command.
 *
 * Operator visibility (ADR-0370) + targeted eviction (ADR-0374) + sub-command
 * discovery (ADR-0376) for the `SessionResourceRegistry` slice
 * (ADR-0345 in-memory / ADR-0348 disk / ADR-0361 sqlite). Mirrors
 * Codex's admin habit of running `sqlite3 ~/.codex/logs_2.sqlite
 * 'SELECT COUNT(*), SUM(estimated_bytes) FROM …'` without giving
 * the operator a sql shell, and adds the targeted-`DELETE` that
 * Codex operators do with `sqlite3 logs_2.sqlite 'DELETE FROM
 * sessions WHERE id = …'`.
 *
 * # Subcommands
 *
 *   - `/session-registry` (no args)        — alias for `stats`
 *   - `/session-registry stats`            — print the stats block
 *   - `/session-registry evict <id>`       — force-evict a session by id
 *                                            (ADR-0374; idempotent per
 *                                            ADR-0345 closed-port contract)
 *   - `/session-registry help`             — sub-command discovery
 *                                            (ADR-0376)
 *
 * Further write subcommands (`clear`, `vacuum`) remain OUT OF SCOPE — they
 * require a separate mutation-policy ADR (bulk drop is a foot-gun without
 * a confirm gesture). `evict <id>` is admissible because it is per-id and
 * operator-explicit — the operator has already typed the id.
 *
 * # NO-THROW
 *
 * The inspector (see `@/agent/session-resource-registry/inspector`)
 * is itself NO-THROW; this command wraps each invocation in a
 * defence-in-depth try/catch so a regression there cannot crash the
 * REPL. The port-spec'd `evict` is ALSO NO-THROW (ADR-0345), but a
 * hostile implementation (or a future adapter regression) could throw —
 * the slash wraps it in try/catch and renders the error message on
 * stderr + exit 1. On `stats` failure we render "unavailable" and exit 0
 * (an operator stats call is informational); on `evict` failure exit 1
 * because the operator explicitly asked for the mutation.
 */

import { getGlobalSessionResourceRegistry } from "@/agent/session-resource-registry/global"
import {
  formatRegistryStats,
  inspectGlobalRegistry,
} from "@/agent/session-resource-registry/inspector"
import type { SlashCommand, SlashContext } from "./slash-commands"

/**
 * Help block (ADR-0376). Renders every sub-command + the backend-detect
 * priority chain so operators do not have to read the ADR to know which
 * env var wins. The chain mirrors `global.ts` precedence exactly; if
 * ADR-0367 / ADR-0361 ever reorder it this block must be updated in
 * lockstep (no central source of truth — each surface owns its own help
 * copy by repo convention).
 */
const HELP_LINES: readonly string[] = [
  "## /session-registry — Operator surface for session registry",
  "",
  "Sub-commands:",
  "  stats         Print backend + sessions/events/bytes (default)",
  "  evict <id>    Force-evict one session by id (idempotent)",
  "  help          Show this menu",
  "",
  "Backend detect priority (first match wins):",
  "  1. QUANTA_SESSION_REGISTRY_SQLITE_PATH   — sqlite adapter (ADR-0367)",
  "  2. QUANTA_SESSION_REGISTRY_DISK_DIR      — disk adapter (ADR-0351)",
  "  3. (otherwise)                           — in-memory singleton (ADR-0345)",
]

// `SUBCOMMANDS` doubles as completion source + unknown-subcommand hint.
// Keep alphabetical-ish; the "known one of" stderr message renders the
// SAME ordering for grep-stability across operator log lines.
const SUBCOMMANDS = ["stats", "evict", "help"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
const isSubcommand = (s: string): s is Subcommand => (SUBCOMMANDS as readonly string[]).includes(s)

const errMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

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
 * ADR-0374 — `evict <id>` handler.
 *
 * Missing id ⇒ usage line on stderr + exit 1 (operator typo, not an
 * inspector failure). Idempotent success ⇒ exit 0 even if `id` was never
 * registered, mirroring the closed-port `evict` contract (ADR-0345
 * §"Idempotent — unknown id ⇒ no-op").
 *
 * Hostile implementations or future adapter regressions that throw are
 * swallowed here — the slash itself MUST NOT crash the REPL. Caller
 * sees the error message on stderr + exit 1.
 *
 * Extra args after `<id>` are intentionally ignored: a future
 * `evict <id1> <id2> …` bulk form would invert exit-code semantics
 * (partial failure handling); we keep the contract simple by anchoring
 * on the single-id form and rejecting bulk at the ADR level.
 */
const renderEvict = (args: readonly string[], ctx: SlashContext): number => {
  const sessionId = args[0]
  if (sessionId === undefined || sessionId.length === 0) {
    ctx.err("/session-registry: usage: /session-registry evict <sessionId>\n")
    return 1
  }
  try {
    getGlobalSessionResourceRegistry().evict(sessionId)
    ctx.out(`evicted ${sessionId}\n`)
    return 0
  } catch (e) {
    ctx.err(`/session-registry: evict failed: ${errMessage(e)}\n`)
    return 1
  }
}

/**
 * `/session-registry` slash command. Default subcommand is `stats`.
 * `category: "other"` because the registry sits below the user-
 * facing surface — operator-only.
 */
export const sessionRegistryCmd: SlashCommand = {
  name: "/session-registry",
  category: "other",
  describe: "Show / mutate session-resource-registry (operator visibility)",
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
    if (sub === "evict") return renderEvict(args.slice(1), ctx)
    return renderStats(ctx)
  },
}
