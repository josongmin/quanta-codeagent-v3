/**
 * `/rewind` and `/fork` slash commands — Claude Code v1.7196 SOTA pattern.
 *
 *   - `/rewind` (no args)              → list recent message ids in the
 *                                        active session (most-recent first).
 *                                        `--last` rewinds to the message
 *                                        before the most-recent user message.
 *   - `/rewind <id-prefix> [--yes]`    → rewind to that message. Without
 *                                        `--yes`, prints the confirmation
 *                                        line (REPL surface that wires up an
 *                                        actual y/n prompt can pre-confirm).
 *   - `/rewind --to-last [--yes]`      → convenience: rewind to immediately
 *                                        before the most-recent user msg.
 *   - `/rewind <id> --restore-files`   → also reset git working tree to the
 *                                        commit recorded in session meta.
 *                                        Requires `QUANTA_REWIND_GIT=1`
 *                                        (extra-destructive gate) AND an
 *                                        injected git port on the context.
 *
 *   - `/fork` (no args)                → list message ids + "use /fork <id>".
 *   - `/fork <id-prefix> [--title T]`  → clone source + truncate clone to
 *                                        the fork point. Prints the new
 *                                        session id.
 *
 * Default-OFF posture (RFC §1.2):
 *
 *   - `QUANTA_REWIND` defaults to `"1"` (commands registered). Setting to
 *     `"0"` removes both commands from BUILTINS at load time — same effect as
 *     never registering them; no silent runtime fallthrough.
 *   - `QUANTA_REWIND_GIT` defaults to `"0"` (file-restore refused with a
 *     clear message). Even with `=1`, the slash command STILL refuses unless
 *     a `RewindGitPort` is injected via `SlashContext.rewindSession`.
 *
 * Slice contract: `src/apps/cli/**` is allowed to import `@/session`
 * (slash UX is the top of the slice DAG). The body NEVER imports `@/tool/*`
 * — git operations route through an injected port, not direct shell-out.
 */

import {
  forkSessionAtMessage,
  loadSessionById,
  type RewindGitPort,
  rewindSession,
  type SavedSession,
} from "@/session"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

/** Session state injected by the REPL surface so `/rewind` and `/fork` can
 *  bind to the live session. Absent ⇒ commands print "no active session"
 *  and exit 1 (NEVER a silent success). */
export interface RewindSlashState {
  /** Live session id — the one currently being executed against. */
  readonly sessionId: string
  /** Optional git port for `--restore-files`. Absent ⇒ even with
   *  `QUANTA_REWIND_GIT=1` the slash command refuses with a clear note. */
  readonly git?: RewindGitPort
  /** Override env access (test seam). Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** Claude Code v1.7196 rewind/fork pattern — see `./rewind-cmd.ts`. */
    readonly rewindSession?: RewindSlashState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* env knobs                                                           */
/* ------------------------------------------------------------------ */

const isOn = (v: string | undefined, fallback: string): boolean => {
  const raw = (v ?? fallback).trim().toLowerCase()
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no"
}

/** Whether `/rewind` and `/fork` should be registered. Honors the env source
 *  on the slash context first (test seam) then `process.env`. */
export const isRewindEnabled = (
  envSource?: Readonly<Record<string, string | undefined>>,
): boolean => {
  const e = envSource ?? process.env
  return isOn(e.QUANTA_REWIND, "1")
}

/** Whether `--restore-files` may actually run. Caller still needs an
 *  injected git port; this is the FIRST gate (refuse before even looking at
 *  the port). */
const isGitRestoreEnabled = (envSource?: Readonly<Record<string, string | undefined>>): boolean => {
  const e = envSource ?? process.env
  return isOn(e.QUANTA_REWIND_GIT, "0")
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const SHORT_ID_LEN = 8
const ESC = ""
const BOLD_RED = `${ESC}[1;31m`
const RESET = `${ESC}[0m`

const shortId = (id: string): string => (id.length <= SHORT_ID_LEN ? id : id.slice(0, SHORT_ID_LEN))

/** One-line content preview for a message — the first text block, trimmed +
 *  truncated to 80 chars. Tool-use / tool-result blocks contribute their
 *  tool name in `[brackets]`. Empty messages yield `(empty)`. */
const previewMessage = (m: {
  role: "user" | "assistant"
  content: readonly { type: string; text?: string; name?: string }[]
}): string => {
  for (const block of m.content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      const oneLine = block.text.replace(/\s+/g, " ").trim()
      return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
    }
  }
  // No text — look for a tool name.
  for (const block of m.content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      return `[tool:${block.name}]`
    }
    if (block.type === "tool_result") return "[tool_result]"
    if (block.type === "thinking") return "[thinking]"
    if (block.type === "image") return "[image]"
  }
  return "(empty)"
}

