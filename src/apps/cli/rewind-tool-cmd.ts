/**
 * `/rewind-tool` — ADR-0203 + ADR-0205 SOTA UX.
 *
 * Surfaces the `ThreeWayRestorePort` (Cline pattern) over the CLI so an
 * operator can:
 *
 *   - `/rewind-tool`                       → list the tagged anchors in
 *                                            the granular registry,
 *                                            newest-first, with tag /
 *                                            granularity / tool / sha-12.
 *   - `/rewind-tool <tag-prefix>`          → preview-only confirm line.
 *                                            Re-run with `--yes` to commit.
 *   - `/rewind-tool <tag-prefix> --mode=files|task|both [--yes]`
 *                                          → execute the chosen restore
 *                                            leg(s) and print the typed
 *                                            outcome.
 *
 * Default-OFF: `ctx.perToolCheckpoint` absent ⇒ "not wired in this
 * surface" and exit 0 (parity with `/snapshot`, `/side`, `/skills`).
 *
 * Slice contract: lives under `src/apps/cli` (slash UX is the top of the
 * slice DAG). Body reads ONLY `@/agent/per-tool-checkpoint` types — never
 * `@/storage/shadow-odb` or `@/agent/conversation-checkpoint` directly.
 * The composition root is the ONE place those ports are constructed and
 * wired into the slash context.
 */

import type {
  CheckpointTag,
  GranularRegistry,
  RestoreOptions,
  ThreeWayRestorePort,
} from "@/agent/per-tool-checkpoint"
import { errMessage } from "@/shared"
import { applyLiveHistorySwap } from "./live-history-swap"
import type { SlashCommand } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

/** Wiring slot for `/rewind-tool`. Both fields required when present —
 *  the slash command needs the registry to resolve `<tag-prefix>` and the
 *  restore port to perform the actual restore.
 *
 *  When `currentMessages` is supplied (REPL surface only), `/rewind-tool
 *  ... --mode=task|both` includes a `messagesBefore` snapshot in the
 *  printed outcome so the user can eyeball what they're dropping. */
export interface PerToolCheckpointSlashState {
  readonly registry: GranularRegistry
  readonly restore: ThreeWayRestorePort
  /** Live conversation messages for the task-leg `messagesBefore`
   *  capture. Returning an empty array is fine — the outcome carries
   *  whatever the caller surfaces. */
  readonly currentMessages?: () => ReadonlyArray<import("@/llm").Message>
  /** UUX-6-03 — live-history swap hook (the ONE seam, see
   *  `./live-history-swap.ts`). When present AND the executed mode includes
   *  the task leg (`task`/`both`) AND the outcome carries `messagesAfter`,
   *  the restored conversation is pushed into the live REPL history instead
   *  of only being PRINTED. Absent ⇒ prior print-only behavior. */
  readonly replaceMessages?: (msgs: ReadonlyArray<import("@/llm").Message>) => Promise<void>
}

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0203/0205 per-tool-checkpoint + 3-way restore wiring slot. */
    readonly perToolCheckpoint?: PerToolCheckpointSlashState | undefined
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const SHORT_SHA_LEN = 12

const shortSha = (sha: string): string =>
  sha.length <= SHORT_SHA_LEN ? sha : sha.slice(0, SHORT_SHA_LEN)

type RestoreMode = "files" | "task" | "both"

const isRestoreMode = (s: string): s is RestoreMode => s === "files" || s === "task" || s === "both"

interface ParsedArgs {
  readonly tagPrefix?: string
  readonly mode?: RestoreMode
  readonly yes: boolean
  readonly allowDirtyMerge: boolean
}

/** Mutable accumulator threaded through `parseArgs`. Keeps the cognitive-
 *  complexity ceiling on `parseArgs` low by factoring the per-token branch
 *  out into a tiny dedicated helper. */
interface ArgAcc {
  tagPrefix?: string
  mode?: RestoreMode
  yes: boolean
  allowDirtyMerge: boolean
}

