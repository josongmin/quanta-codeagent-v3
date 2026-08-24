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

import { SYNTHETIC_USER_MESSAGE_ID_PREFIX } from "@/agent/synthetic-user"
import type { Message } from "@/llm"
import {
  forkSessionAtMessage,
  loadSessionById,
  type RewindGitPort,
  rewindSession,
  type SavedSession,
} from "@/session"
import { errMessage } from "@/shared"
import { applyLiveHistorySwap, BOLD_RED, confirmYesHint, RESET } from "./live-history-swap"
import type { SessionSwitchReceipt } from "./repl/session-loop/session-switch"
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
  /** UUX-4-02 — live-history swap hook (the ONE seam, see
   *  `./live-history-swap.ts`). When present, a confirmed `/rewind` pushes
   *  the truncated transcript into the live REPL history (kernel transcript
   *  + surface history binding) so the next turn does NOT still see the
   *  dropped messages. Absent (non-REPL surface / legacy shape) ⇒ the
   *  command's prior disk-only behavior is byte-identical. */
  readonly replaceMessages?: (msgs: ReadonlyArray<Message>) => Promise<void>
  /** UUX-4-07 — live session-switch hook (see `./repl/session-switch-wire.ts`).
   *  When present, a successful `/fork` SWITCHES the operator onto the fork:
   *  the loop swaps the kernel transcript to the fork's messages (the
   *  reducer's `transcript_replace_unavailable` guard refuses mid-turn) and
   *  repoints the id-mode persist identity so future turns persist under the
   *  fork id. Rejections PROPAGATE — `/fork` prints the honest disk-vs-live
   *  split and exits 1 instead of claiming a switch that did not happen.
   *  Absent (non-REPL / legacy surface) ⇒ `/fork` keeps its prior
   *  mint-and-stay behavior byte-identical. */
  readonly switchSession?: (sessionId: string) => Promise<SessionSwitchReceipt>
  /** RFC-def Surface B / RFC01-3 — the durable ThreadRollback coordinator port
   *  for `--restore-files`. When present, a confirmed `/rewind <id>
   *  --restore-files` routes the FILE restore through the coordinator
   *  (`persist requested → ThreeWayRestorePort restore → durable receipt`)
   *  instead of the safe-degrade. Fail-closed: a missing checkpoint mapping /
   *  moved SHA / conflict ⇒ the coordinator writes a `rollback_failed` receipt
   *  and returns a refusal — the command exits 1 with an operator-visible note
   *  and does NOT truncate the transcript (no partial). Absent ⇒ `--restore-
   *  files` keeps its prior `rewindSession` safe-degrade byte-identical.
   *
   *  Typed structurally (no `@/agent` import) so the CLI slice stays at the top
   *  of the DAG; the composition root adapts the real coordinator into it. */
  readonly restoreFilesCoordinator?: RestoreFilesCoordinatorPort
}

/** Structural port over the RFC01-3 ThreadRollback coordinator, kept free of
 *  `@/agent` types so `src/apps/cli/**` doesn't widen its slice fence. The
 *  composition root wraps `executeRollback` (with the SavedSession record store
 *  + the ShadowOdb-backed `RollbackEffectPort`) into this one method. */
export interface RestoreFilesCoordinatorPort {
  /** Order a durable file restore to the checkpoint mapped for `targetId`.
   *  `operationId` is the idempotency key. Returns a CLOSED outcome:
   *    - `restored`  — files restored + durable receipt written (proceed to
   *                    transcript truncation).
   *    - `refused`   — fail-closed (missing mapping / moved SHA / conflict /
   *                    pending-recovery). `reason` is operator-visible; NOTHING
   *                    was mutated and the transcript MUST NOT be truncated. */
  restoreToMessage(req: {
    readonly sessionId: string
    readonly operationId: string
    readonly targetId: string
  }): Promise<RestoreFilesOutcome>

