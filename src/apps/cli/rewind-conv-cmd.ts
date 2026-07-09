/**
 * `/rewind-conv [tag|--list]` — surface the per-turn auto-record wire
 * (ADR-0292, sibling of ADR-0124 ConversationCheckpointStore).
 *
 * Naming note: the existing `/rewind` (Claude Code v1.7196 pattern) is
 * SESSION-transcript scoped (`rewind-cmd.ts`). The existing `/snapshot`
 * is shadow-ODB FILE scoped (`snapshot-cmd.ts`). This command is
 * CONVERSATION-message scoped — `messages[]` snapshot/restore through
 * the {@link ConversationCheckpointStore} primitive that the
 * `ConvCheckpointWire` records into at turn boundaries.
 *
 * Three forms:
 *   - `/rewind-conv`             → list tags (newest-first)
 *   - `/rewind-conv --list`      → same as no-args (explicit flag)
 *   - `/rewind-conv <tag>`       → destructive-confirm preview + exit 1
 *                                  (UUX-6-09 — replacing the live
 *                                  conversation is destructive; parity with
 *                                  the `/rewind` + `/rewind-tool` confirm
 *                                  pattern).
 *   - `/rewind-conv <tag> --yes` → restore that snapshot; awaits the ONE
 *                                  live-history-swap seam
 *                                  (`applyLiveHistorySwap`) so the surface
 *                                  swaps its live history binding.
 *
 * Default-OFF posture (RFC §1.2): when `ctx.convCheckpoint` is absent
 * (no host wire was installed), the command prints "not wired in this
 * surface" + exit 0 (parity with the rest of the surface-only family —
 * /snooze /skills /side /memory etc.).
 *
 * Slice contract: lives in `src/apps/cli`. Imports ONLY this file's
 * sibling slash-commands types AND the wire from `./repl/conv-checkpoint-wire`.
 * No `@/agent/loop`, no `@/agent/dispatch`, no `@/storage`, no
 * `@/permission` — the wire owns the store interaction; this file is a
 * pure CLI adapter.
 */

import type { Message } from "@/llm"
import { applyLiveHistorySwap, BOLD_RED, confirmYesHint, RESET } from "./live-history-swap"
import type { ConvCheckpointWire } from "./repl/conv-checkpoint-wire"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension (typed declare-module)                       */
/* ------------------------------------------------------------------ */

/** Surface-supplied adapter on top of the {@link ConvCheckpointWire}.
 *  The wire itself owns `recordTurn` / `listTags` / `restore`; the
 *  surface adds `replaceMessages` because only the surface knows how to
 *  swap its live `history` binding (the wire is store-only). */
