/**
 * CLI surface adapter — `session import` handler factory.
 *
 * Wires the migration translator into the surface-agnostic
 * `@/runner/session-ops` slice via `SessionCommandDeps#importHandler`. The
 * runner slice is FORBIDDEN from importing `@/migration` (slice isolation,
 * ADR-0038), so the CLI surface injects this handler at the call site.
 *
 * Extracted from the now-deleted `src/apps/cli/session-commands.ts` shim
 * (CLI-05, ADR-0305). Body is verbatim — behavior is byte-identical for
 * existing callers.
 */
import { homedir } from "node:os"
import {
  appendImportLog,
  type ExternalAgentProvider,
  type ImportEvent,
  type ImportLog,
  loadImportLog,
  runImport,
  type TranslatedSession,
  wasAlreadyImported,
} from "@/migration"
import type { SessionCommandDeps } from "@/runner/session-ops"
import {
  type SessionMeta,
  type SessionRootProvider,
  saveSessionById,
  staticSessionRootProvider,
} from "@/session"
import { errMessage } from "@/shared"

/** Concrete (non-optional) shape of the runner's optional importHandler.
 *  We export this so factory consumers get a non-undefined type — the
 *  runner field is `(...) => Promise<number> | undefined`, but the factory
 *  always returns a callable. */
type ImportHandlerFn = (args: string[], deps: SessionCommandDeps) => Promise<number>

/** Slug a source transcript path into a deterministic, filesystem-safe v3
 *  session id. The provider + sourcePath uniquely identify an imported
 *  session, and the hash keeps the id short + collision-resistant while the
 *  human-readable provider prefix aids `session ls`. */
const importedSessionId = (provider: ExternalAgentProvider, contentHash: string): string =>
  `import-${provider}-${contentHash.slice(0, 16)}`

/** Persist one translated session into the v3 session store. Returns the
 *  minted id. The transcript becomes a resumable quanta session: it lands as
 *  an active `<root>/<id>.json` snapshot + index row, exactly like a
 *  natively-created session, so `session ls` / `session show` / resume all
 *  work on it. */
const persistTranslatedSession = async (
  provider: ExternalAgentProvider,
  session: TranslatedSession,
  now: number,
  rootProvider: SessionRootProvider | undefined,
): Promise<string> => {
  const id = importedSessionId(provider, session.contentHash)
  const meta: SessionMeta = {
    id,
    title: `imported: ${provider} ${session.contentHash.slice(0, 8)}`,
    cwd: process.cwd(),
    createdAt: now,
    lastTouched: now,
    archived: false,
  }
  await saveSessionById(
    meta,
    {
      reason: `imported from ${provider} (${session.sourcePath})`,
      turns: 0,
      messages: [...session.messages],
    },
    rootProvider,
  )
  return id
}

/** Providers the `import` subcommand accepts. `unknown` is intentionally
 *  excluded — it is a typed sentinel, never a user-supplied value. */
const IMPORT_PROVIDERS: readonly Exclude<ExternalAgentProvider, "unknown">[] = [
  "claude_code",
  "cursor",
  "aider",
]

const hasFlag = (args: string[], flag: string): boolean => args.includes(flag)
const errLine = (verb: string, reason: string): string => `session ${verb}: ${reason}\n`

/** Parse the import args: one positional `<provider>` + `--no-skills` flag.
 *  Returns the provider (or an error code already emitted to `deps.err`). */
const parseImportArgs = (
  args: string[],
  deps: SessionCommandDeps,
):
  | { ok: true; provider: Exclude<ExternalAgentProvider, "unknown">; includeSkills: boolean }
  | {
      ok: false
      code: number
    } => {
  const allowedBool = new Set(["--no-skills"])
  let positional = 0
  for (const a of args) {
    if (allowedBool.has(a)) continue
    if (a.startsWith("--")) {
      deps.err(errLine("import", `unexpected argument: ${a}`))
      return { ok: false, code: 1 }
    }
    if (positional < 1) {
      positional += 1
      continue
    }
    deps.err(errLine("import", `unexpected argument: ${a}`))
    return { ok: false, code: 1 }
  }

  const provider = args.find((a) => !a.startsWith("--"))
  if (provider === undefined) {
    deps.err(errLine("import", "missing <provider> (claude_code | cursor | aider)"))
    return { ok: false, code: 1 }
  }
  if (!IMPORT_PROVIDERS.includes(provider as Exclude<ExternalAgentProvider, "unknown">)) {
    deps.err(
      errLine("import", `unknown provider: ${provider} (expected claude_code | cursor | aider)`),
    )
    return { ok: false, code: 1 }
  }
  return {
    ok: true,
    provider: provider as Exclude<ExternalAgentProvider, "unknown">,
    includeSkills: !hasFlag(args, "--no-skills"),
  }
}

/** Result of the persist loop: how many sessions landed + how many were
 *  skipped as already-imported duplicates. */
interface PersistTally {
  readonly persisted: number
  readonly skippedDup: number
}

/** Append a per-session dedup row to the on-disk log AND return the updated
 *  in-memory log so a duplicate WITHIN the same run also dedups. */
