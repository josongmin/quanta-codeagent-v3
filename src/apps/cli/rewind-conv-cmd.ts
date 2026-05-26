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
 *   - `/rewind-conv <tag>`       → restore that snapshot; awaits
 *                                  `ctx.convCheckpoint.replaceMessages(...)`
 *                                  so the surface swaps its live history
 *                                  binding.
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
  | { readonly kind: "restore"; readonly tag: string }
  | { readonly kind: "err"; readonly message: string }

export const parseRewindConvArgs = (args: readonly string[]): RewindConvArgs => {
  if (args.length === 0) return { kind: "list" }
  if (args.length > 1) {
    return {
      kind: "err",
      message:
        "takes at most one argument (use /rewind-conv, /rewind-conv --list, or /rewind-conv <tag>)",
    }
  }
  const head = args[0] as string
  if (head === "--list") return { kind: "list" }
  if (head.startsWith("--")) return { kind: "err", message: `unknown flag: ${head}` }
  if (head.length === 0) return { kind: "err", message: "empty tag argument" }
  return { kind: "restore", tag: head }
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
    // restore
    const restored = slot.wire.restore(parsed.tag)
    if (restored === null) {
      ctx.err(`/rewind-conv: no such tag: ${parsed.tag}\n`)
      return 1
    }
    await slot.replaceMessages(restored)
    ctx.out(
      `restored '${parsed.tag}' (${restored.length} message${restored.length === 1 ? "" : "s"}).\n`,
    )
    return 0
  },
  complete(args, _partial, ctx) {
    // Only complete the first positional. `--list` is the only known
    // flag; tag completion uses live `listTags()` when wired.
    if (args.length >= 1) return []
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
