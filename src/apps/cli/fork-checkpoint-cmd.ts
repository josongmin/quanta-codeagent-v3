/**
 * `/fork-checkpoint` slash command — ADR-0226 ForkSessionPort surface.
 *
 * Distinct from `/fork` (ADR's session-level `forkSessionAtMessage` in
 * `./rewind-cmd.ts`, which addresses by MESSAGE id within a saved
 * session). `/fork-checkpoint` addresses by CONVERSATION CHECKPOINT REF
 * (the in-memory `ConversationCheckpointStore` key) and mints a new
 * session id via the richer `ForkSessionPort.fork` surface — which also
 * records branch-name metadata + a shadow-ODB fork-tag (when wired).
 *
 *   `/fork-checkpoint`                        → list known branches off the
 *                                                active session (no arg).
 *   `/fork-checkpoint <ref> [--name=BRANCH]`  → fork; prints new session id +
 *                                                branch id (+ name if given).
 *
 * Default-OFF posture (RFC §1.2): when no `ForkSessionPort` is wired via
 * `SlashContext.forkSession`, the command prints "not wired in this surface"
 * and exits 0 (parity with /side/snooze/skills).
 *
 * Slice contract: lives in `src/apps/cli`. Imports `@/agent/fork-session`
 * for the port type only — no `@/agent/loop` / `@/agent/dispatch`.
 */

import type { ForkSessionPort } from "@/agent/fork-session"
import type { SlashCommand, SlashContext } from "./slash-commands"

/** Slash-context slot wired by the REPL surface. Absent ⇒ command is a
 *  friendly "not wired" no-op (exit 0). */
export interface ForkSessionSlashState {
  /** Active port instance. */
  readonly port: ForkSessionPort
  /** Optional active session id — used by the no-arg list path so the user
   *  doesn't have to retype their own session id. Absent ⇒ no-arg path
   *  prints a "specify --session=ID" hint. */
  readonly activeSessionId?: string
}

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0226 ForkSessionPort slot — see `./fork-checkpoint-cmd.ts`. */
    readonly forkSession?: ForkSessionSlashState | undefined
  }
}

interface ForkCheckpointFlags {
  readonly ref?: string
  readonly name?: string
  readonly session?: string
}

type FlagOutcome = "no-match" | { readonly ok: true } | { readonly err: string }

/** Try to consume `token` as a `prefix=value` flag, writing the value via
 *  `setter`. Returns `"no-match"` to defer to the caller; returns `{ok}` or
 *  `{err}` on consumption. */
const tryKv = (token: string, prefix: string, setter: (v: string) => void): FlagOutcome => {
  if (!token.startsWith(prefix)) return "no-match"
  const v = token.slice(prefix.length)
  if (v.length === 0) return { err: `${prefix} requires a value` }
  setter(v)
  return { ok: true }
}

/** Try every known flag in `table` against `token`. Returns the FIRST
 *  non-"no-match" outcome — either consumption succeeded (`{ok}`) or
 *  failed validation (`{err}`). When every entry returns "no-match",
 *  this function returns "no-match" too — caller handles positional/unknown. */
const matchFlag = (
  token: string,
  table: ReadonlyArray<readonly [string, (v: string) => void]>,
): FlagOutcome => {
  for (const [prefix, setter] of table) {
    const out = tryKv(token, prefix, setter)
    if (out !== "no-match") return out
  }
  return "no-match"
}

