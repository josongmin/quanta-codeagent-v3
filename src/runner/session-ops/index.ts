import type { ActivityStore } from "@/activity"
import type { Message } from "@/llm"
import { runShell } from "@/runtime/shell"
import { isGitRepo } from "@/runtime/worktree"
import {
  createPersistentWorktree,
  removeWorktree,
  WorktreeForkError,
} from "@/runtime/worktree-fork"
import { listSessions } from "@/session/index-store"
import { archivedFilePath, SessionIdError, sessionFilePath } from "@/session/paths"
import {
  archiveSession,
  deleteSession,
  forkSession,
  loadSessionById,
  renameSession,
  rewindToMessage,
  saveSessionById,
  unarchiveSession,
} from "@/session/store"
import type { SessionMeta, WorkspaceOwnership } from "@/session/types"
import { makeWorkspaceCreateIntent, transitionWorkspaceState } from "@/session/workspace-ownership"
import { errMessage } from "@/shared/errors"
import {
  applyListPipeline,
  buildSessionListEntries,
  renderSessionList,
  type SessionListOptions,
} from "./list-tui"
import { renderActivityTo, runWorktreeTransitionWithProgress } from "./worktree/live-progress"
import {
  applyWorktreeGc,
  collectOwnedWorktrees,
  type GcCandidate,
  type GcPlan,
  planWorktreeGc,
} from "./worktree-gc"

/**
 * `quanta session …` subcommand dispatcher.
 *
 * Pure-ish: all stdout/stderr writes route through injected `out`/`err`
 * writers, and the interactive confirm prompt is injected so tests can mock
 * it without spawning a binary or attaching a real readline interface. The
 * function returns a numeric exit code (0 = success, 1 = error) — the
 * caller (`index.ts`) maps that into `process.exit(...)`.
 *
 * No top-level CLI behavior runs through here unless `argv[2] === "session"`;
 * when it is, this dispatcher fully owns the run (no fall-through to the
 * REPL / agent path). When it isn't, none of this code executes — that is
 * how the byte-identical default-OFF posture is preserved.
 *
 * Surface-agnostic slice (`@/runner/session-ops`): every effect goes through an
 * injected port. The `import` subcommand depends on `@/migration`, which the
 * `@/runner` slice cannot reach directly (slice isolation, RFC 3.1) — so the
 * caller wires it in as `deps.importHandler`. When the handler is absent the
 * subcommand fails fast with an explicit error (so a misconfigured embedding
 * cannot silently skip the migration step).
 */
/** Typed config the CLI/Web/Tauri surface hands the `list` subcommand.
 *  All fields are optional — the runner slice never reads `process.env`
 *  or `process.stdout.isTTY` itself (architecture guard, RFC may-22 §X).
 *  The surface entry (apps/cli/session-commands.ts) resolves these from
 *  the host runtime and passes them in. */
export interface SessionListEnv {
  /** Default format when no explicit `--format` / `--legacy` flag is
   *  given. Surface should pick `"rich"` for interactive TTY, `"plain"`
   *  for pipes/redirects/tests. */
  defaultFormat?: "rich" | "plain"
  /** Default cap for the rich-format `--last <N>` window when the flag
   *  is absent. Plain format stays uncapped. Defaults to 10 inside the
   *  dispatcher when this field is undefined. */
  defaultMaxN?: number
}

export interface SessionCommandDeps {
  out: (s: string) => void
  err: (s: string) => void
  /** Interactive confirm. Resolves to `true` only on an explicit yes. */
  confirm: (prompt: string) => Promise<boolean>
  /** Home directory to scan for external-agent installs (`import` subcommand).
   *  Injectable so tests can point at a tmp home; defaults to `os.homedir()`. */
  homeDir?: string
  /** Optional handler for the `import` subcommand. Injected by the CLI surface
   *  (apps/cli) so the surface-agnostic `@/runner/session-ops` slice does not
   *  reach into `@/migration` (forbidden by the runner slice's biome rule).
   *  Receives the args AFTER `import` and the full deps for io. */
  importHandler?: (args: string[], deps: SessionCommandDeps) => Promise<number>
  /** Surface-injected env for the `list` subcommand TUI. When absent the
   *  dispatcher falls back to safe defaults (plain format, cap=10) — so
   *  callers that never set this keep the byte-identical legacy output. */
  listEnv?: SessionListEnv
  /** RFC-06 §RFC06-3 — the repo root the `worktree-gc` subcommand operates on
   *  (the surface injects `process.cwd()`; the runner slice never reads it
   *  directly). Absent ⇒ `worktree-gc` requires an explicit `--repo <path>`. */
  cwd?: string
  /** RFC02-5 / RFC06-2 — the observability spine the `worktree` subcommand emits
   *  the correlated transition onto (the surface injects a live
   *  {@link ActivityStore}). Absent ⇒ the transition runs WITHOUT emitting
   *  activity (byte-identical to the pre-RFC02-5 path) but the subcommand still
   *  functions; when present the surface renders the resulting activity state. */
  activityStore?: ActivityStore
  /** RFC-04 D4 — live staged worktree progress. Resolved ONCE at the composition
   *  root from `QUANTA_WORKTREE_PROGRESS` (default OFF) and threaded in (the
   *  runner slice never reads env). When `true` AND a store is wired, the
   *  `worktree` command emits staged `workspace`/`checkout` children AND
   *  subscribes BEFORE the transition so each stage renders PRE-completion.
   *  Absent/false ⇒ byte-identical single coarse node + single final render. */
  worktreeProgress?: boolean
}

