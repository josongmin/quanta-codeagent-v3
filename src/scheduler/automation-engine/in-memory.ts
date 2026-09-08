/**
 * ADR-0215 — In-memory `AutomationEnginePort` adapter.
 *
 * Reference implementation: zero deps, deterministic, structural-equal-on-output.
 * Used by:
 *   - unit tests (no SQLite handle)
 *   - hosts that do NOT want persistence (ephemeral schedulers)
 *   - the default seam when the composition root chooses not to wire SQLite
 *
 * Idempotence:
 *   - `schedule(dup)` → `duplicate-id`
 *   - `cancel(missing)` → `{ok:true}` (idempotent)
 *   - `markRun(missing)` → `not-found` (loud — runtime divergence)
 *   - `markRun` is atomic: a single-row mutation. No partial state.
 *
 * Order discipline: `list()` and `next()` always sort `nextRunAt ASC, id ASC`
 * so two independent runs over the same data produce byte-identical results.
 */

import type {
  AutomationEnginePort,
  AutomationRun,
  ClaimedRun,
  ClaimOpts,
  EngineAutomation,
  EngineResult,
  FinalizeInput,
  InboxItem,
  MarkRunInput,
  ScheduleInput,
} from "./port"
import {
  advancedStatus,
  defaultRunIdAllocator,
  makeSeq,
  mintClaimToken,
  type RunIdAllocator,
} from "./run-model"

/**
 * Build an in-memory engine. Each call returns an INDEPENDENT instance —
 * tests share no mutable state across cases.
 *
 * Optional `idAllocator` injects deterministic run/inbox ids; default is
 * `${automationId}-${firedAt}` which is collision-free in normal flow but
 * NOT guaranteed unique under same-ms double-fire (tests inject a counter).
 */
export interface InMemoryAutomationEngineOpts {
  /** Override run / inbox id generation. Pure, deterministic. The `seq`
   *  argument is a monotonic same-ms disambiguator (T10 M8). */
  readonly idAllocator?: RunIdAllocator
}

export interface InMemoryAutomationEngine extends AutomationEnginePort {
  /** Inspection seam — test-only. Returns a frozen snapshot of runs. */
  readonly runs: ReadonlyArray<AutomationRun>
  /** Inspection seam — test-only. Returns a frozen snapshot of inbox. */
  readonly inbox: ReadonlyArray<InboxItem>
}

/** The per-automation config a row is created with and NEVER recomputes:
 *  model routing, agent role, base branch, and the heartbeat/policy binding. */
type ImmutableConfig = Pick<
  EngineAutomation,
  | "model"
  | "modelFallbacks"
  | "agentRole"
  | "baseBranch"
  | "kind"
  | "targetThreadId"
  | "inheritedPolicy"
>

/**
 * Carry the immutable config across a row rewrite, omitting absent keys.
 *
 * A unit because "immutable" only holds if EVERY rewrite carries the whole set:
 * `schedule`, `claim`, and the fire/finalize advance each rebuild the row from
 * scratch, and one that forgot a field would silently strip an automation's
 * routing or inherited policy. Stating the set once makes that impossible.
 */
const immutableConfig = (src: ImmutableConfig): ImmutableConfig => ({
  ...(src.model !== undefined ? { model: src.model } : {}),
  ...(src.modelFallbacks !== undefined ? { modelFallbacks: src.modelFallbacks } : {}),
  ...(src.agentRole !== undefined ? { agentRole: src.agentRole } : {}),
  ...(src.baseBranch !== undefined ? { baseBranch: src.baseBranch } : {}),
  ...(src.kind !== undefined ? { kind: src.kind } : {}),
  ...(src.targetThreadId !== undefined ? { targetThreadId: src.targetThreadId } : {}),
  ...(src.inheritedPolicy !== undefined ? { inheritedPolicy: src.inheritedPolicy } : {}),
})

