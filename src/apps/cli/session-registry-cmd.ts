/**
 * ADR-0370 + ADR-0374 + ADR-0376 + ADR-0379 + ADR-0384 + ADR-0386 + ADR-0387 —
 * `/session-registry` slash command.
 *
 * Operator visibility (ADR-0370) + targeted eviction (ADR-0374) + sub-command
 * discovery (ADR-0376) + retention sweep (ADR-0379) + evict hygiene (ADR-0384)
 * + bulk-pattern evict (ADR-0386) + cleanup dry-run (ADR-0387) for the
 * `SessionResourceRegistry` slice (ADR-0345 in-memory / ADR-0348 disk /
 * ADR-0361 sqlite). Mirrors Codex's admin habit of running
 * `sqlite3 ~/.codex/logs_2.sqlite 'SELECT COUNT(*), SUM(estimated_bytes)
 * FROM …'` without giving the operator a sql shell, and adds the targeted-
 * `DELETE` that Codex operators do with `sqlite3 logs_2.sqlite 'DELETE FROM
 * sessions WHERE id = …'`.
 *
 * # Subcommands
 *
 *   - `/session-registry` (no args)            — alias for `stats`
 *   - `/session-registry stats`                — print the stats block
 *   - `/session-registry evict <id>`           — force-evict a session by id
 *                                                (ADR-0374 + ADR-0384 hygiene)
 *   - `/session-registry evict --pattern <g>`  — bulk evict matching ids
 *                                                (ADR-0386, glob: `*`+`?`,
 *                                                cap 100)
 *   - `/session-registry cleanup`              — retention sweep (ADR-0379)
 *   - `/session-registry help`                 — sub-command discovery
 *                                                (ADR-0376)
 *
 * # ADR-0384 — evict hygiene message
 *
 * Single-id evict now surfaces a post-evict snapshot (`Sessions:` count
 * + `(irreversible)` warning) so the operator sees the impact and the
 * "no undo" semantics. Pre-evict snapshot is NOT taken (the
 * `inspectGlobalRegistry()` walk is expensive on the sqlite backend);
 * the message is informational rather than a strict diff. The existing
 * `evicted <id>` line is preserved byte-identical for downstream parsers.
 *
 * # ADR-0386 — bulk-pattern evict
 *
 * `evict --pattern <glob>` walks the in-process Map (via the new
 * `listSessionIds()` port method), matches every id against the glob,
 * and force-evicts each match. Safety caps:
 *   - matches > 100 ⇒ refuse with `Too many matches (N)` + exit 1
 *   - matches == 0 ⇒ `No sessions matched <pattern>` + exit 0
 *
 * Glob alphabet: `*` (any chars) + `?` (single char). Every other regex
 * metacharacter is escaped — `evict --pattern "a.b"` only matches the
 * literal id `a.b`, NOT `axb`.
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

import { startAutoSweep } from "@/agent/session-resource-registry/auto-sweep"
import { countDiskRegistryCleanupCandidates } from "@/agent/session-resource-registry/disk-adapter/gc"
import { getGlobalSessionResourceRegistry } from "@/agent/session-resource-registry/global"
import {
  formatRegistryStats,
  inspectGlobalRegistry,
} from "@/agent/session-resource-registry/inspector"
import { countSqliteRegistryCleanupCandidates } from "@/agent/session-resource-registry/sqlite-adapter/gc"
import { errMessage } from "@/shared"
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
  "  stats                   Print backend + sessions/events/bytes (default)",
  "  evict <id>              Force-evict one session by id (idempotent)",
  "  evict --pattern <glob>  Bulk-evict every in-process id matching the glob",
  "                          (`*` and `?` only; max 100 matches; ADR-0386)",
  "  cleanup                 Run an immediate retention sweep + post-sweep stats (ADR-0379)",
  "  cleanup --dry-run       Preview sweep candidates WITHOUT committing (ADR-0387)",
  "  help                    Show this menu",
  "",
  "Backend detect priority (first match wins):",
  "  1. QUANTA_SESSION_REGISTRY_SQLITE_PATH   — sqlite adapter (ADR-0367)",
  "  2. QUANTA_SESSION_REGISTRY_DISK_DIR      — disk adapter (ADR-0351)",
  "  3. (otherwise)                           — in-memory singleton (ADR-0345)",
  "",
  "WAL checkpoint knobs (sqlite adapter, both optional):",
  "  QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES  — escalate beyond PASSIVE when WAL > N (ADR-0375/0390)",
  '  QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE  — "RESTART" (default) | "TRUNCATE" (ADR-0385/0390)',
]

/**
 * ADR-0386 — Safety cap. A glob that matches > 100 in-process sessions
 * is almost certainly an operator typo (`*` typed in a hurry). We refuse
 * the eviction rather than rip through the whole registry. The threshold
 * is informed by typical operator working sets (a single dev/test box
 * rarely holds > 100 live session ids at once; the SQLite backend's
 * default retention is 14 days × ~1 session/dev/day).
 */