  /** RFC01-3 crash-recovery — `/rewind --recover`. Scan the durable
   *  `rollbackOperations` for any op still `requested` (a rollback interrupted
   *  by a crash BETWEEN intent-persist and terminal-receipt) and drive each to a
   *  terminal state via the coordinator's explicit `resumePendingRollback` path
   *  (re-resolve checkpoint → effect → terminal receipt; NOT a blind retry).
   *  Idempotent: a session with no pending op returns `recovered: []` and mutates
   *  nothing. Surfaced verbatim so the operator sees exactly what was recovered.
   *  Typed structurally (no `@/agent` import) so the CLI slice stays at the top
   *  of the DAG. */
  recoverPending(req: { readonly sessionId: string }): Promise<RecoverPendingOutcome>
}

/** Closed outcome of {@link RestoreFilesCoordinatorPort.restoreToMessage}. */
export type RestoreFilesOutcome =
  | { readonly kind: "restored" }
  | { readonly kind: "refused"; readonly reason: string }

/** Per-operation result of a crash-recovery resume. */
export interface RecoveredOperation {
  readonly operationId: string
  /** Terminal state the resume reached (`rolled_back` on a successful restore,
   *  `rollback_failed` on a fail-closed refusal), or `still_pending` when the
   *  session/records vanished and the op could not be advanced. */
  readonly outcome: "rolled_back" | "rollback_failed" | "still_pending"
  /** Operator-visible detail (errorCode for a failure). */
  readonly detail?: string
}

/** Closed outcome of {@link RestoreFilesCoordinatorPort.recoverPending}. A
 *  session with no `requested` breadcrumb yields an empty `recovered` list
 *  (idempotent no-op). */
export interface RecoverPendingOutcome {
  readonly recovered: readonly RecoveredOperation[]
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

const shortId = (id: string): string => (id.length <= SHORT_ID_LEN ? id : id.slice(0, SHORT_ID_LEN))

/** One-line content preview for a message — the first text block, trimmed +
 *  truncated to 80 chars. Tool-use / tool-result blocks contribute their
 *  tool name in `[brackets]`. Empty messages yield `(empty)`. */
type PreviewBlock = { type: string; text?: string; name?: string }

/** The first NON-EMPTY text block, collapsed to one line and truncated, or
 *  undefined when the message carries no prose. Its own unit because "the
 *  first text block wins" is the preview's whole ranking rule — every other
 *  block kind is only a fallback for a message that has none. */
const firstTextPreview = (content: readonly PreviewBlock[]): string | undefined => {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      const oneLine = block.text.replace(/\s+/g, " ").trim()
      return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
    }
  }
  return undefined
}

/** The `[bracketed]` stand-in for a prose-less message — the first block whose
 *  kind we have a label for. A unit because the ORDER here is a display
 *  preference (a tool call is more informative than the thinking around it),
 *  not a property of any single block. */
const firstBlockTag = (content: readonly PreviewBlock[]): string | undefined => {
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      return `[tool:${block.name}]`
    }
    if (block.type === "tool_result") return "[tool_result]"
    if (block.type === "thinking") return "[thinking]"
    if (block.type === "image") return "[image]"
  }
  return undefined
}

const previewMessage = (m: {
  role: "user" | "assistant"
  content: readonly PreviewBlock[]
}): string => firstTextPreview(m.content) ?? firstBlockTag(m.content) ?? "(empty)"

interface RewindFlags {
  readonly idPrefix?: string
  readonly toLast: boolean
  readonly yes: boolean
  readonly restoreFiles: boolean
  readonly recover: boolean
}

type RewindBoolFlag = "toLast" | "yes" | "restoreFiles" | "recover"

/** Alias → field for `/rewind`'s boolean switches. A TABLE rather than an
 *  if/else chain so an added alias cannot land on the wrong field, and so the
 *  parse loop is left with exactly one decision: flag, or positional. */