/** Mutate `acc` in place for one token; return an error message string when
 *  the token is rejected, or `null` on success. Extracted to keep
 *  `parseArgs` under biome's cognitive-complexity ceiling. */
const consumeArg = (acc: ArgAcc, a: string): string | null => {
  if (a === "--yes" || a === "-y") {
    acc.yes = true
    return null
  }
  if (a === "--allow-dirty-merge") {
    acc.allowDirtyMerge = true
    return null
  }
  if (a.startsWith("--mode=")) {
    const v = a.slice("--mode=".length)
    if (!isRestoreMode(v)) return `invalid --mode: ${v} (use files | task | both)`
    acc.mode = v
    return null
  }
  if (a.startsWith("--")) return `unknown flag: ${a}`
  if (acc.tagPrefix !== undefined) return `unexpected extra argument: ${a}`
  acc.tagPrefix = a
  return null
}

const parseArgs = (args: readonly string[]): ParsedArgs | string => {
  const acc: ArgAcc = { yes: false, allowDirtyMerge: false }
  for (const a of args) {
    const err = consumeArg(acc, a)
    if (err !== null) return err
  }
  const out: ParsedArgs = {
    ...(acc.tagPrefix !== undefined ? { tagPrefix: acc.tagPrefix } : {}),
    ...(acc.mode !== undefined ? { mode: acc.mode } : {}),
    yes: acc.yes,
    allowDirtyMerge: acc.allowDirtyMerge,
  }
  return out
}

/** Resolve a tag prefix against the registry's `list()`. Returns the
 *  matched tag on hit; on miss / ambiguity returns the error message. */
const resolveTagPrefix = (registry: GranularRegistry, prefix: string): CheckpointTag | string => {
  const entries = registry.list()
  let hit: CheckpointTag | undefined
  for (const e of entries) {
    if (e.tag === prefix) {
      hit = e.tag
      break
    }
    if (e.tag.startsWith(prefix)) {
      if (hit !== undefined) {
        return `ambiguous tag prefix: ${prefix} (matches ${hit} and ${e.tag})`
      }
      hit = e.tag
    }
  }
  return hit ?? `tag not found: ${prefix}`
}

/** Render the registry as a fixed-width table. Pure. */
const renderRegistry = (registry: GranularRegistry): string => {
  const entries = registry.list()
  if (entries.length === 0) {
    return "(no granular anchors recorded yet)"
  }
  const lines: string[] = []
  lines.push(`granular anchors (${entries.length}):`)
  for (const e of entries) {
    const grain = e.granularity.padEnd(5)
    const tool = (e.toolName ?? "-").padEnd(16)
    lines.push(`  ${grain}  ${shortSha(e.sha)}  ${tool}  ${e.tag}`)
  }
  return lines.join("\n")
}

