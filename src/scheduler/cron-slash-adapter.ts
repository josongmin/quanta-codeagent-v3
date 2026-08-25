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

import type { AgentRole } from "@/subagent/role"
import type { AutomationEnginePort, InboxItem, ScheduleInput } from "./automation-engine/port"
import { computeNextFire } from "./next-fire"
import { parseRRule, serializeRRule } from "./rrule-parser"
import type { RRule } from "./types"

/** RFC11-2 — the closed agent-role token set the scheduler accepts as a binding.
 *  These are the EXACT values of the EXISTING `@/subagent/role` `AgentRole`
 *  registry (`import type` keeps the pure-leaf slice free of a value edge into
 *  `@/subagent`; the `rfc11-2` drift-guard test imports the real `AGENT_ROLES`
 *  and asserts this stays byte-equal, so a registry change fails the build).
 *  A binding outside this set is refused at `create` — never persisted. */
const KNOWN_AGENT_ROLES: ReadonlyArray<AgentRole> = Object.freeze(["explorer", "worker", "none"])

/** `true` iff `role` is a member of the reused agent-role registry. */
const isKnownAgentRole = (role: string): role is AgentRole =>
  (KNOWN_AGENT_ROLES as ReadonlyArray<string>).includes(role)

/** RFC11-2 — the OPTIONAL role + git-base bindings a `create` may carry (Codex
 *  5973 `ScheduledTaskSchedule{agent_role, baseBranch}`). Both absent ⇒ a
 *  byte-identical pre-RFC11-2 schedule. */
export interface CronBindOpts {
  /** Agent-role the fired run adopts (validated against the reused registry). */
  readonly agentRole?: AgentRole
  /** Git base branch the fired run forks from (RFC-06 `createPersistentWorktree`). */
  readonly baseBranch?: string
}

/** A scheduled automation row the slash renders (canonical RRULE string). */
export interface CronRow {
  readonly id: string
  readonly title: string
  readonly rule: string
  readonly nextRunAt: number
  readonly prompt: string
  /** RFC11-2 — the bound agent-role, when the schedule carries one. */
  readonly agentRole?: string
  /** RFC11-2 — the bound git base-branch, when the schedule carries one. */
  readonly baseBranch?: string
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
  readonly create: (
    title: string,
    rule: string,
    prompt: string,
    /** RFC11-2 — OPTIONAL role + git-base bindings. Absent ⇒ byte-identical to
     *  the pre-RFC11-2 3-arg create. */
    bind?: CronBindOpts,
  ) => Promise<CronCreateResult>
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

/**
 * THE display-row projection: engine row -> `/cron` row (canonical RRULE
 * string + the two optional bindings).
 *
 * WHY THIS IS A UNIT: `list` and `create`'s success tail built the SAME six
 * fields with the SAME pair of conditional spreads — two near-identical branch
 * tails. Unified here, so the two surfaces are structurally incapable of
 * drifting, and `create` stops paying for four conditional spreads (each of
 * which cost DOUBLE inside the nested factory closure).
 */
const toCronRow = (a: {
  readonly id: string
  readonly title: string
  readonly rule: RRule
  readonly nextRunAt: number
  readonly prompt: string
  readonly agentRole?: string
  readonly baseBranch?: string
}): CronRow => ({
  id: a.id,
  title: a.title,
  // Re-serialize the stored parsed rule back to a canonical RRULE string.
  rule: serializeRRule(a.rule),
  nextRunAt: a.nextRunAt,
  prompt: a.prompt,
  ...(a.agentRole !== undefined ? { agentRole: a.agentRole } : {}),
  ...(a.baseBranch !== undefined ? { baseBranch: a.baseBranch } : {}),
})

/** Outcome of {@link planCronCreate}: either the typed refusal `create` returns
 *  verbatim, or the validated pieces of the row it is now cleared to persist. */
type CronCreatePlan =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true
      readonly title: string
      readonly rule: RRule
      readonly firstFire: number
      readonly createdAt: number
    }

/**
 * The four-gate admission chain a `create` must clear BEFORE the engine is
 * touched: non-empty title -> known agent-role -> parseable RRULE -> a rule
 * that can actually fire.
 *
 * WHY THIS IS A UNIT: these four are one concern — "is this request
 * admissible?" — and every one of them is a typed refusal, never a throw. They
 * were spelled inline inside the nested `create` closure, where each guard paid
 * a nesting surcharge; at module scope they cost their face value. Keeping them
 * in ONE function also pins the ORDER, which is observable: an unknown
 * `agent_role` is refused BEFORE any RRULE work, and `now()` is read only after
 * both cheap gates pass.
 *
 * Takes `now` rather than reading a clock: the single `now()` call is the
 * `createdAt` AND the next-fire anchor, exactly as before.
 */
const planCronCreate = (
  title: string,
  rule: string,
  bind: CronBindOpts | undefined,
  now: () => number,
): CronCreatePlan => {
  const trimmedTitle = title.trim()
  if (trimmedTitle.length === 0) return { ok: false, message: "title is required" }
  // RFC11-2 — validate the OPTIONAL agent-role binding against the REUSED
  // registry BEFORE any RRULE work so an unknown role is refused (typed,
  // never persisted) rather than silently dropped. An absent binding skips
  // this entirely (byte-identical). `baseBranch` is a free-form git ref —
  // sanitized/validated by the RFC-06 worktree owner at fire time.
  if (bind?.agentRole !== undefined && !isKnownAgentRole(bind.agentRole)) {
    return { ok: false, message: `unknown agent_role '${bind.agentRole}'` }
  }
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
  const firstFire = computeNextFire(rrule, createdAt, 0)
  if (firstFire === "never") {
    return { ok: false, message: "RRULE never fires (UNTIL past or COUNT 0)" }
  }
  return { ok: true, title: trimmedTitle, rule: rrule, firstFire, createdAt }
}

/** Build the `/cron` adapter over a live {@link AutomationEnginePort}. */
export const createCronSlashAdapter = (deps: CronSlashAdapterDeps): CronSlashState => {
  const now = deps.now ?? (() => Date.now())
  const idGen = deps.idGen ?? (() => crypto.randomUUID())

  const list = async (): Promise<readonly CronRow[]> => {
    const r = await deps.engine.list()
    if (!r.ok) return []
    return r.value.map(toCronRow)
  }

  const create = async (
    title: string,
    rule: string,
    prompt: string,
    bind?: CronBindOpts,
  ): Promise<CronCreateResult> => {
    const plan = planCronCreate(title, rule, bind, now)
    if (!plan.ok) return plan
    const input: ScheduleInput = {
      id: idGen(),
      title: plan.title,
      rule: plan.rule,
      prompt,
      nextRunAt: plan.firstFire,
      createdAt: plan.createdAt,
      // RFC11-2 — thread the OPTIONAL role/base bindings onto the engine input.
      // exactOptional: keys are OMITTED when absent so a bindless schedule is a
      // byte-identical row.
      ...(bind?.agentRole !== undefined ? { agentRole: bind.agentRole } : {}),
      ...(bind?.baseBranch !== undefined ? { baseBranch: bind.baseBranch } : {}),
    }
    const res = await deps.engine.schedule(input)
    if (!res.ok) return { ok: false, message: `${res.code}: ${res.message}` }
    return { ok: true, row: toCronRow(res.value) }
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