const REWIND_BOOL_ALIASES: Readonly<Record<string, RewindBoolFlag>> = {
  "--to-last": "toLast",
  "--last": "toLast",
  "--yes": "yes",
  "-y": "yes",
  "--restore-files": "restoreFiles",
  "--recover": "recover",
}

const parseRewindArgs = (args: readonly string[]): RewindFlags | string => {
  const bools: Record<RewindBoolFlag, boolean> = {
    toLast: false,
    yes: false,
    restoreFiles: false,
    recover: false,
  }
  let idPrefix: string | undefined
  for (const a of args) {
    const field = REWIND_BOOL_ALIASES[a]
    if (field !== undefined) {
      bools[field] = true
      continue
    }
    if (a.startsWith("--")) {
      return `unknown flag: ${a}`
    }
    if (idPrefix !== undefined) {
      return `unexpected extra argument: ${a}`
    }
    idPrefix = a
  }
  const out: RewindFlags = {
    ...(idPrefix !== undefined ? { idPrefix } : {}),
    ...bools,
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

/** True for an id minted by `makeSyntheticUserMessage` — a harness-authored
 *  message, not something the operator said (aug-23 §10.3). */
const isHarnessId = (id: unknown): boolean =>
  typeof id === "string" && id.startsWith(SYNTHETIC_USER_MESSAGE_ID_PREFIX)

/** Index of the LAST element satisfying `pred`, or -1. */
const lastIndexWhere = <T>(items: readonly T[], pred: (item: T) => boolean): number => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item !== undefined && pred(item)) return i
  }
  return -1
}

/** Find the messageId immediately BEFORE the most-recent user message —
 *  the "rewind one turn" convenience target. Returns the FULL id, or
 *  undefined if there's no such message (single-turn session etc.). */
/** Narrow structural view both target resolvers read: role + optional id. Named
 *  once so `findToLastTarget` and `resolveTarget` state the SAME requirement —
 *  neither touches `version`/`meta`/`reason`/`turns`, and asking for the full
 *  `SavedSession` only forced callers (and the hellgate) into casts. */
type TranscriptView = {
  readonly messages: readonly { role: "user" | "assistant"; id?: string }[]
}

