/**
 * `/queue` slash command — ADR-0221 (Queued follow-up per-msg manage).
 *
 * Surfaces the four ADR-0221 mutators (`retry` / `edit` / `delete` /
 * `sendNow`) plus a `list` inspector over the CLI so an operator can
 * directly manage queued follow-ups WITHOUT waiting for the active turn to
 * end. Mirrors Codex Desktop composer's queued-message context menu.
 *
 * Subcommands:
 *   /queue list                       — print live entries (all threads)
 *   /queue retry <id-prefix>          — re-enqueue with fresh id/timestamp
 *   /queue edit <id-prefix> <text...> — replace entry text in-place
 *   /queue delete <id-prefix>         — remove entry from queue
 *   /queue send-now <id-prefix>       — inject into NEXT turn (no interrupt)
 *
 * Default-OFF: `ctx.planQueue` absent ⇒ "not wired in this surface" and
 * exit 0 (parity with `/snapshot`, `/side`, `/skills`, `/rewind-tool`).
 *
 * Slice discipline: lives under `src/apps/cli`. Body type-imports
 * `@/agent/plan-queue` only — never `@/agent/loop` or the LLM stack. The
 * composition root is the ONE place the queue + send-now sink are
 * constructed and wired into the slash context.
 *
 * Id-prefix resolution mirrors `/rewind-tool`: exact id wins; otherwise a
 * unique prefix wins; ambiguous prefix returns an error. This lets the
 * operator type `fu-t1-` or even just `1` instead of the full id.
 *
 * No-throw surface: every public path returns an exit code; thrown errors
 * are caught and surfaced as exit 1 + a typed message.
 */

import type { FollowUp, PlanQueueStore, QueueMutateError } from "@/agent/plan-queue"
import type { SlashCommand, SlashContext } from "./slash-commands"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

/** Wiring slot for `/queue`. Single port = the live {@link PlanQueueStore}
 *  the REPL surface constructs at session start. The send-now sink is wired
 *  INSIDE the store at construction (`defaultPlanQueueStore({sendNowSink})`)
 *  rather than via a second slash field — keeps the slash context shape
 *  minimal and lets the host swap sinks without touching the slash layer. */
declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0221 per-msg mutator wiring. Absent ⇒ `/queue *` prints
     *  "not wired in this surface" and exits 0. */
    readonly planQueue?: PlanQueueStore | undefined
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Snapshot of every live entry across every thread, in (thread, enqueued)
 *  order. Used by `list` AND by id-prefix resolution. */
const allLiveEntries = (store: PlanQueueStore): readonly FollowUp[] => {
  const out: FollowUp[] = []
  for (const [, entries] of store.inspect()) {
    for (const e of entries) out.push(e)
  }
  return out
}

/** Resolve `<id-prefix>` against the live cross-thread set.
 *   - exact id match wins (even if other ids share it as a prefix);
 *   - unique prefix match wins;
 *   - ambiguous prefix returns a string error;
 *   - no match returns a string error. */
const resolveEntryId = (store: PlanQueueStore, prefix: string): FollowUp | string => {
  const all = allLiveEntries(store)
  // Exact match first.
  const exact = all.find((e) => e.id === prefix)
  if (exact !== undefined) return exact
  const prefixed = all.filter((e) => e.id.startsWith(prefix))
  if (prefixed.length === 0) return `entry not found: ${prefix}`
  if (prefixed.length > 1) {
    const examples = prefixed
      .slice(0, 3)
      .map((e) => e.id)
      .join(", ")
    return `ambiguous id prefix: ${prefix} (matches ${prefixed.length} entries: ${examples}${
      prefixed.length > 3 ? ", …" : ""
    })`
  }
  // length === 1 — narrow.
  const only = prefixed[0]
  if (only === undefined) return `entry not found: ${prefix}` // unreachable; type guard
  return only
}

/** Truncate text for display in the list view. Multi-line ⇒ first line +
 *  ellipsis; long single line ⇒ slice + ellipsis. Keeps `/queue list`
 *  scannable even when entries hold pasted blocks. */