export interface ConvCheckpointSlashState {
  /** The wire — `listTags()` + `restore(tag)` consumed by this slash. */
  readonly wire: ConvCheckpointWire
  /** Surface-side hook: replace the live REPL transcript with the
   *  restored snapshot. Called ONLY when the user runs
   *  `/rewind-conv <tag>` and the tag exists. The adapter is responsible
   *  for any UI repaint after the swap. Rejections surface back through the
   *  slash path as command failures. */
  readonly replaceMessages: (msgs: ReadonlyArray<Message>) => Promise<void>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0292 conversation-checkpoint per-turn auto-record wire +
     *  surface-side `replaceMessages` adapter. Absent ⇒ `/rewind-conv`
     *  prints "not wired in this surface" and exits 0. */
    readonly convCheckpoint?: ConvCheckpointSlashState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* rendering (pure)                                                    */
/* ------------------------------------------------------------------ */

/** Deterministic timestamp format — UTC ISO, ms preserved so two
 *  records minted in the same millisecond still look distinct. */
const fmtTs = (epochMs: number): string => {
  const d = new Date(epochMs)
  // Defensive — `new Date(NaN).toISOString()` throws. The store hands us
  // whatever its clock returned; surface a stable placeholder rather
  // than letting the slash 500.
  if (Number.isNaN(d.getTime())) return "<invalid-time>"
  return d.toISOString()
}

/** Render `listTags()` output as one line per tag. Pure. */
export const renderTagList = (
  entries: readonly { readonly tag: string; readonly takenAt: number; readonly len: number }[],
): string => {
  if (entries.length === 0) return "(no checkpoints yet)\n"
  const lines = entries.map(
    (e) => `  ${e.tag}  ${fmtTs(e.takenAt)}  ${e.len} message${e.len === 1 ? "" : "s"}`,
  )
  const head = `${entries.length} checkpoint${entries.length === 1 ? "" : "s"}:`
  return `${head}\n${lines.join("\n")}\n`
}

/* ------------------------------------------------------------------ */
/* argv parsing (pure)                                                 */
/* ------------------------------------------------------------------ */

export type RewindConvArgs =
  | { readonly kind: "list" }
  | { readonly kind: "restore"; readonly tag: string; readonly yes: boolean }
  | { readonly kind: "err"; readonly message: string }

/** Mutable accumulator for {@link parseRewindConvArgs} — the per-token
 *  branch lives in {@link consumeConvArg} to keep the parser under biome's
 *  cognitive-complexity ceiling (same shape as rewind-tool's `consumeArg`). */
interface ConvArgAcc {
  tag?: string
  list: boolean
  yes: boolean
}

/** Consume one token into `acc`; returns an error message on rejection or
 *  `null` on success. `--yes`/`-y` is the UUX-6-09 destructive-confirm
 *  bypass (parity with /rewind). */
const consumeConvArg = (acc: ConvArgAcc, a: string): string | null => {
  if (a === "--list") {
    acc.list = true
    return null
  }
  if (a === "--yes" || a === "-y") {
    acc.yes = true
    return null
  }
  if (a.startsWith("--")) return `unknown flag: ${a}`
  if (a.length === 0) return "empty tag argument"
  if (acc.tag !== undefined) {
    return "takes at most one tag (use /rewind-conv, /rewind-conv --list, or /rewind-conv <tag> [--yes])"
  }
  acc.tag = a
  return null
}

export const parseRewindConvArgs = (args: readonly string[]): RewindConvArgs => {
  const acc: ConvArgAcc = { list: false, yes: false }
  for (const a of args) {
    const err = consumeConvArg(acc, a)
    if (err !== null) return { kind: "err", message: err }
  }
  if (acc.list && acc.tag !== undefined) {
    return { kind: "err", message: "--list takes no tag argument" }
  }
  if (acc.tag === undefined) return { kind: "list" }
  return { kind: "restore", tag: acc.tag, yes: acc.yes }
}

/* ------------------------------------------------------------------ */
/* registered SlashCommand                                             */
/* ------------------------------------------------------------------ */

export const rewindConvCmd: SlashCommand = {
  name: "/rewind-conv",
  describe:
    "Browse/restore per-turn conversation checkpoints (ADR-0292). /rewind-conv [<tag> | --list]",
  category: "session",
  async run(args, ctx) {
    const slot = ctx.convCheckpoint
    if (slot === undefined) {
      ctx.out("/rewind-conv: not wired in this surface\n")
      return 0
    }
    const parsed = parseRewindConvArgs(args)
    if (parsed.kind === "err") {
      ctx.err(`/rewind-conv: ${parsed.message}\n`)
      return 1
    }
    if (parsed.kind === "list") {
      const entries = slot.wire.listTags()
      ctx.out(renderTagList(entries))
      return 0
    }
    // restore — `wire.restore(tag)` is a READ (the snapshot lookup); the
    // mutation is the live-history swap below, so the preview path can
    // resolve the tag without touching anything.
    const restored = slot.wire.restore(parsed.tag)
    if (restored === null) {
      ctx.err(`/rewind-conv: no such tag: ${parsed.tag}\n`)
      return 1
    }
    // UUX-6-09 — destructive-confirm gate (same pattern /rewind renders: a
    // bold-red destructive verb + the shared `--yes` re-run hint). Replacing
    // the live conversation drops whatever the operator has NOT checkpointed,
    // so without --yes this REFUSES (exit 1) and changes nothing.
    if (!parsed.yes) {
      const taken = slot.wire.listTags().find((e) => e.tag === parsed.tag)
      const when = taken !== undefined ? `, taken ${fmtTs(taken.takenAt)}` : ""
      ctx.out(
        `[rewind-conv '${parsed.tag}' — will ${BOLD_RED}replace${RESET} the live conversation with this snapshot (${restored.length} message${restored.length === 1 ? "" : "s"}${when})]\n`,
      )
      ctx.out(confirmYesHint())
      return 1
    }
    // ONE live-history-swap seam (UUX-4-02 family) — same helper `/rewind`
    // and `/rewind-tool` route through. Rejections propagate (the dispatcher
    // surfaces them as command failures), preserving the pre-refactor
    // behavior byte-identically for the confirmed path.
    await applyLiveHistorySwap(slot, restored)
    ctx.out(
      `restored '${parsed.tag}' (${restored.length} message${restored.length === 1 ? "" : "s"}).\n`,
    )
    return 0
  },
  complete(args, _partial, ctx) {
    // After the tag positional, offer the confirm bypass (UUX-6-09).
    if (args.length >= 1) {
      return [{ value: "--yes", kind: "argument", description: "skip confirm prompt" }]
    }
    const hints: { readonly value: string; readonly kind: "argument" }[] = [
      { value: "--list", kind: "argument" as const },
    ]
    if (ctx.convCheckpoint === undefined) return hints
    for (const e of ctx.convCheckpoint.wire.listTags()) {
      hints.push({ value: e.tag, kind: "argument" as const })
    }
    return hints
  },
}

/** Internal hooks for test isolation — never re-exported through the
 *  barrel. */
export const __test = { fmtTs, renderTagList, parseRewindConvArgs }

// Pin the `SlashContext` symbol so the `declare module` extension above
// is treated as a side-effecting import rather than type-only-erased.
// (The CLI barrel imports this file for its value export, but defensive
// pinning keeps the augmentation alive even under aggressive bundlers.)
export type _SlashContextWithConvCheckpoint = SlashContext