const parseFlags = (args: readonly string[]): ForkCheckpointFlags | string => {
  let ref: string | undefined
  let name: string | undefined
  let session: string | undefined
  const flagTable: ReadonlyArray<readonly [string, (v: string) => void]> = [
    [
      "--name=",
      (v) => {
        name = v
      },
    ],
    [
      "--session=",
      (v) => {
        session = v
      },
    ],
  ]
  for (const a of args) {
    const consumed = matchFlag(a, flagTable)
    if (typeof consumed === "object" && "err" in consumed) return consumed.err
    if (consumed !== "no-match") continue
    if (a.startsWith("--")) return `unknown flag: ${a}`
    if (ref !== undefined) return `unexpected extra argument: ${a}`
    ref = a
  }
  return {
    ...(ref !== undefined ? { ref } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(session !== undefined ? { session } : {}),
  }
}

/** List-mode body — printable branch tree for `sid`. Pure modulo IO. */
const runListMode = (
  state: ForkSessionSlashState,
  parsedSession: string | undefined,
  ctx: SlashContext,
): number => {
  const sid = parsedSession ?? state.activeSessionId
  if (sid === undefined) {
    ctx.out("/fork-checkpoint: no active session. Use --session=ID or supply a checkpoint ref.\n")
    ctx.out("usage: /fork-checkpoint <checkpoint-ref> [--name=BRANCH]\n")
    return 0
  }
  const branches = state.port.listBranches({ sessionId: sid })
  if (branches.length === 0) {
    ctx.out(`no branches off session ${sid}\n`)
    ctx.out("usage: /fork-checkpoint <checkpoint-ref> [--name=BRANCH]\n")
    return 0
  }
  ctx.out(`branches off ${sid} (${branches.length}):\n`)
  for (const b of branches) {
    const label = b.branchName !== undefined ? ` "${b.branchName}"` : ""
    ctx.out(`  ${b.childSessionId}${label}  forked-at=${b.forkedAt}\n`)
  }
  return 0
}

/** Fork-mode body — wraps `port.fork`, normalizes thrown errors, prints. */
const runForkMode = async (
  state: ForkSessionSlashState,
  ref: string,
  name: string | undefined,
  ctx: SlashContext,
): Promise<number> => {
  const input = {
    fromCheckpointRef: ref,
    ...(name !== undefined ? { branchName: name } : {}),
  }
  let result: Awaited<ReturnType<typeof state.port.fork>>
  try {
    result = await state.port.fork(input)
  } catch (e) {
    // ForkSessionPort.fork is contractually no-throw; this branch only fires
    // if a malformed adapter slipped past contract tests. Surface explicitly
    // rather than crash the REPL.
    const msg = e instanceof Error ? e.message : String(e)
    ctx.err(`/fork-checkpoint: port threw (contract violation): ${msg}\n`)
    return 1
  }
  if (!result.ok) {
    ctx.err(`/fork-checkpoint: ${result.error.code}: ${result.error.message}\n`)
    return 1
  }
  const v = result.value
  const nameLabel = v.branchName !== undefined ? ` "${v.branchName}"` : ""
  ctx.out(
    `forked ${v.parentSessionId} → ${v.newSessionId} branch=${v.branchId}${nameLabel} (${v.messages.length} messages inherited)\n`,
  )
  return 0
}

/** Body — exported for direct tests. */
export const runForkCheckpoint = async (
  args: readonly string[],
  ctx: SlashContext,
): Promise<number> => {
  const state = ctx.forkSession
  if (state === undefined) {
    ctx.out("/fork-checkpoint: not wired in this surface\n")
    return 0
  }
  const parsed = parseFlags(args)
  if (typeof parsed === "string") {
    ctx.err(`/fork-checkpoint: ${parsed}\n`)
    return 1
  }
  if (parsed.ref === undefined) {
    return runListMode(state, parsed.session, ctx)
  }
  return runForkMode(state, parsed.ref, parsed.name, ctx)
}

export const forkCheckpointCmd: SlashCommand = {
  name: "/fork-checkpoint",
  describe: "Fork a new session from a conversation checkpoint (ADR-0226)",
  category: "session",
  run: runForkCheckpoint,
  complete(_args, _partial, _ctx) {
    return [
      { value: "--name=", kind: "argument", description: "human label for the branch" },
      { value: "--session=", kind: "argument", description: "list branches under this session" },
    ]
  },
}

// Test-only re-exports.
export const __test = {
  parseFlags,
}