const findToLastTarget = (saved: TranscriptView): string | undefined => {
  const msgs = saved.messages
  // Walk from the end, skip the trailing user-message (the one we want to
  // undo). Return the message id immediately before it.
  /* aug-23 §10.3 / audit R1 — harness reminders ride as `role:"user"`. Treating
     one as "the turn to undo" both picks the wrong turn AND can return a
     synthetic id that `resolveTarget` refuses, surfacing an internal id where
     the command used to work. Skip them on both the search and the answer. */
  const lastOperatorTurn = lastIndexWhere(msgs, (m) => m.role === "user" && !isHarnessId(m.id))
  if (lastOperatorTurn < 0) return undefined
  const priorIdx = lastIndexWhere(msgs.slice(0, lastOperatorTurn), (m) => !isHarnessId(m.id))
  if (priorIdx < 0) return undefined
  const pid = msgs[priorIdx]?.id
  return typeof pid === "string" && pid.length > 0 ? pid : undefined
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
const resolveTarget = (saved: TranscriptView, targetId: string): ResolvedTarget => {
  const messages = saved.messages
  let hit: string | undefined
  for (const m of messages) {
    const id = m.id
    if (typeof id !== "string") continue
    /* aug-23 §10.3 — harness-authored reminders ride as `role:"user"`. They are
       not something the operator said, so they are not addressable rewind
       targets (they would also be dropped by any rewind past them anyway). */
    if (id.startsWith(SYNTHETIC_USER_MESSAGE_ID_PREFIX)) continue
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
    /* Count only turns the OPERATOR took: a harness reminder is dropped (and is
       counted in `dropMsgs`) but must not inflate the "you will lose N turns"
       figure the destructive confirm shows. */
    for (const m of slice) {
      if (m.role !== "user") continue
      if (typeof m.id === "string" && m.id.startsWith(SYNTHETIC_USER_MESSAGE_ID_PREFIX)) continue
      dropTurns += 1
    }
  }
  return { kind: "ok", fullId: hit, dropMsgs, dropTurns }
}

/** Test seam for {@link resolveTarget} (pure). Exported so the hellgate can
 *  drive the resolver directly without a session store. */
export const resolveTargetForTest = resolveTarget

/** Test seam for {@link findToLastTarget} (pure). */
export const findToLastTargetForTest = findToLastTarget

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

/** UUX-4-02 — fresh readback (NOT the pre-rewind slice: the live surface
 *  must get EXACTLY what is now on disk) + live-history swap through the
 *  ONE seam. Returns `null` on success (including "no hook wired" — the
 *  legacy disk-only surfaces) or the error message when the swap failed. */
const swapLiveHistoryAfterRewind = async (state: RewindSlashState): Promise<string | null> => {
  const after = await loadSessionById(state.sessionId)
  try {
    await applyLiveHistorySwap(state, after?.messages)
    return null
  } catch (e) {
    return errMessage(e)
  }
}

/** Tail of a CONFIRMED `/rewind`: swap the live history (fail loud on a
 *  half-applied effect), then — only after the swap — print the success
 *  receipt. Extracted from `run()` for the cognitive-complexity budget. */
const finishConfirmedRewind = async (
  ctx: SlashContext,
  state: RewindSlashState,
  result: Awaited<ReturnType<typeof rewindSession>>,
): Promise<number> => {
  const swapErr = await swapLiveHistoryAfterRewind(state)
  if (swapErr !== null) {
    ctx.err(
      `/rewind: transcript rewound on disk, but the live history swap failed: ${swapErr} — restart the session to reload the truncated transcript\n`,
    )
    return 1
  }
  const turnsWord = result.removedTurns === 1 ? "turn" : "turns"
  const msgsWord = result.removedMessages === 1 ? "message" : "messages"
  ctx.out(
    `rewound to ${shortId(result.rewindToMessageId)}: dropped ${result.removedTurns} ${turnsWord} / ${result.removedMessages} ${msgsWord} — ${result.fileStateNote}\n`,
  )
  return 0
}

/* ------------------------------------------------------------------ */
/* /rewind --recover (RFC01-3 crash-recovery front door)               */
/* ------------------------------------------------------------------ */

/** RFC01-3 crash-recovery verb. On restart a rollback that crashed BETWEEN the
 *  `requested` intent-persist and the terminal receipt leaves a durable pending
 *  breadcrumb (`pendingOperationIds`). `/rewind --recover` reads that breadcrumb
 *  and drives each pending op to a terminal state through the coordinator's
 *  explicit `resumePendingRollback` path (never a blind retry). Requires the
 *  SAME extra-destructive gate as `--restore-files` (`QUANTA_REWIND_GIT=1` +
 *  an injected coordinator). Absent coordinator ⇒ a clear "not wired" refusal;
 *  no state is touched (byte-identical to a surface that never wired the seam).
 *
 *  Idempotent: a session with NO pending breadcrumb prints "nothing to recover"
 *  and exits 0 — re-running after a completed recovery is a no-op (the resume
 *  path returns the existing terminal receipt without re-firing the effect). */
const runRecover = async (state: RewindSlashState, ctx: SlashContext): Promise<number> => {
  const coordinator = state.restoreFilesCoordinator
  if (coordinator === undefined) {
    ctx.err(
      "/rewind --recover: crash-recovery is not wired in this surface (set QUANTA_REWIND_GIT=1 — destructive)\n",
    )
    return 1
  }
  const { recovered } = await coordinator.recoverPending({ sessionId: state.sessionId })
  if (recovered.length === 0) {
    ctx.out("/rewind --recover: nothing to recover (no pending rollback)\n")
    return 0
  }
  let anyStuck = false
  for (const op of recovered) {
    if (op.outcome === "rolled_back") {
      ctx.out(`recovered ${shortId(op.operationId)}: rolled_back\n`)
    } else if (op.outcome === "rollback_failed") {
      ctx.out(`recovered ${shortId(op.operationId)}: rollback_failed (${op.detail ?? "unknown"})\n`)
    } else {
      anyStuck = true
      ctx.err(
        `/rewind --recover: ${shortId(op.operationId)} could not be advanced (${op.detail ?? "still pending"})\n`,
      )
    }
  }
  return anyStuck ? 1 : 0
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

    // RFC01-3 crash-recovery front door — takes NO id (it acts on the durable
    // pending-op breadcrumb, not the transcript), so it dispatches BEFORE the
    // id/list resolution. Extra-destructive gate is the same as --restore-files.
    if (parsed.recover) {
      if (parsed.idPrefix !== undefined || parsed.toLast || parsed.restoreFiles) {
        ctx.err("/rewind --recover: takes no id / other flags\n")
        return 1
      }
      return await runRecover(state, ctx)
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
      ctx.out(confirmYesHint())
      return 0
    }

    // RFC-def Surface B — when `--restore-files` is requested AND the durable
    // ThreadRollback coordinator is wired, route the FILE restore through it
    // FIRST (persist requested → restore → receipt). Fail-closed: a refusal
    // (missing mapping / moved SHA / conflict) exits 1 and does NOT truncate the
    // transcript (no partial). On success the files are already restored, so the
    // subsequent `rewindSession` only truncates the transcript.
    let restoreHandledByCoordinator = false
    if (parsed.restoreFiles && state.restoreFilesCoordinator !== undefined) {
      const outcome = await state.restoreFilesCoordinator.restoreToMessage({
        sessionId: state.sessionId,
        operationId: `rewind-${target.fullId}`,
        targetId: target.fullId,
      })
      if (outcome.kind === "refused") {
        ctx.err(
          `/rewind: --restore-files refused — ${outcome.reason} (working tree + transcript left unchanged; no partial restore)\n`,
        )
        return 1
      }
      restoreHandledByCoordinator = true
    }

    // The git-port safe-degrade path applies ONLY when the coordinator did NOT
    // handle the restore (absent coordinator ⇒ prior byte-identical behavior).
    const gitAuth = restoreHandledByCoordinator
      ? ({ ok: true, port: undefined } as const)
      : authorizeGitPort(parsed.restoreFiles, envSource, state.git)
    if (!gitAuth.ok) {
      ctx.err(gitAuth.err)
      return 1
    }

    const rewindOpts: Parameters<typeof rewindSession>[0] = {
      sessionId: state.sessionId,
      messageId: target.fullId,
      // Coordinator already restored the tree ⇒ the transcript-owner must NOT
      // also attempt (its own safe-degrade); it only truncates.
      restoreFiles: parsed.restoreFiles && !restoreHandledByCoordinator,
      ...(gitAuth.port !== undefined ? { git: gitAuth.port } : {}),
    }
    const result = await rewindSession(rewindOpts)
    // UUX-4-02 — swap the live history through the ONE seam BEFORE printing
    // the success receipt (see finishConfirmedRewind).
    return await finishConfirmedRewind(ctx, state, result)
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
      {
        value: "--recover",
        kind: "argument",
        description: "resume a crash-interrupted rollback (DESTRUCTIVE)",
      },
    ]
  },
}