interface RewindFlags {
  readonly idPrefix?: string
  readonly toLast: boolean
  readonly yes: boolean
  readonly restoreFiles: boolean
}

const parseRewindArgs = (args: readonly string[]): RewindFlags | string => {
  let toLast = false
  let yes = false
  let restoreFiles = false
  let idPrefix: string | undefined
  for (const a of args) {
    if (a === "--to-last" || a === "--last") {
      toLast = true
    } else if (a === "--yes" || a === "-y") {
      yes = true
    } else if (a === "--restore-files") {
      restoreFiles = true
    } else if (a.startsWith("--")) {
      return `unknown flag: ${a}`
    } else {
      if (idPrefix !== undefined) {
        return `unexpected extra argument: ${a}`
      }
      idPrefix = a
    }
  }
  const out: RewindFlags = {
    ...(idPrefix !== undefined ? { idPrefix } : {}),
    toLast,
    yes,
    restoreFiles,
  }
  return out
}

interface ForkFlags {
  readonly idPrefix?: string
  readonly title?: string
}

const parseForkArgs = (args: readonly string[]): ForkFlags | string => {
  let idPrefix: string | undefined
  let title: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === "--title") {
      const next = args[i + 1]
      if (typeof next !== "string" || next.length === 0) {
        return "--title requires a value"
      }
      title = next
      i += 1
    } else if (a.startsWith("--")) {
      return `unknown flag: ${a}`
    } else {
      if (idPrefix !== undefined) {
        return `unexpected extra argument: ${a}`
      }
      idPrefix = a
    }
  }
  const out: ForkFlags = {
    ...(idPrefix !== undefined ? { idPrefix } : {}),
    ...(title !== undefined ? { title } : {}),
  }
  return out
}

/** Print the recent-message table the no-arg `/rewind` / `/fork` produce. */
const renderRecentMessages = (ctx: SlashContext, saved: SavedSession, label: string): void => {
  const msgs = saved.messages
  if (msgs.length === 0) {
    ctx.out(`${label}: session is empty\n`)
    return
  }
  // Show up to last 10, most-recent FIRST. Skip messages without ids — they
  // can't be addressed and would mislead the user.
  const recent = msgs
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => typeof m.id === "string" && (m.id as string).length > 0)
    .slice(-10)
    .reverse()
  if (recent.length === 0) {
    ctx.out(`${label}: this session has no addressable message ids (legacy / id-less)\n`)
    ctx.out("  rewind requires message ids — start a new session for the feature.\n")
    return
  }
  ctx.out(`${label} (last ${recent.length} of ${msgs.length}):\n`)
  for (const { m, idx } of recent) {
    const id = m.id as string
    const tag = `[${idx}]`.padEnd(6)
    ctx.out(`  ${tag} ${shortId(id)}  ${m.role.padEnd(9)} ${previewMessage(m)}\n`)
  }
}

/** Find the messageId immediately BEFORE the most-recent user message —
 *  the "rewind one turn" convenience target. Returns the FULL id, or
 *  undefined if there's no such message (single-turn session etc.). */
