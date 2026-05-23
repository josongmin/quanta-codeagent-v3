import type { Message } from "@/llm"
import { createPersistentWorktree, isGitRepo, removeWorktree, WorktreeForkError } from "@/runtime"
import {
  archivedFilePath,
  archiveSession,
  deleteSession,
  forkSession,
  listSessions,
  loadSessionById,
  renameSession,
  rewindToMessage,
  SessionIdError,
  sessionFilePath,
  unarchiveSession,
} from "@/session"

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
}

/** Truncate to `n` characters, appending an ellipsis when shortened. */
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Format a `lastTouched` timestamp as a coarse relative string. */
const relativeTime = (ts: number): string => {
  const delta = Date.now() - ts
  if (delta < 0) return "now"
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
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

const cmdLs = async (args: string[], deps: SessionCommandDeps): Promise<number> => {
  const unknown = checkUnknownArgs(args, 0, ["--archived", "--json", "--ids"], [])
  if (unknown !== undefined) {
    deps.err(errLine("ls", `unexpected argument: ${unknown}`))
    return 1
  }
  const includeArchived = hasFlag(args, "--archived")
  const json = hasFlag(args, "--json")
  const idsOnly = hasFlag(args, "--ids")
  const sessions = await listSessions({ includeArchived })
  if (idsOnly) {
    // MEDIUM-7: one id per line, no header, no other columns — pipeline-friendly.
    for (const m of sessions) deps.out(`${m.id}\n`)
    return 0
  }
  if (json) {
    deps.out(`${JSON.stringify(sessions, null, 2)}\n`)
    return 0
  }
  if (sessions.length === 0) {
    // LOW: when active list is empty but archived sessions exist, hint at --archived.
    if (!includeArchived) {
      const all = await listSessions({ includeArchived: true })
      if (all.length > 0) {
        deps.out("(no sessions) (use --archived to see archived)\n")
        return 0
      }
    }
    deps.out("(no sessions)\n")
    return 0
  }
  const header = `${"ID".padEnd(38)}  ${"TITLE".padEnd(24)}  ${"CWD".padEnd(40)}  ${"LAST".padEnd(6)}  ARCH\n`
  deps.out(header)
  for (const m of sessions) {
    const row = `${truncate(m.id, 38).padEnd(38)}  ${truncate(m.title, 24).padEnd(24)}  ${truncate(m.cwd, 40).padEnd(40)}  ${relativeTime(m.lastTouched).padEnd(6)}  ${m.archived ? "yes" : "no"}\n`
    deps.out(row)
  }
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
    const detail = e instanceof WorktreeForkError ? (e.detail ?? e.message) : (e as Error).message
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
    deps.out(`forked ${id} → ${minted}\n`)
    deps.out(`worktree: ${wt.worktreePath} (branch: ${wt.branch})\n`)
    return 0
  } catch (e) {
    // Rollback: the session was never persisted but the worktree IS on disk.
    await removeWorktree(wt.worktreePath, sourceCwd, { branch: wt.branch }).catch(() => undefined)
    deps.err(errLine("fork", `failed to save forked session: ${(e as Error).message}`))
    return 1
  }
}

/** HIGH-6 helper: when a session's cwd lives under
 *  `<repoRoot>/.quanta/worktrees/<safeId>`, derive the repoRoot and branch
 *  (`fork-<safeId>`) so `delete` can call `removeWorktree`. Returns
 *  `undefined` when the cwd does NOT look like a fork-worktree path so the
 *  caller can skip cleanup. */
const deriveWorktreeInfo = (
  cwd: string,
): { repoRoot: string; worktreePath: string; branch: string } | undefined => {
  // Look for `/.quanta/worktrees/<segment>` ANYWHERE in the path (works for
  // both `/abs/repo/.quanta/worktrees/safeId` and similar variants). The
  // segment is whatever follows the marker — we reconstruct the branch as
  // `fork-<segment>` to match createPersistentWorktree's branch naming.
  const marker = "/.quanta/worktrees/"
  const idx = cwd.lastIndexOf(marker)
  if (idx < 0) return undefined
  const repoRoot = cwd.slice(0, idx)
  const remainder = cwd.slice(idx + marker.length)
  // The worktree path layout is one segment deep; refuse anything nested or
  // empty so we don't pass a malformed cwd through to `git`.
  if (remainder.length === 0 || remainder.includes("/")) return undefined
  return { repoRoot, worktreePath: cwd, branch: `fork-${remainder}` }
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
  // HIGH-6: when a session was created via `fork --worktree`, its meta.cwd
  // points inside `<repoRoot>/.quanta/worktrees/<safeId>`. Tear down the
  // worktree + branch BEFORE removing the session file (failure is logged but
  // does NOT abort the delete — the session record is what users see). The
  // branch is derived from the path segment, matching the layout fixed by
  // createPersistentWorktree so we don't need a new SessionMeta field.
  const wtInfo = deriveWorktreeInfo(existing.meta.cwd)
  if (wtInfo) {
    try {
      const ok = await removeWorktree(wtInfo.worktreePath, wtInfo.repoRoot, {
        branch: wtInfo.branch,
      })
      if (ok) {
        deps.out(`removed worktree: ${wtInfo.worktreePath}\n`)
      } else {
        deps.err(
          `warning: worktree cleanup failed (path may already be gone): ${wtInfo.worktreePath}\n`,
        )
      }
    } catch (e) {
      deps.err(`warning: worktree cleanup failed: ${(e as Error).message}\n`)
    }
  }
  await deleteSession(id)
  deps.out(`deleted ${id}\n`)
  return 0
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
