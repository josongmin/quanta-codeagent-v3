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

export const inMemoryAutomationEngine = (
  opts: InMemoryAutomationEngineOpts = {},
): InMemoryAutomationEngine => {
  const rows = new Map<string, EngineAutomation>()
  const runsBacking: AutomationRun[] = []
  const inboxBacking: InboxItem[] = []
  const idAlloc = opts.idAllocator ?? defaultRunIdAllocator
  const nextSeq = makeSeq()

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
      ...(over.lastRunAt !== undefined ? { lastRunAt: over.lastRunAt } : {}),
      ...(over.lastError !== undefined ? { lastError: over.lastError } : {}),
      ...(over.claimToken !== undefined ? { claimToken: over.claimToken } : {}),
      ...(over.claimedAt !== undefined ? { claimedAt: over.claimedAt } : {}),
      ...(over.model !== undefined ? { model: over.model } : {}),
      ...(over.modelFallbacks !== undefined ? { modelFallbacks: over.modelFallbacks } : {}),
      ...(over.kind !== undefined ? { kind: over.kind } : {}),
      ...(over.targetThreadId !== undefined ? { targetThreadId: over.targetThreadId } : {}),
      ...(over.inheritedPolicy !== undefined
        ? { inheritedPolicy: Object.freeze({ ...over.inheritedPolicy }) }
        : {}),
    }
  }

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
      // B2 — model/modelFallbacks are immutable per-automation fields; carry
      // them across the fire so a fired/retrying row keeps its routing config.
      ...(existing.model !== undefined ? { model: existing.model } : {}),
      ...(existing.modelFallbacks !== undefined ? { modelFallbacks: existing.modelFallbacks } : {}),
      ...(existing.kind !== undefined ? { kind: existing.kind } : {}),
      ...(existing.targetThreadId !== undefined ? { targetThreadId: existing.targetThreadId } : {}),
      ...(existing.inheritedPolicy !== undefined
        ? { inheritedPolicy: existing.inheritedPolicy }
        : {}),
      // claimToken/claimedAt cleared on finalize (omitted ⇒ absent).
    })
    rows.set(advanced.id, advanced)
    return advanced
  }

  const engine: AutomationEnginePort = {
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
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.modelFallbacks !== undefined ? { modelFallbacks: input.modelFallbacks } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.targetThreadId !== undefined ? { targetThreadId: input.targetThreadId } : {}),
        ...(input.inheritedPolicy !== undefined ? { inheritedPolicy: input.inheritedPolicy } : {}),
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

    next(now: number): Promise<EngineResult<EngineAutomation | null>> {
      let best: EngineAutomation | null = null
      for (const r of rows.values()) {
        if (r.status !== "scheduled") continue
        if (r.nextRunAt > now) continue
        if (best === null) {
          best = r
          continue
        }
        if (r.nextRunAt < best.nextRunAt) best = r
        else if (r.nextRunAt === best.nextRunAt && r.id < best.id) best = r
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
        const claimable =
          (r.status === "scheduled" && r.nextRunAt <= now) ||
          (r.status === "running" &&
            claimOpts?.reclaimBefore !== undefined &&
            r.claimedAt !== undefined &&
            r.claimedAt <= claimOpts.reclaimBefore)
        if (!claimable) continue
        if (best === null) best = r
        else if (r.nextRunAt < best.nextRunAt) best = r
        else if (r.nextRunAt === best.nextRunAt && r.id < best.id) best = r
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
        ...(best.lastRunAt !== undefined ? { lastRunAt: best.lastRunAt } : {}),
        ...(best.lastError !== undefined ? { lastError: best.lastError } : {}),
        ...(best.model !== undefined ? { model: best.model } : {}),
        ...(best.modelFallbacks !== undefined ? { modelFallbacks: best.modelFallbacks } : {}),
        ...(best.kind !== undefined ? { kind: best.kind } : {}),
        ...(best.targetThreadId !== undefined ? { targetThreadId: best.targetThreadId } : {}),
        ...(best.inheritedPolicy !== undefined ? { inheritedPolicy: best.inheritedPolicy } : {}),
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
  }

  return Object.freeze({
    schedule: engine.schedule,
    list: engine.list,
    cancel: engine.cancel,
    next: engine.next,
    markRun: engine.markRun,
    claim: engine.claim,
    finalize: engine.finalize,
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