/** The prior-fire record a claim preserves — a claim changes who holds the row,
 *  never what happened to it last time. Omits absent keys (exactOptional). */
const runHistory = (
  src: Pick<EngineAutomation, "lastRunAt" | "lastError">,
): Pick<EngineAutomation, "lastRunAt" | "lastError"> => ({
  ...(src.lastRunAt !== undefined ? { lastRunAt: src.lastRunAt } : {}),
  ...(src.lastError !== undefined ? { lastError: src.lastError } : {}),
})

/**
 * Keep whichever of the two rows sorts first by `nextRunAt ASC, id ASC`.
 *
 * A unit because that ordering IS the module's order discipline (see header):
 * `next` and `claim` must pick the same row for the same table, and two inlined
 * copies of the tie-break are exactly how that guarantee rots.
 */
const earlierDue = (
  best: EngineAutomation | null,
  candidate: EngineAutomation,
): EngineAutomation => {
  if (best === null) return candidate
  if (candidate.nextRunAt < best.nextRunAt) return candidate
  if (candidate.nextRunAt === best.nextRunAt && candidate.id < best.id) return candidate
  return best
}

/**
 * Whether a claimer may take this row right now.
 *
 * A unit because reclaim is the ONLY way a `running` row re-enters the pool:
 * both arms — due-and-scheduled, and a claim gone stale past `reclaimBefore` —
 * have to be stated together, or a crashed worker's row is either stranded
 * forever or stolen while its claim is still fresh.
 */
const isClaimable = (r: EngineAutomation, now: number, claimOpts?: ClaimOpts): boolean =>
  (r.status === "scheduled" && r.nextRunAt <= now) ||
  (r.status === "running" &&
    claimOpts?.reclaimBefore !== undefined &&
    r.claimedAt !== undefined &&
    r.claimedAt <= claimOpts.reclaimBefore)

/** The backing tables and the id/sequence allocators. */
const autoTables = (opts: InMemoryAutomationEngineOpts = {}) => {
  const rows = new Map<string, EngineAutomation>()
  const runsBacking: AutomationRun[] = []
  const inboxBacking: InboxItem[] = []
  const idAlloc = opts.idAllocator ?? defaultRunIdAllocator
  const nextSeq = makeSeq()
  return { opts, rows, runsBacking, inboxBacking, idAlloc, nextSeq }
}

/** Row construction from a rule. */
const autoRows = () => {
  // exactOptional: rebuild row WITHOUT setting absent optional keys to
  // `undefined`. Re-used by `schedule` and `markRun` so the omission rule
  // lives in one place.
  const buildRow = (over: {
    id: string
    title: string
    rule: EngineAutomation["rule"]
    prompt: string
    nextRunAt: number
    status: EngineAutomation["status"]
    createdAt: number
    fireCount: number
    lastRunAt?: number
    lastError?: string
    claimToken?: string
    claimedAt?: number
    model?: string
    modelFallbacks?: ReadonlyArray<string>
    agentRole?: string
    baseBranch?: string
    kind?: "heartbeat"
    targetThreadId?: string
    inheritedPolicy?: EngineAutomation["inheritedPolicy"]
  }): EngineAutomation => {
    const base = {
      id: over.id,
      title: over.title,
      rule: over.rule,
      prompt: over.prompt,
      nextRunAt: over.nextRunAt,
      status: over.status,
      createdAt: over.createdAt,
      fireCount: over.fireCount,
    } as const
    return {
      ...base,
      ...pickDefined({
        lastRunAt: over.lastRunAt,
        lastError: over.lastError,
        claimToken: over.claimToken,
        claimedAt: over.claimedAt,
        model: over.model,
        modelFallbacks: over.modelFallbacks,
        agentRole: over.agentRole,
        baseBranch: over.baseBranch,
        kind: over.kind,
        targetThreadId: over.targetThreadId,
      }),
      // `inheritedPolicy` is spread separately: it needs a defensive freeze AND
      // its exact non-`undefined` type is lost through the generic pick under
      // exactOptionalPropertyTypes.
      ...(over.inheritedPolicy !== undefined
        ? { inheritedPolicy: Object.freeze({ ...over.inheritedPolicy }) }
        : {}),
    }
  }
  return { buildRow }
}

