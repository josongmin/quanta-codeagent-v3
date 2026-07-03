/**
 * B2 (jul-03) — `/cron` (alias `/schedule`) + `/inbox` surface.
 *
 * The automation engine (`QUANTA_AUTOMATION`) can schedule recurring agent runs
 * (RFC 5545 RRULEs) and records a notification inbox on each fire. The REPL's
 * automation-banner references `/inbox` but NO such command existed, and there
 * was no way to LIST or CREATE schedules from the CLI.
 *
 * `/cron` lists + creates schedules against the live engine; `/inbox` reads the
 * notification inbox. Both are DEFAULT-OFF: the `automation` ctx slot is threaded
 * ONLY when `QUANTA_AUTOMATION` is on AND the engine is reachable; absent ⇒ the
 * commands print "not wired" + exit 0.
 *
 * Slice-clean: this module imports NO `@/scheduler` VALUE — the surface adapter
 * (which DOES own the RRULE parse + nextRun compute) exposes a duck-typed
 * {@link AutomationSlashState}. The command only formats.
 */

import type { SlashCommand, SlashContext } from "../slash-contract"

/** A scheduled automation row (structural mirror of `EngineAutomation`). */
export interface CronRow {
  readonly id: string
  readonly title: string
  /** Canonical RRULE string (e.g. `FREQ=DAILY;INTERVAL=1`). */
  readonly rule: string
  readonly nextRunAt: number
  readonly prompt: string
}

/** A notification-inbox row (structural mirror of `InboxItem`). */
export interface CronInboxRow {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly createdAt: number
  readonly read: boolean
}

/** Result of a create attempt — closed union (no throw). */
export type CronCreateResult =
  | { readonly ok: true; readonly row: CronRow }
  | { readonly ok: false; readonly message: string }

/** The `/cron` + `/inbox` wire over the live automation engine. The surface
 *  adapter owns the RRULE parse + nextRun compute + engine calls; this state is
 *  the closed port the slash consumes. */
export interface AutomationSlashState {
  /** Enumerate all non-cancelled schedules (engine `list`). */
  readonly list: () => Promise<readonly CronRow[]>
  /** Create a schedule from a title + RRULE string + prompt. The adapter parses
   *  the rule, computes the first fire, and calls engine `schedule`. */
  readonly create: (title: string, rule: string, prompt: string) => Promise<CronCreateResult>
  /** Read the notification inbox (unread-first). */
  readonly inbox: () => Promise<readonly CronInboxRow[]>
}

/** Render one schedule row: id, title, rule, next-fire. Pure. */
const renderCronRow = (r: CronRow, now: number): string => {
  const dueInMs = r.nextRunAt - now
  const due = dueInMs <= 0 ? "due" : `in ${Math.round(dueInMs / 1000)}s`
  return `  [${r.id}] ${r.title} — ${r.rule} · next ${due}`
}

/** Render the schedule list. Pure — the caller supplies the live rows + clock. */
export const renderCronList = (rows: readonly CronRow[], now: number): string => {
  if (rows.length === 0) return "/cron: no schedules"
  return [`Schedules — ${rows.length}:`, ...rows.map((r) => renderCronRow(r, now))].join("\n")
}

/** Render the notification inbox. Pure. */
export const renderInbox = (rows: readonly CronInboxRow[]): string => {
  if (rows.length === 0) return "/inbox: empty"
  const unread = rows.filter((r) => !r.read).length
  const lines = rows.map((r) => `  ${r.read ? " " : "●"} [${r.id}] ${r.title} — ${r.summary}`)
  return [`Inbox — ${rows.length} item(s), ${unread} unread:`, ...lines].join("\n")
}

/** `/cron` (alias `/schedule`) — list + create scheduled automations. Subcommands:
 *    - `list` (default) — render every schedule.
 *    - `create <RRULE> <title...>` — create a schedule (prompt = title).
 *  Absent slot ⇒ "not wired" + exit 0 (default-OFF byte-identical). */
export const cronCmd: SlashCommand = {
  name: "/cron",
  describe:
    "List/create scheduled automations (/cron, /cron create <RRULE> <title>). Opt-in: QUANTA_AUTOMATION=on",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.automation === undefined) {
      ctx.out("/cron: not wired in this surface (set QUANTA_AUTOMATION=on)\n")
      return 0
    }
    const sub = args[0] ?? "list"
    const now = ctx.now?.() ?? Date.now()
    if (sub === "list") {
      const rows = await ctx.automation.list()
      ctx.out(`${renderCronList(rows, now)}\n`)
      return 0
    }
    if (sub === "create") {
      const rule = args[1]
      const title = args.slice(2).join(" ").trim()
      if (rule === undefined || title === "") {
        ctx.err(
          "/cron: usage = /cron create <RRULE> <title> (e.g. /cron create FREQ=DAILY nightly build)\n",
        )
        return 1
      }
      const res = await ctx.automation.create(title, rule, title)
      if (!res.ok) {
        ctx.err(`/cron: create failed — ${res.message}\n`)
        return 1
      }
      ctx.out(`/cron: created [${res.row.id}] ${res.row.title} (${res.row.rule})\n`)
      return 0
    }
    ctx.err(`/cron: unknown subcommand '${sub}' (try list | create <RRULE> <title>)\n`)
    return 1
  },
}

/** `/schedule` — long-form alias for `/cron`. Same body so both names surface in
 *  `/help` (the renderer iterates the registry verbatim). */
export const scheduleCmd: SlashCommand = {
  name: "/schedule",
  describe: "Alias for /cron",
  category: "other",
  run: cronCmd.run,
}

/** `/inbox` — read the automation notification inbox (the banner references this
 *  command; now it exists). Absent slot ⇒ "not wired" + exit 0. */
export const inboxCmd: SlashCommand = {
  name: "/inbox",
  describe: "Read the automation notification inbox",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.automation === undefined) {
      ctx.out("/inbox: not wired in this surface (set QUANTA_AUTOMATION=on)\n")
      return 0
    }
    if (args.length > 0) {
      ctx.err("/inbox: takes no arguments\n")
      return 1
    }
    const rows = await ctx.automation.inbox()
    ctx.out(`${renderInbox(rows)}\n`)
    return 0
  },
}
