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
 * commands print the D-6 not-wired posture (hint names QUANTA_AUTOMATION) and
 * exit 2 (UUX-2-22 — exit 0 was a fake success).
 *
 * `create` syntax (UUX-4-16): `/cron create <RRULE> <title…> [-- <prompt…>]`.
 * Without the `--` separator the prompt DEFAULTS to the title — kept for
 * back-compat, but the output SAYS so instead of silently duplicating.
 *
 * Slice-clean: this module imports NO `@/scheduler` VALUE — the surface adapter
 * (which DOES own the RRULE parse + nextRun compute) exposes a duck-typed
 * {@link AutomationSlashState}. The command only formats.
 */

import { notWired } from "../not-wired"
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

const CRON_CREATE_USAGE =
  "/cron: usage = /cron create <RRULE> <title> [-- <prompt>] (e.g. /cron create FREQ=DAILY nightly build -- run the full suite)\n"

/** Parsed `create` tail: title words before the `--` separator, prompt words
 *  after it. No separator ⇒ `prompt` is undefined (title-as-prompt default). */
const splitTitlePrompt = (
  rest: readonly string[],
): { title: string; prompt: string | undefined; sawSeparator: boolean } => {
  const sep = rest.indexOf("--")
  if (sep < 0) return { title: rest.join(" ").trim(), prompt: undefined, sawSeparator: false }
  return {
    title: rest.slice(0, sep).join(" ").trim(),
    prompt: rest
      .slice(sep + 1)
      .join(" ")
      .trim(),
    sawSeparator: true,
  }
}

const runCronCreate = async (args: readonly string[], ctx: SlashContext): Promise<number> => {
  const automation = ctx.automation
  if (automation === undefined)
    return notWired(ctx.out, { feature: "/cron", gate: "QUANTA_AUTOMATION" })
  const rule = args[1]
  const { title, prompt, sawSeparator } = splitTitlePrompt(args.slice(2))
  // An explicit `--` with nothing after it is a shape error, never a silent
  // fall-back to the title (UUX-4-16).
  if (rule === undefined || title === "" || (sawSeparator && prompt === "")) {
    ctx.err(CRON_CREATE_USAGE)
    return 1
  }
  const effectivePrompt = prompt !== undefined && prompt !== "" ? prompt : title
  const res = await automation.create(title, rule, effectivePrompt)
  if (!res.ok) {
    ctx.err(`/cron: create failed — ${res.message}\n`)
    return 1
  }
  ctx.out(`/cron: created [${res.row.id}] ${res.row.title} (${res.row.rule})\n`)
  // UUX-4-16 — title-as-prompt is kept as the default, but SAID.
  if (prompt === undefined) {
    ctx.out(
      "note: prompt defaults to the title — use /cron create <RRULE> <title> -- <prompt> to set a separate prompt\n",
    )
  }
  return 0
}

/** `/cron` (alias `/schedule`) — list + create scheduled automations. Subcommands:
 *    - `list` (default) — render every schedule.
 *    - `create <RRULE> <title…> [-- <prompt…>]` — create a schedule; without
 *      `--` the prompt defaults to the title (and the output says so).
 *  Absent slot ⇒ D-6 not-wired posture + exit 2 (hint: QUANTA_AUTOMATION). */
export const cronCmd: SlashCommand = {
  name: "/cron",
  describe:
    "List/create scheduled automations (/cron, /cron create <RRULE> <title> [-- <prompt>]). Opt-in: QUANTA_AUTOMATION=1",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.automation === undefined) {
      return notWired(ctx.out, { feature: "/cron", gate: "QUANTA_AUTOMATION" })
    }
    const sub = args[0] ?? "list"
    const now = ctx.now?.() ?? Date.now()
    if (sub === "list") {
      const rows = await ctx.automation.list()
      ctx.out(`${renderCronList(rows, now)}\n`)
      return 0
    }
    if (sub === "create") return runCronCreate(args, ctx)
    ctx.err(
      `/cron: unknown subcommand '${sub}' (try list | create <RRULE> <title> [-- <prompt>])\n`,
    )
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
 *  command; now it exists). Absent slot ⇒ D-6 not-wired posture + exit 2. */
export const inboxCmd: SlashCommand = {
  name: "/inbox",
  describe: "Read the automation notification inbox",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.automation === undefined) {
      return notWired(ctx.out, { feature: "/inbox", gate: "QUANTA_AUTOMATION" })
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