/** Render a single message's content as a single line of joined text. */
const renderContent = (msg: Message): string => {
  const parts: string[] = []
  for (const block of msg.content) {
    if (block.type === "text") {
      const t = block.text.trim()
      if (t !== "") parts.push(t)
    } else if (block.type === "tool_use") {
      parts.push(`<tool_use ${block.name}>`)
    } else if (block.type === "tool_result") {
      parts.push("<tool_result>")
    }
  }
  return parts.join(" ")
}

const usage = (): string =>
  [
    "Usage: quanta session <command> [args]",
    "",
    "Commands:",
    "  ls [--archived] [--json] [--ids]    list sessions",
    "     [--format <rich|plain>] [--legacy]",
    "     [--cwd <substr>] [--branch <name>]",
    "     [--last <N>] [--sort <recent|title|size>]",
    "  show <id> [--json]                  print transcript (or full JSON)",
    "  rename <id> <new-title>             rename a session",
    "  archive <id>                        archive a session",
    "  unarchive <id>                      unarchive a session",
    "  fork <id> [--title <t>] [--worktree] copy transcript to a new id",
    "  rewind <id> <msg-id>                truncate transcript after msg-id",
    "  delete <id> [--force]               remove session file + index entry",
    "  path <id>                           print absolute file path",
    "  import <provider>                   import sessions from an external agent",
    "                                       (provider: claude_code | cursor | aider)",
    "  worktree <id> [--branch <name>]     switch a thread into an isolated worktree",
    "  worktree-gc [--repo <path>] [--apply]  dry-run / apply owned-worktree GC",
    "",
  ].join("\n")

/** Read a `--<flag> <value>` pair out of `args`. Returns `undefined` if absent. */
const readValueFlag = (args: string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag)
  if (idx < 0) return undefined
  const v = args[idx + 1]
  return typeof v === "string" ? v : undefined
}

const hasFlag = (args: string[], flag: string): boolean => args.includes(flag)

/** MEDIUM-8: after a subcommand has consumed its known positional + flag
 *  tokens, anything left over is a typo. Emit a clear error and signal exit-1.
 *  `expectedPositional` is the number of positional args the subcommand
 *  expected (e.g. `rename` expects 2: id + title). `valueFlags` are the
 *  `--flag <value>` pairs the subcommand consumes. Boolean flags are listed
 *  in `boolFlags` and consumed by-name. Returns the unknown token or
 *  `undefined` when args are clean. */
const checkUnknownArgs = (
  args: string[],
  expectedPositional: number,
  boolFlags: readonly string[],
  valueFlags: readonly string[],
): string | undefined => {
  const consumed = new Set<number>()
  let positionalCount = 0
  for (let i = 0; i < args.length; i++) {
    if (consumed.has(i)) continue
    const a = args[i] as string
    if (boolFlags.includes(a)) {
      consumed.add(i)
      continue
    }
    if (valueFlags.includes(a)) {
      consumed.add(i)
      consumed.add(i + 1)
      continue
    }
    // positional (or unexpected when over the budget)
    if (positionalCount < expectedPositional) {
      positionalCount += 1
      consumed.add(i)
      continue
    }
    return a
  }
  return undefined
}

/** Standardized error preamble: `session <verb>: <reason>`. */
const errLine = (verb: string, reason: string): string => `session ${verb}: ${reason}\n`

/** Resolve the effective render format from flags + surface-injected env.
 *  Priority: `--legacy` > `--format <v>` > `listEnv.defaultFormat` >
 *  `"plain"` (safe default so a non-CLI surface that forgets to wire
 *  TTY detection still produces parseable output).
 *
 *  The runner slice does NOT read `process.env` / `process.stdout.isTTY`
 *  itself — the surface entry (apps/cli/session-commands.ts) maps those
 *  into `SessionListEnv` and injects via `deps.listEnv`. */
const pickFormat = (args: string[], env: SessionListEnv | undefined): "rich" | "plain" => {
  if (hasFlag(args, "--legacy")) return "plain"
  const formatFlag = readValueFlag(args, "--format")
  if (formatFlag === "plain" || formatFlag === "rich") return formatFlag
  return env?.defaultFormat ?? "plain"
}