const truncateOneLine = (s: string, max = 60): string => {
  const firstLine = s.split("\n", 1)[0] ?? ""
  const collapsed = firstLine.length === s.length ? firstLine : `${firstLine}…`
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1)}…`
}

/** Format the list-view body. Pure. Returns at least the empty-state line. */
const renderList = (store: PlanQueueStore): string => {
  const inspected = store.inspect()
  if (inspected.size === 0) return "(queue empty)"
  const lines: string[] = []
  let total = 0
  for (const arr of inspected.values()) total += arr.length
  lines.push(`queued follow-ups (${total} across ${inspected.size} thread(s)):`)
  for (const [tid, entries] of inspected) {
    lines.push(`  thread ${tid}: ${entries.length}`)
    for (const e of entries) {
      const flags: string[] = []
      if (e.urgent) flags.push("urgent")
      flags.push(e.source)
      flags.push(e.pausedReason)
      const flagStr = flags.length > 0 ? ` [${flags.join(" ")}]` : ""
      const labelStr = e.label !== undefined ? ` ⟪${e.label}⟫` : ""
      lines.push(`    ${e.id}${labelStr}${flagStr}  ${truncateOneLine(e.text)}`)
    }
  }
  return lines.join("\n")
}

/** Surface a typed {@link QueueMutateError} as a human-readable string.
 *  Pure helper — every subcommand shares the same vocabulary so a UI
 *  reading slash output can pattern-match. */
const explainMutateError = (op: string, err: QueueMutateError): string => {
  switch (err) {
    case "not-found":
      return `/queue ${op}: entry not found (already drained or deleted)`
    case "already-active":
      return `/queue ${op}: entry is currently active (race — try again)`
    case "invalid-text":
      return `/queue ${op}: invalid text (empty, whitespace-only, or exceeds 64KiB)`
    case "send-not-possible":
      return `/queue ${op}: send-now sink not wired or rejected the payload`
  }
}

/** Print a per-mutator success line. Pure formatter for test assertions. */
const renderMutateOk = (op: string, entryId: string, extra?: string): string =>
  extra === undefined
    ? `/queue ${op}: ok (${entryId})\n`
    : `/queue ${op}: ok (${entryId}) — ${extra}\n`

/* ------------------------------------------------------------------ */
/* subcommand dispatch                                                 */
/* ------------------------------------------------------------------ */

type SubResult = { code: number }

const runList = (store: PlanQueueStore, args: readonly string[], ctx: SlashContext): SubResult => {
  if (args.length > 0) {
    ctx.err(`/queue list: takes no arguments; got ${args.length}\n`)
    return { code: 1 }
  }
  ctx.out(`${renderList(store)}\n`)
  return { code: 0 }
}

const runRetry = (store: PlanQueueStore, args: readonly string[], ctx: SlashContext): SubResult => {
  if (args.length !== 1) {
    ctx.err("/queue retry: expected exactly one argument (entry id or prefix)\n")
    return { code: 1 }
  }
  const id = args[0]
  if (id === undefined || id === "") {
    ctx.err("/queue retry: empty id\n")
    return { code: 1 }
  }
  const resolved = resolveEntryId(store, id)
  if (typeof resolved === "string") {
    ctx.err(`/queue retry: ${resolved}\n`)
    return { code: 1 }
  }
  const r = store.retry(resolved.id)
  if (!r.ok) {
    ctx.err(`${explainMutateError("retry", r.error)}\n`)
    return { code: 1 }
  }
  ctx.out(renderMutateOk("retry", resolved.id, `new id ${r.value.id}`))
  return { code: 0 }
}

const runEdit = (store: PlanQueueStore, args: readonly string[], ctx: SlashContext): SubResult => {
  if (args.length < 2) {
    ctx.err("/queue edit: expected at least two arguments (entry id, new text)\n")
    return { code: 1 }
  }
  const id = args[0]
  if (id === undefined || id === "") {
    ctx.err("/queue edit: empty id\n")
    return { code: 1 }
  }
  const newText = args.slice(1).join(" ")
  const resolved = resolveEntryId(store, id)
  if (typeof resolved === "string") {
    ctx.err(`/queue edit: ${resolved}\n`)
    return { code: 1 }
  }
  const r = store.edit(resolved.id, newText)
  if (!r.ok) {
    ctx.err(`${explainMutateError("edit", r.error)}\n`)
    return { code: 1 }
  }
  // r.value.id may differ from resolved.id when edit collapsed to a merge
  // target — surface the survivor id so the operator knows.
  const note = r.value.id !== resolved.id ? `merged into ${r.value.id}` : undefined
  ctx.out(renderMutateOk("edit", resolved.id, note))
  return { code: 0 }
}

const runDelete = (
  store: PlanQueueStore,
  args: readonly string[],
  ctx: SlashContext,
): SubResult => {
  if (args.length !== 1) {
    ctx.err("/queue delete: expected exactly one argument (entry id or prefix)\n")
    return { code: 1 }
  }
  const id = args[0]
  if (id === undefined || id === "") {
    ctx.err("/queue delete: empty id\n")
    return { code: 1 }
  }
  const resolved = resolveEntryId(store, id)
  if (typeof resolved === "string") {
    ctx.err(`/queue delete: ${resolved}\n`)
    return { code: 1 }
  }
  const r = store.delete(resolved.id)
  if (!r.ok) {
    ctx.err(`${explainMutateError("delete", r.error)}\n`)
    return { code: 1 }
  }
  ctx.out(renderMutateOk("delete", resolved.id))
  return { code: 0 }
}

const runSendNow = (
  store: PlanQueueStore,
  args: readonly string[],
  ctx: SlashContext,
): SubResult => {
  if (args.length !== 1) {
    ctx.err("/queue send-now: expected exactly one argument (entry id or prefix)\n")
    return { code: 1 }
  }
  const id = args[0]
  if (id === undefined || id === "") {
    ctx.err("/queue send-now: empty id\n")
    return { code: 1 }
  }
  const resolved = resolveEntryId(store, id)
  if (typeof resolved === "string") {
    ctx.err(`/queue send-now: ${resolved}\n`)
    return { code: 1 }
  }
  const r = store.sendNow(resolved.id)
  if (!r.ok) {
    ctx.err(`${explainMutateError("send-now", r.error)}\n`)
    return { code: 1 }
  }
  ctx.out(renderMutateOk("send-now", resolved.id))
  return { code: 0 }
}

/* ------------------------------------------------------------------ */
/* command export                                                      */
/* ------------------------------------------------------------------ */

const SUBCOMMANDS = ["list", "retry", "edit", "delete", "send-now"] as const

export const queueCmd: SlashCommand = {
  name: "/queue",
  describe: "Manage queued follow-ups (list / retry / edit / delete / send-now)",
  category: "session",
  async run(args, ctx) {
    const store = ctx.planQueue
    if (store === undefined) {
      ctx.out("/queue: not wired in this surface\n")
      return 0
    }
    if (args.length === 0) {
      ctx.err(`/queue: missing subcommand (use: ${SUBCOMMANDS.join(" | ")})\n`)
      return 1
    }
    const sub = args[0]
    const rest = args.slice(1)
    let outcome: SubResult
    try {
      switch (sub) {
        case "list":
          outcome = runList(store, rest, ctx)
          break
        case "retry":
          outcome = runRetry(store, rest, ctx)
          break
        case "edit":
          outcome = runEdit(store, rest, ctx)
          break
        case "delete":
          outcome = runDelete(store, rest, ctx)
          break
        case "send-now":
          outcome = runSendNow(store, rest, ctx)
          break
        default:
          ctx.err(
            `/queue: unknown subcommand: ${sub ?? "(empty)"} (use: ${SUBCOMMANDS.join(" | ")})\n`,
          )
          outcome = { code: 1 }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.err(`/queue ${sub}: unexpected failure: ${msg}\n`)
      return 1
    }
    return outcome.code
  },
  complete(args, _partial, _ctx) {
    // First token after `/queue` ⇒ suggest subcommands.
    if (args.length === 0) {
      return SUBCOMMANDS.map((s) => ({
        value: s,
        kind: "argument" as const,
        description: `/queue ${s}`,
      }))
    }
    return []
  },
}

/** Test-only re-exports — keeps internal helpers grep-able from the test
 *  suite without polluting the public API. */
export const __test = {
  allLiveEntries,
  resolveEntryId,
  renderList,
  renderMutateOk,
  explainMutateError,
  truncateOneLine,
  SUBCOMMANDS,
}