/* ------------------------------------------------------------------ */
/* /fork                                                               */
/* ------------------------------------------------------------------ */

/**
 * WS-2 (UUX-4-07) — `/fork attach <session-id>`: make an EXISTING saved session
 * the live one, in-session (no disk-fork, no exit/restart — the difference from
 * `quanta --resume <id>`). Reuses the surface's `switchSession` seam
 * (performSessionSwitch → the unified `attachSessionToLive`), so the crown
 * guard (unknown ⇒ "not found", mid-turn ⇒ refused) is inherited. Effect-receipt
 * discipline: the "now editing" line prints ONLY after the switch resolves.
 */
const runForkAttach = async (
  rest: readonly string[],
  state: RewindSlashState,
  ctx: SlashContext,
): Promise<number> => {
  const targetId = rest[0]
  if (typeof targetId !== "string" || targetId.length === 0) {
    ctx.err("/fork attach: usage: /fork attach <session-id>\n")
    return 1
  }
  if (rest.length > 1) {
    ctx.err(`/fork attach: unexpected extra argument: ${rest[1]}\n`)
    return 1
  }
  if (state.switchSession === undefined) {
    ctx.err(
      "/fork attach: this surface cannot switch the live session — run `quanta --resume <id>` instead\n",
    )
    return 1
  }
  try {
    const receipt = await state.switchSession(targetId)
    ctx.out(`now editing ${receipt.sessionId} — ${receipt.persistNote}\n`)
    return 0
  } catch (e) {
    const msg = errMessage(e)
    // Honest copy: a running turn refuses the swap (retry after it), vs a
    // genuinely-absent id. Live state is unchanged either way.
    if (/transcript_replace_unavailable/.test(msg)) {
      ctx.err(
        `/fork attach: a turn is running — the live session is unchanged; try \`/fork attach ${targetId}\` again after it finishes\n`,
      )
    } else {
      ctx.err(`/fork attach: could not attach to ${targetId}: ${msg} — live session unchanged\n`)
    }
    return 1
  }
}

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
    // WS-2 (UUX-4-07) — `/fork attach <id>`: switch the LIVE session onto an
    // EXISTING saved session with NO disk-fork. The in-session recovery verb for
    // the "fork on disk but live switch refused mid-turn" case above, and a
    // general re-attach. Goes through the SAME `switchSession` seam (→
    // performSessionSwitch → attachSessionToLive), so unknown-id / mid-turn
    // refusal come back fail-loud for free.
    if (args[0] === "attach") {
      return await runForkAttach(args.slice(1), state, ctx)
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
      ctx.out("usage: /fork <id-prefix> [--title TITLE]  |  /fork attach <session-id>\n")
      return 0
    }

    let result: Awaited<ReturnType<typeof forkSessionAtMessage>>
    try {
      const forkOpts: Parameters<typeof forkSessionAtMessage>[0] = {
        fromSessionId: state.sessionId,
        atMessageId: parsed.idPrefix,
        ...(parsed.title !== undefined ? { newTitle: parsed.title } : {}),
      }
      result = await forkSessionAtMessage(forkOpts)
    } catch (e) {
      // Disk-fork failure ⇒ nothing live was touched (the switch below never
      // runs) — the honest failure is the whole story.
      ctx.err(`/fork: ${errMessage(e)}\n`)
      return 1
    }
    // UUX-4-07 — switch the LIVE session onto the fork when the surface wired
    // the seam. Effect-receipt discipline: the "now editing" copy prints ONLY
    // after the switch resolved. Absent seam ⇒ prior copy byte-identical.
    if (state.switchSession === undefined) {
      ctx.out(
        `forked at ${shortId(result.forkedAtMessageId)} → new session ${result.newSessionId} (${result.messageCount} messages)\n`,
      )
      return 0
    }
    try {
      const receipt = await state.switchSession(result.newSessionId)
      ctx.out(
        `forked at ${shortId(result.forkedAtMessageId)} → new session ${result.newSessionId} (${result.messageCount} messages)\n`,
      )
      ctx.out(`now editing fork ${result.newSessionId} — ${receipt.persistNote}\n`)
      return 0
    } catch (e) {
      ctx.err(
        `/fork: fork ${result.newSessionId} was created on disk, but switching the live session failed: ${errMessage(e)} — live history unchanged; run \`quanta --resume ${result.newSessionId}\` to pick up the fork\n`,
      )
      return 1
    }
  },
  complete(_args, _partial, _ctx) {
    return [
      { value: "attach", kind: "argument", description: "attach to an existing session (no fork)" },
      { value: "--title", kind: "argument", description: "title for the new session" },
    ]
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