/** Parse + validate the `--sort` flag. Throws when invalid so the dispatcher
 *  surfaces a clean `session ls: …` error line. Returns `undefined` when
 *  the flag is absent (signal to use the default). */
const pickSortBy = (args: string[]): SessionListOptions["sortBy"] => {
  const sortRaw = readValueFlag(args, "--sort")
  if (sortRaw === undefined) return undefined
  if (sortRaw === "title" || sortRaw === "size" || sortRaw === "recent") return sortRaw
  throw new Error(`invalid --sort value: ${sortRaw} (expected recent|title|size)`)
}

/** Emit the legacy empty-state line + the `--archived` hint when the
 *  active list is empty but archived sessions exist. Extracted from
 *  `cmdLs` to keep its cyclomatic complexity below the biome ceiling. */
const emitEmptyStateHint = async (
  deps: SessionCommandDeps,
  includeArchived: boolean,
): Promise<void> => {
  if (!includeArchived) {
    const all = await listSessions({ includeArchived: true })
    if (all.length > 0) {
      deps.out("(no sessions) (use --archived to see archived)\n")
      return
    }
  }
  deps.out("(no sessions)\n")
}

/** Parse `--last <N>`; falls back to the default cap when absent in rich
 *  format (plain format stays uncapped — pipeline-friendly). The default
 *  cap is taken from the surface-injected `listEnv.defaultMaxN` so the
 *  runner slice never reads env directly (architecture guard). */
const pickLastN = (
  args: string[],
  format: "rich" | "plain",
  env: SessionListEnv | undefined,
): { lastN?: number; error?: string } => {
  const lastRaw = readValueFlag(args, "--last")
  if (typeof lastRaw === "string") {
    const n = Number.parseInt(lastRaw, 10)
    if (!Number.isFinite(n) || n <= 0) return { error: `invalid --last value: ${lastRaw}` }
    return { lastN: n }
  }
  if (format !== "rich") return {}
  return { lastN: env?.defaultMaxN ?? 10 }
}

/** UUX-4-10 — per-session turn counts for the rich list view. `list-tui`
 *  renders the `N turns` column (and `--sort size` orders by it) whenever
 *  `turnsById` is supplied, but the dispatcher historically never passed it
 *  — the column silently vanished on every real invocation. Reads each
 *  snapshot's persisted `turns` counter (the same field `fork`/`rewind`
 *  round-trip). Best-effort: a session whose file cannot be loaded simply
 *  has no entry (the renderer omits the column for that row). Rich-format
 *  only — the caller gates the (one JSON load per session) cost. */
const computeTurnsById = async (
  sessions: readonly { readonly id: string }[],
): Promise<ReadonlyMap<string, number>> => {
  const out = new Map<string, number>()
  for (const s of sessions) {
    try {
      const saved = await loadSessionById(s.id)
      if (saved !== undefined) out.set(s.id, saved.turns)
    } catch {
      // unreadable snapshot — leave the column blank for this row.
    }
  }
  return out
}

const cmdLs = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(
    args,
    0,
    ["--archived", "--json", "--ids", "--legacy"],
    ["--format", "--cwd", "--branch", "--last", "--sort"],
  )
  if (unknown !== undefined) {
    deps.err(errLine("ls", `unexpected argument: ${unknown}`))
    return 1
  }
  const includeArchived = hasFlag(args, "--archived")
  const json = hasFlag(args, "--json")
  const idsOnly = hasFlag(args, "--ids")
  // ── Existing fast paths preserved BYTE-IDENTICAL ─────────────────────
  // `--json` and `--ids` short-circuit so tooling that parses our output
  // (CI scripts, the existing test suite, pipelines) is untouched. Only
  // the human-facing table is wrapped in the new TUI renderer.
  const sessions = await listSessions({ includeArchived })
  if (idsOnly) {
    for (const m of sessions) deps.out(`${m.id}\n`)
    return 0
  }
  if (json) {
    deps.out(`${JSON.stringify(sessions, null, 2)}\n`)
    return 0
  }

  // ── Empty-state hints preserved ───────────────────────────────────────
  if (sessions.length === 0) {
    await emitEmptyStateHint(deps, includeArchived)
    return 0
  }

  // ── Resolve options ───────────────────────────────────────────────────
  const format = pickFormat(args, deps.listEnv)
  const filterCwd = readValueFlag(args, "--cwd")
  const filterBranch = readValueFlag(args, "--branch")
  const sortBy = pickSortBy(args)
  const last = pickLastN(args, format, deps.listEnv)
  if (last.error !== undefined) {
    deps.err(errLine("ls", last.error))
    return 1
  }

  const opts: SessionListOptions = {
    format,
    showArchived: includeArchived,
    ...(filterCwd !== undefined ? { filterCwd } : {}),
    ...(filterBranch !== undefined ? { filterBranch } : {}),
    ...(last.lastN !== undefined ? { lastN: last.lastN } : {}),
    ...(sortBy !== undefined ? { sortBy } : {}),
  }

  // ── Build entries + render ────────────────────────────────────────────
  // UUX-4-10 — rich format loads the per-session turn counts so the `N
  // turns` column and `--sort size` actually work; plain format skips the
  // extra loads (it never displays turns) and stays byte-identical.
  const entries = await buildSessionListEntries(sessions, {
    withTokenEstimates: format === "rich",
    ...(format === "rich" ? { turnsById: await computeTurnsById(sessions) } : {}),
  })
  const filtered = applyListPipeline(entries, opts)
  if (filtered.length === 0) {
    // Filters narrowed everything out — print a helpful empty line so the
    // operator knows the filter is the cause (not an actual empty store).
    deps.out("(no matching sessions)\n")
    return 0
  }
  deps.out(renderSessionList(filtered, opts))
  return 0
}