const BULK_EVICT_MAX_MATCHES = 100

/**
 * ADR-0386 — Compile a glob pattern (`*`, `?`) into a strict regex.
 *
 * Algorithm:
 *   1. Escape every regex metacharacter EXCEPT `*` and `?` so a pattern
 *      like `"a.b"` matches the literal id `"a.b"` (NOT regex any-char).
 *   2. Replace `*` with `.*` (zero-or-more any-char).
 *   3. Replace `?` with `.`  (exactly-one any-char).
 *   4. Anchor with `^` + `$` so the match is the WHOLE id, not a prefix.
 *
 * Injection safety: the user's pattern is fed into `replace` then wrapped
 * with `^…$` — the only chars that survive untranslated are the literal
 * glob alphabet (`*` + `?`); everything else is regex-escaped. A pattern
 * like `"\.+"`, `"(.*)"`, `"a|b"` produces a regex that matches ONLY the
 * literal characters typed (e.g. `^\.\+$` — matches the literal `.+`).
 */
const globToRegex = (pattern: string): RegExp => {
  // Step 1: escape regex specials EXCEPT * and ? (which we handle next).
  // Set is from the MDN guide for RegExp source escaping.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  // Step 2 + 3: translate the glob alphabet to regex.
  const wild = escaped.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${wild}$`)
}

// `SUBCOMMANDS` doubles as completion source + unknown-subcommand hint.
// Keep alphabetical-ish; the "known one of" stderr message renders the
// SAME ordering for grep-stability across operator log lines.
const SUBCOMMANDS = ["stats", "evict", "cleanup", "help"] as const
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
 * ADR-0374 + ADR-0384 — `evict <id>` handler.
 *
 * Missing id ⇒ usage line on stderr + exit 1 (operator typo, not an
 * inspector failure). Idempotent success ⇒ exit 0 even if `id` was never
 * registered, mirroring the closed-port `evict` contract (ADR-0345
 * §"Idempotent — unknown id ⇒ no-op").
 *
 * ADR-0384 — Post-evict hygiene: emit a multi-line block with the
 * post-evict `Sessions:` count and the literal `(irreversible)` warning
 * so the operator sees the IMPACT + the NO-UNDO semantic. The original
 * `evicted <id>` line is preserved verbatim for downstream parsers
 * (test [7] / [8] / [9] in `session-registry-slash.test.ts`).
 *
 * Hostile implementations or future adapter regressions that throw are
 * swallowed here — the slash itself MUST NOT crash the REPL. Caller
 * sees the error message on stderr + exit 1.
 *
 * Cost: post-evict `inspectGlobalRegistry()` is one inspect-call (sqlite
 * COUNT+SUM / disk fs walk / Map size). NOT taken pre-evict — the diff
 * would double the cost and the operator only needs the post-state.
 */
const renderEvict = async (args: readonly string[], ctx: SlashContext): Promise<number> => {
  const sessionId = args[0]
  if (sessionId === undefined || sessionId.length === 0) {
    ctx.err("/session-registry: usage: /session-registry evict <sessionId>\n")
    return 1
  }
  try {
    getGlobalSessionResourceRegistry().evict(sessionId)
    // ADR-0384 — post-evict hygiene block. Inspector is NO-THROW; the
    // try/catch around the whole evict path catches a registry.evict
    // throw before we get here, so any failure on this read is purely
    // a defence-in-depth fallthrough.
    let postSessions = ""
    try {
      const stats = await inspectGlobalRegistry()
      postSessions = `Sessions: ${stats.sessions}\n`
    } catch {
      // NO-THROW — if inspect somehow fails after a successful evict,
      // we still emit the primary `evicted` line. The hygiene block is
      // informational, not load-bearing.
    }
    ctx.out(`evicted ${sessionId}\n${postSessions}(irreversible)\n`)
    return 0
  } catch (e) {
    ctx.err(`/session-registry: evict failed: ${errMessage(e)}\n`)
    return 1
  }
}

/**
 * ADR-0386 — `evict --pattern <glob>` bulk handler.
 *
 * Algorithm:
 *   1. Read `listSessionIds()` from the live registry (in-process Map).
 *   2. Compile the pattern via `globToRegex` (escape + `*`→`.*` + `?`→`.`).
 *   3. Filter ids by `regex.test(id)`.
 *   4. Safety: 0 matches ⇒ `No sessions matched` + exit 0;
 *               > BULK_EVICT_MAX_MATCHES ⇒ refuse + exit 1.
 *   5. Loop `registry.evict(id)` for each match. NO-THROW: a hostile
 *      evict aborts the loop with the partial count + exit 1.
 *
 * The summary line carries the eviction count so downstream tooling
 * can grep. Pattern is echoed in the output for log clarity.
 */
const renderBulkEvict = async (pattern: string, ctx: SlashContext): Promise<number> => {
  const registry = getGlobalSessionResourceRegistry()
  let regex: RegExp
  try {
    regex = globToRegex(pattern)
  } catch (e) {
    // globToRegex can throw on a pathological pattern (e.g. an unpaired
    // surrogate); the NO-THROW guarantee is on the slash, not the helper.
    ctx.err(`/session-registry: invalid pattern: ${errMessage(e)}\n`)
    return 1
  }
  let ids: readonly string[] = []
  try {
    ids = registry.listSessionIds()
  } catch {
    // NO-THROW: a failure here ⇒ empty matches; surfaced as "no matches".
    ids = []
  }
  const matches: string[] = []
  for (const id of ids) {
    if (regex.test(id)) matches.push(id)
  }
  if (matches.length === 0) {
    ctx.out(`No sessions matched ${pattern}\n`)
    return 0
  }
  if (matches.length > BULK_EVICT_MAX_MATCHES) {
    ctx.err(
      `/session-registry: Too many matches (${matches.length} > ${BULK_EVICT_MAX_MATCHES}). Refine the pattern or use 'evict <id>' per session.\n`,
    )
    return 1
  }
  let evictedCount = 0
  try {
    for (const id of matches) {
      registry.evict(id)
      evictedCount += 1
    }
    ctx.out(`evicted ${evictedCount} sessions matching ${pattern}\n(irreversible)\n`)
    return 0
  } catch (e) {
    ctx.err(
      `/session-registry: bulk evict aborted after ${evictedCount}/${matches.length}: ${errMessage(e)}\n`,
    )
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
    if (sub === "evict") {
      // ADR-0386 — `evict --pattern <glob>` dispatch.
      // `--pattern` MAY be the first or any subsequent arg; we look at
      // arg[1] (the first sub-arg of `evict`) for grep stability with
      // shell habit (`/session-registry evict --pattern "test-*"`).
      const sub1 = args[1]
      if (sub1 === "--pattern") {
        const pattern = args[2]
        if (pattern === undefined || pattern.length === 0) {
          ctx.err("/session-registry: usage: /session-registry evict --pattern <glob>\n")
          return 1
        }
        return renderBulkEvict(pattern, ctx)
      }
      return renderEvict(args.slice(1), ctx)
    }
    if (sub === "cleanup") {
      const subArgs = args.slice(1)
      // ADR-0387 — `--dry-run` flag preview mode. Any position in the
      // sub-args list counts; extra unrelated flags are ignored.
      if (subArgs.includes("--dry-run")) return renderCleanupDryRun(ctx)
      return renderCleanup(ctx)
    }
    return renderStats(ctx)
  },
}

/**
 * ADR-0379 — `/session-registry cleanup` handler.
 *
 * Runs an immediate sweep via `startAutoSweep().sweepNow()` then stops
 * the returned handle so we do NOT leak a periodic timer registered by
 * this slash invocation. Env-var detection (sqlite > disk > none) is
 * delegated to `startAutoSweep`; an unset registry env ⇒ NOOP handle ⇒
 * the sweep is a fast no-op + we still render the current stats.
 *
 * The sweep is fire-and-await so the operator sees the post-sweep
 * stats (events evicted, WAL bytes, etc.) in the rendered output.
 * NO-THROW: any failure short-circuits to "cleanup failed" + exit 1
 * (operator explicitly requested the mutation; surface the failure).
 */
const renderCleanup = async (ctx: SlashContext): Promise<number> => {
  let handle: ReturnType<typeof startAutoSweep> | undefined
  try {
    handle = startAutoSweep()
    await handle.sweepNow()
    // Render post-sweep stats so the operator sees what changed.
    const stats = await inspectGlobalRegistry()
    ctx.out(`${formatRegistryStats(stats)}\nSweep complete.\n`)
    return 0
  } catch (e) {
    ctx.err(`/session-registry: cleanup failed: ${errMessage(e)}\n`)
    return 1
  } finally {
    // CRITICAL: stop() unregisters the periodic timer registered by
    // `startAutoSweep` so the slash does not leak a setInterval per
    // invocation. NO-THROW + idempotent (per ADR-0369).
    handle?.stop()
  }
}

/**
 * ADR-0387 — `cleanup --dry-run` handler.
 *
 * Preview the sweep candidate counts WITHOUT committing the eviction.
 * Calls the leaf `count*RegistryCleanupCandidates` functions for whichever
 * backends are configured via the same env vars `startAutoSweep` consults:
 *
 *   - `QUANTA_SESSION_REGISTRY_DISK_DIR`    — disk backend candidates
 *   - `QUANTA_SESSION_REGISTRY_SQLITE_PATH` — sqlite backend candidates
 *
 * Neither env set ⇒ output reports "no backend configured" + exit 0 (the
 * in-memory adapter never accumulates on-disk debt — there is nothing to
 * preview).
 *
 * The count functions are NO-THROW + idempotent; this handler wraps the
 * top-level call defensively so a regression cannot crash the REPL.
 * On failure, exit 1 + render the error on stderr (operator explicitly
 * requested the preview).
 */
const renderCleanupDryRun = async (ctx: SlashContext): Promise<number> => {
  try {
    const diskDir = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
    const sqlitePath = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH

    const lines: string[] = ["## Session Registry — Dry-run", ""]

    if (diskDir === undefined && sqlitePath === undefined) {
      lines.push("Dry-run: no on-disk backend configured (in-memory only — nothing to preview).")
      ctx.out(`${lines.join("\n")}\n`)
      return 0
    }

    if (typeof diskDir === "string" && diskDir.length > 0) {
      const disk = await countDiskRegistryCleanupCandidates({ storageDir: diskDir })
      lines.push(
        `Dry-run: disk backend (${disk.storageDir})`,
        `  would evict by TTL:    ${disk.wouldEvictByTtl}`,
        `  would evict by size:   ${disk.wouldEvictBySize}`,
        `  inspected sessions:    ${disk.inspectedSessions}`,
        "",
      )
    }

    if (typeof sqlitePath === "string" && sqlitePath.length > 0) {
      const sqlite = countSqliteRegistryCleanupCandidates({ databasePath: sqlitePath })
      lines.push(
        `Dry-run: sqlite backend (${sqlitePath})`,
        `  would evict by TTL:    ${sqlite.wouldEvictByTtl}`,
        `  would evict by size:   ${sqlite.wouldEvictBySize}`,
        `  inspected sessions:    ${sqlite.inspectedSessions}`,
        `  WAL size (bytes):      ${sqlite.walSize}`,
        "",
      )
    }

    lines.push("(no commit — re-run without --dry-run to apply)")
    ctx.out(`${lines.join("\n")}\n`)
    return 0
  } catch (e) {
    ctx.err(`/session-registry: cleanup --dry-run failed: ${errMessage(e)}\n`)
    return 1
  }
}
