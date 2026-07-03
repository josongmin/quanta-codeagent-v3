/**
 * B2 (jul-04 CLI-surfacing) — `/cron` slash ← automation-engine adapter.
 *
 * The `AutomationEnginePort` speaks `schedule(ScheduleInput)` / `list()` (rows
 * carry a PARSED {@link RRule} + a precomputed `nextRunAt`); the `/cron` slash
 * speaks a thin duck-typed `create(title, rule, prompt)` / `list()` / `inbox()`
 * over CANONICAL RRULE STRINGS + display rows. This adapter bridges the two:
 *
 *   - `create` PARSES the RRULE string (`parseRRule`) — invalid ⇒ a typed
 *     `{ ok:false, message }` (NEVER a throw / crash) — computes the first fire
 *     via the SAME pure `computeNextFire` the ticker uses (NO new scheduler dep),
 *     mints an id + `createdAt`, and calls `engine.schedule`.
 *   - `list` maps every non-cancelled `EngineAutomation` back to a display row,
 *     re-serializing its stored {@link RRule} to a canonical RRULE string.
 *   - `inbox` reads the engine's notification inbox via the duck-typed `.inbox`
 *     inspection array (present on the in-memory engine; sqlite exposes the same
 *     shape through the host's injected reader). Absent ⇒ `[]` (never throws).
 *
 * NO new dependency: RRULE parse + next-fire reuse `@/scheduler`'s own
 * `rrule-parser` + `next-fire`. Pure except the injected `now` / `idGen`.
 *
 * Slice-clean: lives in `@/scheduler` (owns the RRULE + engine types). The CLI
 * `/cron` command imports only the duck-typed `AutomationSlashState` it declares,
 * so this adapter is the ONE place the two vocabularies meet.
 */

import type { AutomationEnginePort, InboxItem, ScheduleInput } from "./automation-engine/port"
import { computeNextFire } from "./next-fire"
import { parseRRule, serializeRRule } from "./rrule-parser"

/** A scheduled automation row the slash renders (canonical RRULE string). */
export interface CronRow {
  readonly id: string
  readonly title: string
  readonly rule: string
  readonly nextRunAt: number
  readonly prompt: string
}

/** A notification-inbox row the slash renders. */
export interface CronInboxRow {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly createdAt: number
  readonly read: boolean
}

/** Closed create-result union — no throw. */
export type CronCreateResult =
  | { readonly ok: true; readonly row: CronRow }
  | { readonly ok: false; readonly message: string }

/** The duck-typed slash port the CLI `/cron` command consumes. STRUCTURALLY
 *  identical to `apps/cli/slash/cron-cmd#AutomationSlashState` (the slice fence
 *  forbids `@/scheduler` from importing `@/apps/cli`), so the adapter is directly
 *  assignable at the surface. */
export interface CronSlashState {
  readonly list: () => Promise<readonly CronRow[]>
  readonly create: (title: string, rule: string, prompt: string) => Promise<CronCreateResult>
  readonly inbox: () => Promise<readonly CronInboxRow[]>
}

/** Injectable seams for {@link createCronSlashAdapter}. */
export interface CronSlashAdapterDeps {
  readonly engine: AutomationEnginePort
  /** Clock for `createdAt` + the next-fire anchor. Default `Date.now`. */
  readonly now?: () => number
  /** Fresh schedule-id generator. Default `crypto.randomUUID`. */
  readonly idGen?: () => string
}

/** Read the engine's inbox via the duck-typed `.inbox` inspection array (the
 *  in-memory engine exposes it; the host injects the same shape for sqlite).
 *  Engines without it report `[]` — the slash shows an empty inbox, never a
 *  crash. Mirrors `automation-banner#defaultUnreadCounter`'s duck-typed read. */
const readInbox = (engine: AutomationEnginePort): readonly InboxItem[] => {
  const dux = (engine as { readonly inbox?: ReadonlyArray<InboxItem> }).inbox
  return dux ?? []
}

/** Build the `/cron` adapter over a live {@link AutomationEnginePort}. */
export const createCronSlashAdapter = (deps: CronSlashAdapterDeps): CronSlashState => {
  const now = deps.now ?? (() => Date.now())
  const idGen = deps.idGen ?? (() => crypto.randomUUID())

  const list = async (): Promise<readonly CronRow[]> => {
    const r = await deps.engine.list()
    if (!r.ok) return []
    return r.value.map((a) => ({
      id: a.id,
      title: a.title,
      // Re-serialize the stored parsed rule back to a canonical RRULE string.
      rule: serializeRRule(a.rule),
      nextRunAt: a.nextRunAt,
      prompt: a.prompt,
    }))
  }

  const create = async (title: string, rule: string, prompt: string): Promise<CronCreateResult> => {
    const trimmedTitle = title.trim()
    if (trimmedTitle.length === 0) return { ok: false, message: "title is required" }
    // PARSE the RRULE — an invalid rule yields a typed refusal, never a throw.
    const parsed = parseRRule(rule)
    if (!parsed.ok) {
      return { ok: false, message: `invalid RRULE — ${parsed.message}` }
    }
    // Strip the `ok` discriminant off the parse result to recover the bare RRule.
    const { ok: _ok, ...rrule } = parsed
    const createdAt = now()
    // First fire from the SAME pure evaluator the ticker uses (fireCount 0). A
    // rule that can never fire (e.g. UNTIL already past) yields "never" ⇒ refuse
    // rather than schedule a dead row.
    const first = computeNextFire(rrule, createdAt, 0)
    if (first === "never") {
      return { ok: false, message: "RRULE never fires (UNTIL past or COUNT 0)" }
    }
    const input: ScheduleInput = {
      id: idGen(),
      title: trimmedTitle,
      rule: rrule,
      prompt,
      nextRunAt: first,
      createdAt,
    }
    const res = await deps.engine.schedule(input)
    if (!res.ok) return { ok: false, message: `${res.code}: ${res.message}` }
    return {
      ok: true,
      row: {
        id: res.value.id,
        title: res.value.title,
        rule: serializeRRule(res.value.rule),
        nextRunAt: res.value.nextRunAt,
        prompt: res.value.prompt,
      },
    }
  }

  const inbox = async (): Promise<readonly CronInboxRow[]> => {
    const items = readInbox(deps.engine)
    // Unread-first, then newest-first — stable, matches the banner's discipline.
    return [...items]
      .sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt)
      .map((i) => ({
        id: i.id,
        title: i.title,
        summary: i.summary,
        createdAt: i.createdAt,
        read: i.read,
      }))
  }

  return { list, create, inbox }
}