const cmdShow = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, ["--json"], [])
  if (unknown !== undefined) {
    deps.err(errLine("show", `unexpected argument: ${unknown}`))
    return 1
  }
  // positional id is the first non-flag arg (boolean flag can appear in any order)
  const id = args.find((a) => a !== "--json")
  if (id === undefined) {
    deps.err(errLine("show", "missing <id>"))
    return 1
  }
  const saved = await loadSessionById(id)
  if (saved === undefined) {
    deps.err(errLine("show", `not found: ${id}`))
    return 1
  }
  // MEDIUM-9: `--json` emits the full SavedSession (meta/reason/turns/messages)
  // for tooling. Without `--json`, the human-readable transcript is unchanged.
  if (hasFlag(args, "--json")) {
    deps.out(`${JSON.stringify(saved, null, 2)}\n`)
    return 0
  }
  deps.out(`Session ${saved.meta.id} — ${saved.meta.title} (${saved.messages.length} turns)\n`)
  for (const msg of saved.messages) {
    const body = renderContent(msg)
    if (body === "") continue
    deps.out(`[${msg.role}] ${body}\n`)
  }
  return 0
}

const cmdRename = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 2, [], [])
  if (unknown !== undefined) {
    deps.err(errLine("rename", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  const title = args[1]
  if (id === undefined || title === undefined) {
    deps.err(errLine("rename", "usage: rename <id> <new-title>"))
    return 1
  }
  // MEDIUM-11: reject blank/whitespace-only titles up front so a typo can't
  // wipe the visible name. `renameSession` itself does not validate this.
  if (title.trim().length === 0) {
    deps.err(errLine("rename", "title cannot be empty"))
    return 1
  }
  // `renameSession` is a no-op on a missing id (best-effort, never throws).
  // We pre-check so we can surface an exit-1 error for the CLI UX contract.
  const existing = await loadSessionById(id)
  if (existing === undefined) {
    deps.err(errLine("rename", `not found: ${id}`))
    return 1
  }
  await renameSession(id, title)
  deps.out(`renamed ${id} → "${title}"\n`)
  return 0
}

const cmdArchive = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, [], [])
  if (unknown !== undefined) {
    deps.err(errLine("archive", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  if (id === undefined) {
    deps.err(errLine("archive", "missing <id>"))
    return 1
  }
  const existing = await loadSessionById(id)
  if (existing === undefined) {
    deps.err(errLine("archive", `not found: ${id}`))
    return 1
  }
  await archiveSession(id)
  deps.out(`archived ${id}\n`)
  return 0
}

const cmdUnarchive = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, [], [])
  if (unknown !== undefined) {
    deps.err(errLine("unarchive", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  if (id === undefined) {
    deps.err(errLine("unarchive", "missing <id>"))
    return 1
  }
  const existing = await loadSessionById(id)
  if (existing === undefined) {
    deps.err(errLine("unarchive", `not found: ${id}`))
    return 1
  }
  await unarchiveSession(id)
  deps.out(`unarchived ${id}\n`)
  return 0
}

const cmdFork = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, ["--worktree"], ["--title"])
  if (unknown !== undefined) {
    deps.err(errLine("fork", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  if (id === undefined) {
    deps.err(errLine("fork", "missing <id>"))
    return 1
  }
  const titleOpt = readValueFlag(args, "--title")
  const wantWorktree = hasFlag(args, "--worktree")

  const source = await loadSessionById(id)
  if (source === undefined) {
    deps.err(errLine("fork", `source not found: ${id}`))
    return 1
  }

  // Non-worktree path: byte-identical to the prior behavior (no double-save,
  // no rollback bookkeeping needed).
  if (!wantWorktree) {
    const forkOpts = titleOpt !== undefined ? { title: titleOpt } : {}
    const newId = await forkSession(id, forkOpts)
    deps.out(`forked ${id} → ${newId}\n`)
    return 0
  }

  // MEDIUM-6: worktree path — single-save flow with rollback on partial failure.
  //
  // 1. Validate source cwd is a git repo BEFORE creating anything (no half-fork).
  // 2. Mint newId ourselves so we can pre-compute the worktree path.
  // 3. Create the worktree.
  // 4. Then forkSession({ newId, title, cwd: worktreePath }) — single save with
  //    the worktree cwd baked in (no double-touch).
  // 5. On step 4 throw: rollback the worktree.
  const sourceCwd = source.meta.cwd
  const ok = await isGitRepo(sourceCwd)
  if (!ok) {
    deps.err(errLine("fork", `--worktree requires the source cwd to be a git repo: ${sourceCwd}`))
    return 1
  }

  const newId = crypto.randomUUID()
  let wt: { worktreePath: string; branch: string } | undefined
  try {
    wt = await createPersistentWorktree(newId, sourceCwd)
  } catch (e) {
    const detail = e instanceof WorktreeForkError ? (e.detail ?? e.message) : errMessage(e)
    deps.err(errLine("fork", `worktree creation failed: ${detail}`))
    return 1
  }
  try {
    const forkOpts: { newId: string; title?: string; cwd: string } = {
      newId,
      cwd: wt.worktreePath,
      ...(titleOpt !== undefined ? { title: titleOpt } : {}),
    }
    const minted = await forkSession(id, forkOpts)
    // RFC-06 §RFC06-1 — persist the WorkspaceOwnership authority on the forked
    // session so a later `delete`/GC targets the EXACT persisted path/branch
    // instead of inferring them from the cwd. The fork effect already
    // succeeded, so we publish a `ready` record (intent→effect→ready collapsed
    // for the non-current-thread fork path; the full crash-matrix transaction
    // is RFC06-2's current-thread transition). `baseSha` is the source's
    // captured git sha when available (base-drift detection); absent ⇒ empty
    // marker (still a valid record — the schema requires min(1), so fall back
    // to "HEAD" convention when unknown).
    await publishForkWorkspaceOwnership(minted, {
      ownerThreadId: minted,
      repoRoot: sourceCwd,
      repoId: source.meta.gitOriginUrl ?? sourceCwd,
      path: wt.worktreePath,
      branch: wt.branch,
      baseSha: source.meta.gitSha ?? "HEAD",
    })
    deps.out(`forked ${id} → ${minted}\n`)
    deps.out(`worktree: ${wt.worktreePath} (branch: ${wt.branch})\n`)
    return 0
  } catch (e) {
    // Rollback: the session was never persisted but the worktree IS on disk.
    // The just-created worktree is clean + owned, so the hardened non-force
    // remove reaches absence; we only need it gone (branch delete is folded in).
    await removeWorktree(wt.worktreePath, sourceCwd, { branch: wt.branch }).catch(() => undefined)
    deps.err(errLine("fork", `failed to save forked session: ${errMessage(e)}`))
    return 1
  }
}

/** RFC-06 §RFC06-1 — fold a `ready` WorkspaceOwnership record onto an
 *  already-persisted session's meta and re-save through the EXISTING atomic
 *  store (no new writer). Mints the `creating` intent then transitions to
 *  `ready` (the fork effect already ran) so the persisted state is a valid
 *  lifecycle position. Best-effort: a save failure is surfaced by the caller's
 *  try/catch, never silently swallowed. */
const publishForkWorkspaceOwnership = async (
  sessionId: string,
  facts: {
    ownerThreadId: string
    repoRoot: string
    repoId: string
    path: string
    branch: string
    baseSha: string
  },
): Promise<void> => {
  const saved = await loadSessionById(sessionId)
  if (saved === undefined) return
  const now = Date.now()
  const intent = makeWorkspaceCreateIntent({
    ownershipId: crypto.randomUUID(),
    ...facts,
    now,
  })
  const ready = transitionWorkspaceState(intent, "ready", now)
  const ownership = ready.ok ? ready.record : intent
  const nextMeta: SessionMeta = { ...saved.meta, workspaceOwnership: ownership }
  await saveSessionById(nextMeta, {
    reason: saved.reason,
    turns: saved.turns,
    messages: saved.messages,
    ...(saved.rollbackCheckpoints !== undefined
      ? { rollbackCheckpoints: saved.rollbackCheckpoints }
      : {}),
    ...(saved.rollbackOperations !== undefined
      ? { rollbackOperations: saved.rollbackOperations }
      : {}),
  })
}

const cmdRewind = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 2, [], [])
  if (unknown !== undefined) {
    deps.err(errLine("rewind", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  const msgId = args[1]
  if (id === undefined || msgId === undefined) {
    deps.err(errLine("rewind", "usage: rewind <id> <msg-id>"))
    return 1
  }
  const existing = await loadSessionById(id)
  if (existing === undefined) {
    deps.err(errLine("rewind", `not found: ${id}`))
    return 1
  }
  const result = await rewindToMessage(id, msgId)
  if (result.removed === 0) {
    // Could be: msg-id not in transcript, OR it was already the last message.
    // Surface a clear, non-fatal message so the operator knows nothing changed.
    deps.out(`rewind ${id}: no-op (msg-id not found or already last)\n`)
    return 0
  }
  deps.out(`rewound ${id} → ${msgId} (removed ${result.removed} message(s))\n`)
  return 0
}

const cmdDelete = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, ["--force"], [])
  if (unknown !== undefined) {
    deps.err(errLine("delete", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  if (id === undefined) {
    deps.err(errLine("delete", "missing <id>"))
    return 1
  }
  const existing = await loadSessionById(id)
  if (existing === undefined) {
    deps.err(errLine("delete", `not found: ${id}`))
    return 1
  }
  const force = hasFlag(args, "--force")
  if (!force) {
    const ok = await deps.confirm(`Delete session ${id}? [y/N] `)
    if (!ok) {
      deps.out("cancelled\n")
      return 0
    }
  }
  // RFC-06 §RFC06-1: when a session PERSISTED a WorkspaceOwnership record, tear
  // down the EXACT persisted worktree + branch BEFORE removing the session file.
  // The target is read from the durable ownership authority — NOT inferred from
  // the cwd path/branch name (the `deriveWorktreeInfo` heuristic was removed).
  // The hardened `removeWorktree` is non-force + porcelain-exact: a dirty/locked
  // worktree is REFUSED (report-only, never force-deleted) and the session file
  // is still removed (the record is what users see). A LEGACY fork (created
  // before RFC06-0 persisted ownership) has no record but its cwd may sit in a
  // `.quanta/worktrees/` dir — we do NOT infer a removal target from the path
  // (the `deriveWorktreeInfo` heuristic was deleted; inference must never drive
  // a mutation). Instead a REPORT-ONLY salvage notice is emitted so the operator
  // can clean it up explicitly — no silent leak, no force delete.
  await cleanupOwnedWorktreeOnDelete(existing.meta.workspaceOwnership, existing.meta.cwd, deps)
  await deleteSession(id)
  deps.out(`deleted ${id}\n`)
  return 0
}

/** Marker of a quanta fork-worktree cwd — used ONLY to decide whether to emit a
 *  report-only salvage NOTICE for a legacy (ownership-less) session, never as a
 *  removal target. */
const WORKTREE_CWD_MARKER = "/.quanta/worktrees/"

/** RFC-06 §RFC06-1 — teardown the EXACT persisted worktree on session delete.
 *  Report-only: dirty/locked refusals and git errors are surfaced as warnings
 *  and NEVER escalated to a force delete. When there is no persisted ownership
 *  record but the cwd looks like a legacy fork-worktree, emit a salvage NOTICE
 *  (report-only — no path/branch inference drives any git mutation). */
const cleanupOwnedWorktreeOnDelete = async (
  ownership: WorkspaceOwnership | undefined,
  cwd: string,
  deps: SessionCommandDeps,
): Promise<void> => {
  if (ownership === undefined) {
    if (cwd.includes(WORKTREE_CWD_MARKER)) {
      deps.err(
        `notice: session cwd looks like a worktree (${cwd}) but has no persisted ownership ` +
          "(legacy fork) — not auto-removed; clean it up with `git worktree remove` if unused.\n",
      )
    }
    return
  }
  try {
    const outcome = await removeWorktree(ownership.path, ownership.repoRoot, {
      branch: ownership.branch,
    })
    switch (outcome.kind) {
      case "removed":
        deps.out(`removed worktree: ${ownership.path}\n`)
        break
      case "absent":
        deps.out(`worktree already gone: ${ownership.path}\n`)
        break
      case "refused":
        deps.err(
          `warning: worktree NOT removed (${outcome.reason}) — left in place: ${ownership.path}\n`,
        )
        break
      case "error":
        deps.err(`warning: worktree cleanup error (${outcome.error}): ${ownership.path}\n`)
        break
    }
  } catch (e) {
    deps.err(`warning: worktree cleanup failed: ${errMessage(e)}\n`)
  }
}

const cmdPath = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, [], [])
  if (unknown !== undefined) {
    deps.err(errLine("path", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  if (id === undefined) {
    deps.err(errLine("path", "missing <id>"))
    return 1
  }
  const saved = await loadSessionById(id)
  if (saved === undefined) {
    deps.err(errLine("path", `not found: ${id}`))
    return 1
  }
  const p = saved.meta.archived ? archivedFilePath(id) : sessionFilePath(id)
  deps.out(`${p}\n`)
  return 0
}

/** `import` subcommand stub. The migration-translator dependency lives outside
 *  `@/runner` (slice isolation, RFC 3.1), so the caller injects the concrete
 *  handler via `deps.importHandler`. When it is absent we fail fast: silently
 *  no-op'ing would hide a misconfigured embedding (e.g. a future surface that
 *  forgets to wire migration). */
const cmdImport = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  if (deps.importHandler === undefined) {
    deps.err(errLine("import", "not supported in this build (no migration handler wired)"))
    return 1
  }
  return deps.importHandler(args, deps)
}

/** RFC-06 §RFC06-3 — dirty probe: `git status --porcelain` inside a worktree.
 *  Non-empty ⇒ dirty. `undefined` on a git error (⇒ the planner fails closed to
 *  `dirty`, never treats an unknown state as clean). */
const gcDirtyProbe = async (worktreePath: string): Promise<boolean | undefined> => {
  const st = await runShell("git status --porcelain", { cwd: worktreePath }).catch(() => undefined)
  if (st === undefined || st.exitCode !== 0) return undefined
  return st.stdout.trim().length > 0
}

/** Render one GC candidate as a report line. */
const gcLine = (c: GcCandidate): string =>
  `  [${c.verdict}] ${c.ownership.path} (branch ${c.ownership.branch}, session ${c.sessionId}) — ${c.reason}\n`

/** Run the GC `--apply` phase: remove eligible targets (TOCTOU-rechecked inside
 *  `applyWorktreeGc`) and report per-target outcomes. Extracted from
 *  `cmdWorktreeGc` to keep its cognitive complexity under the biome ceiling. */
const runGcApply = async (
  plan: GcPlan,
  eligible: readonly GcCandidate[],
  deps: SessionCommandDeps,
): Promise<void> => {
  const results = await applyWorktreeGc(plan, gcDirtyProbe)
  let removedCount = 0
  for (const r of results) {
    if (r.action === "removed") {
      removedCount += 1
      deps.out(`removed: ${r.path} (${r.reason})\n`)
    } else if (eligible.some((e) => e.ownership.path === r.path)) {
      // Only report skips for targets that WERE eligible at dry-run (a TOCTOU
      // drift); non-eligible verdicts were already reported above.
      deps.err(`skipped: ${r.path} — ${r.reason}\n`)
    }
  }
  deps.out(`worktree-gc: removed ${removedCount}/${eligible.length} eligible.\n`)
}

/**
 * RFC-06 §RFC06-3 — explicit operator worktree GC. `worktree-gc [--repo <path>]`
 * prints a dry-run classification of PERSISTED-OWNED worktrees; `--apply`
 * additionally removes ONLY `eligible` targets after a TOCTOU recheck through
 * the hardened non-force remover. NO daemon/reaper/force. Legacy
 * `.claude/worktrees/agent-*` trees have no persisted ownership ⇒ they are
 * never candidates.
 */
const cmdWorktreeGc = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 0, ["--apply"], ["--repo"])
  if (unknown !== undefined) {
    deps.err(errLine("worktree-gc", `unexpected argument: ${unknown}`))
    return 1
  }
  const repoRoot = readValueFlag(args, "--repo") ?? deps.cwd
  if (repoRoot === undefined || repoRoot === "") {
    deps.err(errLine("worktree-gc", "no repo root (pass --repo <path>)"))
    return 1
  }
  const apply = hasFlag(args, "--apply")

  const ids = (await listSessions({ includeArchived: true })).map((m) => m.id)
  const owned = await collectOwnedWorktrees(ids, repoRoot)
  const planned = await planWorktreeGc(owned, repoRoot, gcDirtyProbe)
  if (!planned.ok) {
    deps.err(errLine("worktree-gc", `inspection failed: ${planned.error}`))
    return 1
  }
  const { candidates } = planned.plan
  const eligible = candidates.filter((c) => c.verdict === "eligible")

  deps.out(`worktree-gc: ${candidates.length} owned worktree(s) in ${repoRoot}\n`)
  for (const c of candidates) deps.out(gcLine(c))
  if (candidates.length === 0) deps.out("  (none owned by a persisted session)\n")

  if (!apply) {
    deps.out(`\n${eligible.length} eligible for removal. Re-run with --apply to remove.\n`)
    return 0
  }

  // --apply: remove only eligible targets, with a fresh TOCTOU recheck each.
  await runGcApply(planned.plan, eligible, deps)
  return 0
}

/**
 * RFC-06 §RFC06-2 / RFC02-5 — the current-thread worktree switch front door.
 * `worktree <id>` transitions the given session's thread into an isolated
 * worktree as the durable intent→effect→publish transaction (the KEPT create
 * owner does the git effect; the persisted `WorkspaceOwnership` authority is the
 * lifecycle). This is the FIRST production caller of `transitionThreadToWorktree`
 * and the FIRST real operation-correlated activity producer: when the surface
 * injected an {@link ActivityStore}, the transition emits a correlated
 * `running`→`done|failed` node the surface then renders (so the switch is
 * observable — the north-star "뭐하고 있나").
 *
 * The `nextCwd` is pinned at the NEXT turn boundary by the caller (never
 * mid-turn); this command reports it. Rejections (session missing / already owns
 * a worktree) and git failures are surfaced as exit-1 with a clear reason.
 */
const cmdWorktree = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 1, [], ["--branch"])
  if (unknown !== undefined) {
    deps.err(errLine("worktree", `unexpected argument: ${unknown}`))
    return 1
  }
  const id = args[0]
  if (id === undefined) {
    deps.err(errLine("worktree", "missing <id>"))
    return 1
  }
  const saved = await loadSessionById(id)
  if (saved === undefined) {
    deps.err(errLine("worktree", `not found: ${id}`))
    return 1
  }
  const repoRoot = saved.meta.cwd
  const branch = readValueFlag(args, "--branch")
  const req = {
    sessionId: id,
    ownerThreadId: id,
    repoRoot,
    repoId: saved.meta.gitOriginUrl ?? repoRoot,
    ownershipId: crypto.randomUUID(),
    baseSha: saved.meta.gitSha ?? "HEAD",
    ...(branch !== undefined ? { branch } : {}),
  }
  // RFC02-5 / RFC-04 D4 — the activity sink is OPTIONAL (absent ⇒ byte-identical,
  // no activity). When a store is wired AND the composition root resolved the
  // `QUANTA_WORKTREE_PROGRESS` gate, `runWorktreeTransitionWithProgress` turns on
  // the transaction's staged children AND subscribes BEFORE invoking it, so each
  // stage renders PRE-completion; gate-OFF ⇒ single coarse node, no live render.
  const result = await runWorktreeTransitionWithProgress(req, deps.out, {
    ...(deps.activityStore !== undefined ? { store: deps.activityStore } : {}),
    progress: deps.worktreeProgress === true,
    turnId: id,
  })
  switch (result.kind) {
    case "ready":
      deps.out(`worktree ready: ${result.nextCwd} (branch ${result.ownership.branch})\n`)
      deps.out(`  (pinned at the next turn boundary — not mid-turn)\n`)
      break
    case "failed":
      deps.err(
        errLine(
          "worktree",
          `git failed (${result.errorCode})${result.detail !== undefined ? `: ${result.detail}` : ""}`,
        ),
      )
      break
    case "rejected":
      deps.err(errLine("worktree", result.reason))
      break
  }
  // RFC02-5 — surface the correlated activity state so the transition is
  // observable (only when a store was wired; otherwise byte-identical). Under D4
  // live progress this is the FINAL settled receipt after the live stage renders.
  if (deps.activityStore !== undefined) {
    renderActivityTo(deps.activityStore.snapshot(), deps.out)
  }
  return result.kind === "ready" ? 0 : 1
}

/** Entry point for the `session` subcommand dispatcher.
 *
 * `args` is the slice AFTER `quanta session` (i.e. `process.argv.slice(3)`).
 * Returns a numeric exit code; callers decide how to surface it.
 */
export const runSessionCommand = async (
  args: string[],
  deps: SessionCommandDeps,
): Promise<number> => {
  const sub = args[0]
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    deps.out(usage())
    return sub === undefined ? 1 : 0
  }
  const rest = args.slice(1)
  // Centralized SessionIdError trap: any subcommand reaches `sanitizeId` via
  // `sessionFilePath` / `archivedFilePath` / the per-id storage helpers. A
  // malicious id (path-separator, leading-dash, control byte, etc.) throws
  // SessionIdError BEFORE any filesystem write happens. The dispatcher's UX
  // contract is "exit 1 + `session <verb>: <reason>` on stderr", not a
  // bubbling exception — catch ONLY SessionIdError here (instanceof) so any
  // other error type still propagates for the caller to observe.
  try {
    switch (sub) {
      case "ls":
        return await cmdLs(rest, deps)
      case "show":
        return await cmdShow(rest, deps)
      case "rename":
        return await cmdRename(rest, deps)
      case "archive":
        return await cmdArchive(rest, deps)
      case "unarchive":
        return await cmdUnarchive(rest, deps)
      case "fork":
        return await cmdFork(rest, deps)
      case "rewind":
        return await cmdRewind(rest, deps)
      case "delete":
        return await cmdDelete(rest, deps)
      case "path":
        return await cmdPath(rest, deps)
      case "import":
        return await cmdImport(rest, deps)
      case "worktree-gc":
        return await cmdWorktreeGc(rest, deps)
      case "worktree":
        return await cmdWorktree(rest, deps)
      default:
        deps.err(`session: unknown subcommand: ${sub}\n`)
        deps.out(usage())
        return 1
    }
  } catch (e) {
    if (e instanceof SessionIdError) {
      deps.err(errLine(sub, e.message))
      return 1
    }
    throw e
  }
}
