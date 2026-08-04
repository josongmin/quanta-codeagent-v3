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
      ...(a.agentRole !== undefined ? { agentRole: a.agentRole } : {}),
      ...(a.baseBranch !== undefined ? { baseBranch: a.baseBranch } : {}),
    }))
  }

  const create = async (
    title: string,
    rule: string,
    prompt: string,
    bind?: CronBindOpts,
  ): Promise<CronCreateResult> => {
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
      // RFC11-2 — thread the OPTIONAL role/base bindings onto the engine input.
      // exactOptional: keys are OMITTED when absent so a bindless schedule is a
      // byte-identical row.
      ...(bind?.agentRole !== undefined ? { agentRole: bind.agentRole } : {}),
      ...(bind?.baseBranch !== undefined ? { baseBranch: bind.baseBranch } : {}),
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
        ...(res.value.agentRole !== undefined ? { agentRole: res.value.agentRole } : {}),
        ...(res.value.baseBranch !== undefined ? { baseBranch: res.value.baseBranch } : {}),
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