/** The advance step every execution path funnels through. */
const autoAdvance = (ctx: ReturnType<typeof autoTables> & ReturnType<typeof autoRows>) => {
  const { rows, runsBacking, inboxBacking, idAlloc, nextSeq, buildRow } = ctx

  /** Append run + inbox rows + advance the automation. Shared by `markRun`
   *  and `finalize` so both paths are byte-equal. Caller guarantees `existing`
   *  is a live (non-cancelled) row. */
  const recordAndAdvance = (
    existing: EngineAutomation,
    input: {
      id: string
      firedAt: number
      outcome: "fired" | "errored"
      errorMessage?: string
      nextRunAt: number | null
      inboxTitle: string
      inboxSummary: string
    },
  ): EngineAutomation => {
    const seq = nextSeq()
    const runId = idAlloc("run", input.id, input.firedAt, seq)
    runsBacking.push(buildRun(input, runId))
    const inboxId = idAlloc("inbox", input.id, input.firedAt, seq)
    inboxBacking.push({
      id: inboxId,
      automationId: input.id,
      title: input.inboxTitle,
      summary: input.inboxSummary,
      createdAt: input.firedAt,
      read: false,
    })
    const status = advancedStatus(input.outcome, input.nextRunAt !== null)
    const advanced = buildRow({
      id: existing.id,
      title: existing.title,
      rule: existing.rule,
      prompt: existing.prompt,
      // When the row is being retired, freeze nextRunAt at firedAt so the
      // sort stays meaningful and queries are deterministic.
      nextRunAt: input.nextRunAt ?? input.firedAt,
      status,
      createdAt: existing.createdAt,
      fireCount: existing.fireCount + 1,
      lastRunAt: input.firedAt,
      // Retain the error message whenever this fire errored — even when the
      // row stays `scheduled` to retry (H5) so the host can observe it.
      ...(input.outcome === "errored" && input.errorMessage !== undefined
        ? { lastError: input.errorMessage }
        : {}),
      // B2 — carry the immutable routing/policy config across the fire so a
      // fired/retrying row keeps it.
      ...immutableConfig(existing),
      // claimToken/claimedAt cleared on finalize (omitted ⇒ absent).
    })
    rows.set(advanced.id, advanced)
    return advanced
  }
  return { recordAndAdvance }
}

/** The scheduling half of the engine surface. */
const autoSchedule = (
  ctx: ReturnType<typeof autoTables> & ReturnType<typeof autoRows> & ReturnType<typeof autoAdvance>,
) => {
  const { rows, buildRow } = ctx

  /** Scheduling surface: create a row, list them, cancel one. */
  const engineSchedule: Pick<AutomationEnginePort, "schedule" | "list" | "cancel"> = {
    schedule(input: ScheduleInput): Promise<EngineResult<EngineAutomation>> {
      if (input.id.length === 0) {
        return Promise.resolve(invalid("id is empty"))
      }
      if (rows.has(input.id)) {
        return Promise.resolve({
          ok: false,
          code: "duplicate-id",
          message: `automation '${input.id}' already scheduled`,
        })
      }
      const heartbeatError = validateHeartbeatSchedule(input, rows.values())
      if (heartbeatError !== undefined) return Promise.resolve(heartbeatError)
      const row = buildRow({
        id: input.id,
        title: input.title,
        rule: input.rule,
        prompt: input.prompt,
        nextRunAt: input.nextRunAt,
        status: "scheduled",
        createdAt: input.createdAt,
        fireCount: 0,
        ...immutableConfig(input),
      })
      rows.set(row.id, row)
      return Promise.resolve({ ok: true, value: row })
    },

    list(): Promise<EngineResult<ReadonlyArray<EngineAutomation>>> {
      const out: EngineAutomation[] = []
      for (const r of rows.values()) {
        if (r.status === "cancelled") continue
        out.push(r)
      }
      sortByDueThenId(out)
      return Promise.resolve({ ok: true, value: out })
    },

    cancel(id: string): Promise<EngineResult<void>> {
      const existing = rows.get(id)
      // idempotent: missing or already-cancelled both succeed.
      if (existing === undefined || existing.status === "cancelled") {
        return Promise.resolve({ ok: true, value: undefined })
      }
      rows.set(id, { ...existing, status: "cancelled" })
      return Promise.resolve({ ok: true, value: undefined })
    },
  }
  return { engineSchedule }
}