const recordPersistedRow = async (
  home: string,
  provider: Exclude<ExternalAgentProvider, "unknown">,
  session: TranslatedSession,
  log: ImportLog,
): Promise<ImportLog> => {
  const row = {
    timestamp: new Date().toISOString(),
    provider,
    stage: "session_completion_finished" as const,
    ok: true,
    detail: `persisted_session source=${session.sourcePath}`,
    contentHash: session.contentHash,
    itemKind: "session" as const,
  }
  await appendImportLog(home, row)
  return { version: 1, entries: [...log.entries, row] }
}

/** Persist every translated session that has not already been imported.
 *  ADR-0430: dedup is by content hash against the persisted import log. A
 *  per-session persist failure is surfaced (warning) but does not abort the
 *  loop — the rest still import. */
const persistAllSessions = async (
  home: string,
  provider: Exclude<ExternalAgentProvider, "unknown">,
  sessions: readonly TranslatedSession[],
  rootProvider: SessionRootProvider | undefined,
  err: (s: string) => void,
): Promise<PersistTally> => {
  let log: ImportLog
  try {
    log = await loadImportLog(home)
  } catch {
    log = { version: 1, entries: [] }
  }
  const now = Date.now()
  let persisted = 0
  let skippedDup = 0
  for (const session of sessions) {
    if (wasAlreadyImported(log, "session", session.contentHash)) {
      skippedDup += 1
      continue
    }
    try {
      await persistTranslatedSession(provider, session, now, rootProvider)
      persisted += 1
      log = await recordPersistedRow(home, provider, session, log)
    } catch (e) {
      err(`session import: warning: failed to persist a session: ${errMessage(e)}\n`)
    }
  }
  return { persisted, skippedDup }
}

/** CLI `session import` handler body, closed over an optional session-root
 *  provider (injected by tests for isolation; production passes none → the
 *  runtime-config-resolved `~/.quanta/sessions` root). */
const makeHandler =
  (rootProvider: SessionRootProvider | undefined): ImportHandlerFn =>
  async (args, deps) => {
    const parsed = parseImportArgs(args, deps)
    if (!parsed.ok) return parsed.code
    const { provider, includeSkills } = parsed
    const home = deps.homeDir ?? homedir()

    const events: ImportEvent[] = []
    const result = await runImport(provider, { homeDir: home, includeSkills }, (e) =>
      events.push(e),
    )
    const ok = result.errors.length === 0

    // ADR-0430: persist each translated transcript into the v3 session store,
    // skipping any whose content hash was already imported (dedup). The persist
    // loop only runs when the translation scan succeeded.
    const { persisted, skippedDup } = ok
      ? await persistAllSessions(home, provider, result.sessions, rootProvider, deps.err)
      : { persisted: 0, skippedDup: 0 }

    // Record the run-summary audit row (best-effort; a busy-lock or write error
    // is surfaced but does not change the exit code).
    try {
      await appendImportLog(home, {
        timestamp: new Date().toISOString(),
        provider: result.provider,
        stage: "import_finished",
        ok,
        detail:
          `translated_sessions=${result.sessionsTranslated}, ` +
          `counted_skills=${result.skillsCounted}, persisted_sessions=${persisted}, ` +
          `skipped_duplicates=${skippedDup}, mcp_servers=${result.mcpServers.length}, ` +
          `hooks=${result.hooks.length}, rules=${result.rules.length}`,
      })
    } catch (e) {
      deps.err(`session import: warning: failed to write import log: ${errMessage(e)}\n`)
    }

    if (!ok) {
      deps.err(errLine("import", `failed: ${result.errors.join("; ")}`))
      return 1
    }
    deps.out(
      `imported ${result.provider}: ${persisted} session(s) persisted` +
        (skippedDup > 0 ? ` (${skippedDup} duplicate(s) skipped)` : "") +
        `, ${result.skillsCounted} skill file(s), ${result.mcpServers.length} MCP server(s), ` +
        `${result.hooks.length} hook(s), ${result.rules.length} rule doc(s)\n`,
    )
    return 0
  }

/** Factory — returns the CLI `session import` handler ready to be injected
 *  into `SessionCommandDeps#importHandler`. The return type is the concrete
 *  callable (not the runner's optional alias) so callers can assign it
 *  under `exactOptionalPropertyTypes: true` without `| undefined` leakage.
 *
 *  `rootProvider` is an optional injection seam for tests (point persistence
 *  at a tmp session root); production omits it and the store resolves the
 *  default `~/.quanta/sessions` root from runtime config — byte-identical to
 *  every other native session.
 *
 *  Callers (`repl.ts`, tests) just write
 *  `importHandler: createCliImportHandler()`. */
export const createCliImportHandler = (rootProvider?: SessionRootProvider): ImportHandlerFn =>
  makeHandler(rootProvider)

/** Test seam: a static-root variant so the e2e battery can point persistence
 *  at a tmp dir without mutating global runtime config. */
export const createCliImportHandlerWithRoot = (sessionsRoot: string): ImportHandlerFn =>
  makeHandler(staticSessionRootProvider(sessionsRoot))