const findToLastTarget = (saved: SavedSession): string | undefined => {
  const msgs = saved.messages
  // Walk from the end, skip the trailing user-message (the one we want to
  // undo). Return the message id immediately before it.
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i]
    if (m === undefined) continue
    if (m.role === "user") {
      const prior = msgs[i - 1]
      if (prior === undefined) return undefined
      const pid = prior.id
      return typeof pid === "string" && pid.length > 0 ? pid : undefined
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* resolution / confirm helpers (pure)                                 */
/* ------------------------------------------------------------------ */

/** Resolved-target metadata used by the dispatch body. Either an error
 *  string (printed + returned 1) or a typed result with pre-computed drop
 *  counts. */
type ResolvedTarget =
  | { readonly kind: "err"; readonly message: string }
  | {
      readonly kind: "ok"
      readonly fullId: string
      readonly dropMsgs: number
      readonly dropTurns: number
    }

/** Resolve `targetId` (exact / prefix) against the saved transcript and
 *  pre-count drops. Pulled out of the dispatch body so the cognitive-
 *  complexity budget on `run()` stays sane. Pure — no IO. */
const resolveTarget = (
  saved: { readonly messages: readonly { role: "user" | "assistant"; id?: string }[] },
  targetId: string,
): ResolvedTarget => {
  const messages = saved.messages
  let hit: string | undefined
  for (const m of messages) {
    const id = m.id
    if (typeof id !== "string") continue
    if (id === targetId) {
      hit = id
      break
    }
    if (id.startsWith(targetId)) {
      if (hit !== undefined) {
        return { kind: "err", message: `ambiguous id prefix: ${targetId}` }
      }
      hit = id
    }
  }
  if (hit === undefined) {
    return { kind: "err", message: `message-id not found: ${targetId}` }
  }
  const idx = messages.findIndex((m) => m.id === hit)
  let dropMsgs = 0
  let dropTurns = 0
  if (idx >= 0) {
    const slice = messages.slice(idx + 1)
    dropMsgs = slice.length
    for (const m of slice) if (m.role === "user") dropTurns += 1
  }
  return { kind: "ok", fullId: hit, dropMsgs, dropTurns }
}

/** Format the destructive confirm prompt. The "drop" word is wrapped in
 *  ANSI bold-red so a TTY surface highlights the destructive bit; non-TTY
 *  surfaces just see the literal escape. Pure. */
const renderConfirmLine = (
  fullId: string,
  dropTurns: number,
  dropMsgs: number,
  restoreFiles: boolean,
  gitSha: string | undefined,
): string => {
  const fileRestoreNote = restoreFiles
    ? ` AND ${BOLD_RED}FILES WILL BE RESET${RESET} to commit ${gitSha ?? "(none recorded)"}`
    : ""
  const turnsWord = dropTurns === 1 ? "turn" : "turns"
  const msgsWord = dropMsgs === 1 ? "message" : "messages"
  return `[rewind to ${shortId(fullId)} — will ${BOLD_RED}drop${RESET} ${dropTurns} ${turnsWord} / ${dropMsgs} ${msgsWord}${fileRestoreNote}]`
}

/** Gate the optional git port. `--restore-files` requires BOTH the
 *  `QUANTA_REWIND_GIT=1` env knob AND an injected `RewindGitPort` — either
 *  missing ⇒ refuse with a user-visible message. */
type GitAuth =
  | { readonly ok: true; readonly port: RewindGitPort | undefined }
  | { readonly ok: false; readonly err: string }

const authorizeGitPort = (
  restoreFiles: boolean,
  envSource: Readonly<Record<string, string | undefined>>,
  port: RewindGitPort | undefined,
): GitAuth => {
  if (!restoreFiles) return { ok: true, port: undefined }
  if (!isGitRestoreEnabled(envSource)) {
    return {
      ok: false,
      err: "/rewind: --restore-files refused (set QUANTA_REWIND_GIT=1 to enable — destructive)\n",
    }
  }
  if (port === undefined) {
    return {
      ok: false,
      err: "/rewind: --restore-files: no git port wired in this surface\n",
    }
  }
  return { ok: true, port }
}

/** Resolve the dispatch's "target message id" — either explicit prefix or
 *  the `--to-last` convenience. Returns `undefined` (with error already
 *  printed via `ctx.err`) on failure so the caller can early-return. */
const pickTargetId = (
  saved: SavedSession,
  parsed: RewindFlags,
  ctx: SlashContext,
): string | undefined => {
  if (parsed.toLast) {
    const found = findToLastTarget(saved)
    if (found === undefined) {
      ctx.err("/rewind --to-last: nothing to rewind (no prior message)\n")
      return undefined
    }
    return found
  }
  return parsed.idPrefix as string
}

/* ------------------------------------------------------------------ */
/* /rewind                                                             */
/* ------------------------------------------------------------------ */

const rewindCmdImpl: SlashCommand = {
  name: "/rewind",
  describe: "Rewind session transcript to a message-id (Claude pattern)",
  category: "session",
  async run(args, ctx) {
    const state = ctx.rewindSession
    if (state === undefined) {
      ctx.err("/rewind: no active session (slash-context not wired)\n")
      return 1
    }
    const envSource = state.env ?? process.env
    if (!isRewindEnabled(envSource)) {
      // Belt-and-suspenders: even though we usually un-register the command
      // entirely, surface a friendly error if registered some other way.
      ctx.err("/rewind: disabled by QUANTA_REWIND=0\n")
      return 1
    }
    const parsed = parseRewindArgs(args)
    if (typeof parsed === "string") {
      ctx.err(`/rewind: ${parsed}\n`)
      return 1
    }

    const saved = await loadSessionById(state.sessionId)
    if (saved === undefined) {
      ctx.err(`/rewind: session not found: ${state.sessionId}\n`)
      return 1
    }

    // No id + no --to-last → list mode.
    if (parsed.idPrefix === undefined && !parsed.toLast) {
      renderRecentMessages(ctx, saved, "rewind targets")
      ctx.out("usage: /rewind <id-prefix> [--yes] | /rewind --to-last [--yes]\n")
      return 0
    }

    const targetId = pickTargetId(saved, parsed, ctx)
    if (targetId === undefined) return 1

    const target = resolveTarget(saved, targetId)
    if (target.kind === "err") {
      ctx.err(`/rewind: ${target.message}\n`)
      return 1
    }
    if (target.dropMsgs === 0) {
      ctx.out(`/rewind: ${shortId(target.fullId)} is already the last message — no-op\n`)
      return 0
    }

    if (!parsed.yes) {
      ctx.out(
        `${renderConfirmLine(target.fullId, target.dropTurns, target.dropMsgs, parsed.restoreFiles, saved.meta.gitSha)}\n`,
      )
      ctx.out("  re-run with --yes to confirm.\n")
      return 0
    }

    const gitAuth = authorizeGitPort(parsed.restoreFiles, envSource, state.git)
    if (!gitAuth.ok) {
      ctx.err(gitAuth.err)
      return 1
    }

    const rewindOpts: Parameters<typeof rewindSession>[0] = {
      sessionId: state.sessionId,
      messageId: target.fullId,
      restoreFiles: parsed.restoreFiles,
      ...(gitAuth.port !== undefined ? { git: gitAuth.port } : {}),
    }
    const result = await rewindSession(rewindOpts)
    const turnsWord = result.removedTurns === 1 ? "turn" : "turns"
    const msgsWord = result.removedMessages === 1 ? "message" : "messages"
    ctx.out(
      `rewound to ${shortId(result.rewindToMessageId)}: dropped ${result.removedTurns} ${turnsWord} / ${result.removedMessages} ${msgsWord} — ${result.fileStateNote}\n`,
    )
    return 0
  },
  complete(_args, _partial, _ctx) {
    return [
      { value: "--yes", kind: "argument", description: "skip confirm prompt" },
      { value: "--to-last", kind: "argument", description: "rewind one turn back" },
      {
        value: "--restore-files",
        kind: "argument",
        description: "git reset --hard (DESTRUCTIVE)",
      },
    ]
  },
}

/* ------------------------------------------------------------------ */
/* /fork                                                               */
/* ------------------------------------------------------------------ */

const forkCmdImpl: SlashCommand = {
  name: "/fork",
  describe: "Fork session at a message-id into a new session (Claude pattern)",
  category: "session",
  async run(args, ctx) {
    const state = ctx.rewindSession
    if (state === undefined) {
      ctx.err("/fork: no active session (slash-context not wired)\n")
      return 1
    }
    const envSource = state.env ?? process.env
    if (!isRewindEnabled(envSource)) {
      ctx.err("/fork: disabled by QUANTA_REWIND=0\n")
      return 1
    }
    const parsed = parseForkArgs(args)
    if (typeof parsed === "string") {
      ctx.err(`/fork: ${parsed}\n`)
      return 1
    }

    const saved = await loadSessionById(state.sessionId)
    if (saved === undefined) {
      ctx.err(`/fork: session not found: ${state.sessionId}\n`)
      return 1
    }

    if (parsed.idPrefix === undefined) {
      renderRecentMessages(ctx, saved, "fork points")
      ctx.out("usage: /fork <id-prefix> [--title TITLE]\n")
      return 0
    }

    try {
      const forkOpts: Parameters<typeof forkSessionAtMessage>[0] = {
        fromSessionId: state.sessionId,
        atMessageId: parsed.idPrefix,
        ...(parsed.title !== undefined ? { newTitle: parsed.title } : {}),
      }
      const result = await forkSessionAtMessage(forkOpts)
      ctx.out(
        `forked at ${shortId(result.forkedAtMessageId)} → new session ${result.newSessionId} (${result.messageCount} messages)\n`,
      )
      return 0
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.err(`/fork: ${msg}\n`)
      return 1
    }
  },
  complete(_args, _partial, _ctx) {
    return [{ value: "--title", kind: "argument", description: "title for the new session" }]
  },
}

/* ------------------------------------------------------------------ */
/* exports                                                             */
/* ------------------------------------------------------------------ */

/** The two commands as a registrable pair. The BUILTINS table in
 *  `slash-commands.ts` spreads this list in when `isRewindEnabled()`
 *  returns true; the call site (the BUILTINS literal) is the ONE place
 *  the env-gate decision lives. */
export const rewindCommands: readonly SlashCommand[] = [rewindCmdImpl, forkCmdImpl]

// Test-only re-exports of the parsers + helpers — kept in a clearly
// labelled group so the public surface (the two commands) is obvious.
export const __test = {
  parseRewindArgs,
  parseForkArgs,
  shortId,
  previewMessage,
  findToLastTarget,
  isOn,
  isGitRestoreEnabled,
  resolveTarget,
  renderConfirmLine,
  authorizeGitPort,
}