/** The execution half, and the assembled engine. */
const autoExecute = (
  ctx: ReturnType<typeof autoTables> &
    ReturnType<typeof autoRows> &
    ReturnType<typeof autoAdvance> &
    ReturnType<typeof autoSchedule>,
) => {
  const { rows, nextSeq, buildRow, recordAndAdvance, engineSchedule } = ctx

  /** Execution surface: take the next due row, record a run, claim it, and
   *  finalize the outcome. */
  const engineExecute: Pick<
    AutomationEnginePort,
    "next" | "markRun" | "claim" | "finalize" | "renewClaim"
  > = {
    next(now: number): Promise<EngineResult<EngineAutomation | null>> {
      let best: EngineAutomation | null = null
      for (const r of rows.values()) {
        if (r.status !== "scheduled") continue
        if (r.nextRunAt > now) continue
        best = earlierDue(best, r)
      }
      return Promise.resolve({ ok: true, value: best })
    },

    markRun(input: MarkRunInput): Promise<EngineResult<EngineAutomation>> {
      const existing = rows.get(input.id)
      if (existing === undefined || existing.status === "cancelled") {
        return Promise.resolve({
          ok: false,
          code: "not-found",
          message: `automation '${input.id}' not found / cancelled`,
        })
      }
      return Promise.resolve({ ok: true, value: recordAndAdvance(existing, input) })
    },

    claim(now: number, claimOpts?: ClaimOpts): Promise<EngineResult<ClaimedRun | null>> {
      // Atomic in-memory: the whole selection + flip runs synchronously with
      // no await, so two overlapping ticker callers cannot observe the same
      // `scheduled` row before it becomes `running`.
      let best: EngineAutomation | null = null
      for (const r of rows.values()) {
        if (!isClaimable(r, now, claimOpts)) continue
        best = earlierDue(best, r)
      }
      if (best === null) return Promise.resolve({ ok: true, value: null })
      const claimToken = mintClaimToken(best.id, now, nextSeq())
      const running = buildRow({
        id: best.id,
        title: best.title,
        rule: best.rule,
        prompt: best.prompt,
        nextRunAt: best.nextRunAt,
        status: "running",
        createdAt: best.createdAt,
        fireCount: best.fireCount,
        ...runHistory(best),
        ...immutableConfig(best),
        claimToken,
        claimedAt: now,
      })
      rows.set(running.id, running)
      return Promise.resolve({ ok: true, value: { automation: running, claimToken } })
    },

    finalize(input: FinalizeInput): Promise<EngineResult<EngineAutomation>> {
      const existing = rows.get(input.id)
      if (
        existing === undefined ||
        existing.status === "cancelled" ||
        existing.status !== "running" ||
        existing.claimToken !== input.claimToken
      ) {
        return Promise.resolve({
          ok: false,
          code: "not-found",
          message: `automation '${input.id}' not claimable / token mismatch`,
        })
      }
      return Promise.resolve({ ok: true, value: recordAndAdvance(existing, input) })
    },

    renewClaim(id: string, claimToken: string, now: number): Promise<EngineResult<void>> {
      const existing = rows.get(id)
      if (
        existing === undefined ||
        existing.status !== "running" ||
        existing.claimToken !== claimToken
      ) {
        return Promise.resolve({
          ok: false,
          code: "not-found",
          message: `automation '${id}' not claimable / token mismatch`,
        })
      }
      rows.set(
        id,
        buildRow({
          id: existing.id,
          title: existing.title,
          rule: existing.rule,
          prompt: existing.prompt,
          nextRunAt: existing.nextRunAt,
          status: "running",
          createdAt: existing.createdAt,
          fireCount: existing.fireCount,
          ...runHistory(existing),
          ...immutableConfig(existing),
          claimToken,
          claimedAt: now,
        }),
      )
      return Promise.resolve({ ok: true, value: undefined })
    },
  }

  const engine: AutomationEnginePort = { ...engineSchedule, ...engineExecute }

  return { engineExecute, engine }
}