/** Render a `RestoreOutcome` as the printed body. Pure. */
const renderOutcome = (o: import("@/agent/per-tool-checkpoint").RestoreOutcome): string => {
  const lines: string[] = []
  const status = o.ok ? "OK" : `FAILED (${o.errorCode ?? "unknown"})`
  lines.push(`/rewind-tool: ${status} — ${o.message}`)
  if (o.filesChanged !== undefined && o.filesChanged.length > 0) {
    lines.push(`  files (${o.filesChanged.length}):`)
    for (const p of o.filesChanged.slice(0, 20)) lines.push(`    ${p}`)
    if (o.filesChanged.length > 20) {
      lines.push(`    … and ${o.filesChanged.length - 20} more`)
    }
  }
  if (o.messagesAfter !== undefined) {
    const beforeN = o.messagesBefore?.length ?? 0
    lines.push(`  conversation: ${beforeN} msgs → ${o.messagesAfter.length} msgs`)
  }
  if (o.originalCode !== undefined) {
    lines.push(`  (shadow-odb code: ${o.originalCode})`)
  }
  return lines.join("\n")
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

const runRestore = async (
  state: PerToolCheckpointSlashState,
  tag: CheckpointTag,
  mode: RestoreMode,
  allowDirtyMerge: boolean,
): Promise<import("@/agent/per-tool-checkpoint").RestoreOutcome> => {
  const before = state.currentMessages?.() ?? []
  const opts: RestoreOptions = {
    currentMessages: before,
    ...(allowDirtyMerge ? { allowDirtyMerge: true } : {}),
  }
  if (mode === "files") return await state.restore.restoreFiles(tag, opts)
  if (mode === "task") return await state.restore.restoreTask(tag, opts)
  return await state.restore.restoreBoth(tag, opts)
}

export const rewindToolCmd: SlashCommand = {
  name: "/rewind-tool",
  describe: "Restore from per-tool checkpoint (Cline 3-way: files|task|both)",
  category: "session",
  async run(args, ctx) {
    const state = ctx.perToolCheckpoint
    if (state === undefined) {
      ctx.out("/rewind-tool: not wired in this surface\n")
      return 0
    }
    const parsed = parseArgs(args)
    if (typeof parsed === "string") {
      ctx.err(`/rewind-tool: ${parsed}\n`)
      return 1
    }

    // List mode: no tag prefix.
    if (parsed.tagPrefix === undefined) {
      ctx.out(`${renderRegistry(state.registry)}\n`)
      ctx.out(
        "usage: /rewind-tool <tag-prefix> --mode=files|task|both [--yes] [--allow-dirty-merge]\n",
      )
      return 0
    }

    const resolved = resolveTagPrefix(state.registry, parsed.tagPrefix)
    if (resolved.startsWith("tag not found") || resolved.startsWith("ambiguous")) {
      ctx.err(`/rewind-tool: ${resolved}\n`)
      return 1
    }
    const tag = resolved as CheckpointTag

    // Mode required to actually do anything; preview if missing.
    if (parsed.mode === undefined) {
      ctx.out(`[preview] tag ${tag} — re-run with --mode=files|task|both [--yes] to restore\n`)
      return 0
    }

    // Confirmation gate (destructive — file leg writes the worktree, task
    // leg replaces in-memory messages). Skip when --yes.
    if (!parsed.yes) {
      ctx.out(
        `[/rewind-tool] would restore tag ${tag} with mode=${parsed.mode}. Re-run with --yes to commit.\n`,
      )
      return 0
    }

    const outcome = await runRestore(state, tag, parsed.mode, parsed.allowDirtyMerge)
    // UUX-6-03 — the task leg's restored conversation must reach the live
    // REPL history, not just the printed outcome. Swap through the ONE seam
    // BEFORE printing (effect receipt: success copy only after the effect).
    // Files-only mode NEVER swaps; a failed outcome never swaps; an outcome
    // without `messagesAfter` degrades to the prior print-only behavior.
    if (outcome.ok && (parsed.mode === "task" || parsed.mode === "both")) {
      try {
        await applyLiveHistorySwap(state, outcome.messagesAfter)
      } catch (e) {
        ctx.err(
          `/rewind-tool: restore succeeded, but the live history swap failed: ${errMessage(e)} — restart the session to reload the restored conversation\n`,
        )
        return 1
      }
    }
    ctx.out(`${renderOutcome(outcome)}\n`)
    return outcome.ok ? 0 : 1
  },
  complete(_args, _partial, _ctx) {
    return [
      { value: "--mode=files", kind: "argument", description: "restore files only" },
      { value: "--mode=task", kind: "argument", description: "restore conversation only" },
      { value: "--mode=both", kind: "argument", description: "restore files + conversation" },
      { value: "--yes", kind: "argument", description: "skip confirm prompt" },
      {
        value: "--allow-dirty-merge",
        kind: "argument",
        description: "allow rewind across in-progress merge (DESTRUCTIVE)",
      },
    ]
  },
}

/** Test-only re-exports. */
export const __test = {
  parseArgs,
  isRestoreMode,
  resolveTagPrefix,
  renderRegistry,
  renderOutcome,
  shortSha,
}