/** Assemble the chained builders. */
export const inMemoryAutomationEngine = (
  opts: InMemoryAutomationEngineOpts = {},
): InMemoryAutomationEngine => {
  const p0 = autoTables(opts)
  const p1 = autoRows()
  const p2 = autoAdvance({ ...p0, ...p1 })
  const p3 = autoSchedule({ ...p0, ...p1, ...p2 })
  const p4 = autoExecute({ ...p0, ...p1, ...p2, ...p3 })
  const { runsBacking, inboxBacking, engine } = { ...p0, ...p1, ...p2, ...p3, ...p4 }
  return Object.freeze({
    schedule: engine.schedule,
    list: engine.list,
    cancel: engine.cancel,
    next: engine.next,
    markRun: engine.markRun,
    claim: engine.claim,
    finalize: engine.finalize,
    renewClaim: engine.renewClaim,
    get runs(): ReadonlyArray<AutomationRun> {
      return Object.freeze([...runsBacking])
    },
    get inbox(): ReadonlyArray<InboxItem> {
      return Object.freeze([...inboxBacking])
    },
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────────

/** exactOptional helper: return a shallow object carrying ONLY the keys whose
 *  value is not `undefined` (an absent optional stays OMITTED, never
 *  `undefined`-set). Pure; preserves value identity. Keeps the row builders flat
 *  as the optional-field surface grows. */
const pickDefined = <T extends Record<string, unknown>>(o: T): Partial<T> => {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

const sortByDueThenId = (rows: EngineAutomation[]): void => {
  rows.sort((a, b) => {
    if (a.nextRunAt !== b.nextRunAt) return a.nextRunAt - b.nextRunAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

const buildRun = (
  input: {
    id: string
    firedAt: number
    outcome: "fired" | "errored"
    errorMessage?: string
  },
  runId: string,
): AutomationRun => {
  const base = {
    id: runId,
    automationId: input.id,
    firedAt: input.firedAt,
    outcome: input.outcome,
  } as const
  return input.outcome === "errored" && input.errorMessage !== undefined
    ? { ...base, errorMessage: input.errorMessage }
    : { ...base }
}

const invalid = (message: string): EngineResult<never> => ({
  ok: false,
  code: "invalid-input",
  message,
})

const validateHeartbeatSchedule = (
  input: ScheduleInput,
  rows: Iterable<EngineAutomation>,
): EngineResult<never> | undefined => {
  if (input.kind !== "heartbeat") return undefined
  if (input.targetThreadId === undefined || input.targetThreadId.length === 0) {
    return invalid("heartbeat requires targetThreadId")
  }
  if (input.inheritedPolicy === undefined) return invalid("heartbeat requires inheritedPolicy")
  for (const row of rows) {
    if (
      row.kind === "heartbeat" &&
      row.targetThreadId === input.targetThreadId &&
      (row.status === "scheduled" || row.status === "running")
    ) {
      return {
        ok: false,
        code: "heartbeat-thread-occupied",
        message: `thread '${input.targetThreadId}' already has a live heartbeat`,
      }
    }
  }
  return undefined
}
