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
  EngineAutomation,
  EngineResult,
  InboxItem,
  MarkRunInput,
  ScheduleInput,
} from "./port"

/**
 * Build an in-memory engine. Each call returns an INDEPENDENT instance —
 * tests share no mutable state across cases.
 *
 * Optional `idAllocator` injects deterministic run/inbox ids; default is
 * `${automationId}-${firedAt}` which is collision-free in normal flow but
 * NOT guaranteed unique under same-ms double-fire (tests inject a counter).
 */
export interface InMemoryAutomationEngineOpts {
  /** Override run / inbox id generation. Pure, deterministic. */
  readonly idAllocator?: (kind: "run" | "inbox", automationId: string, firedAt: number) => string
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
  const idAlloc = opts.idAllocator ?? defaultIdAlloc

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
    }
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
      const row = buildRow({
        id: input.id,
        title: input.title,
        rule: input.rule,
        prompt: input.prompt,
        nextRunAt: input.nextRunAt,
        status: "scheduled",
        createdAt: input.createdAt,
        fireCount: 0,
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
      // Append the run-row first (atomic in-memory; SQLite adapter uses a tx).
      const runId = idAlloc("run", input.id, input.firedAt)
      const runRow = buildRun(input, runId)
      runsBacking.push(runRow)
      const inboxId = idAlloc("inbox", input.id, input.firedAt)
      inboxBacking.push({
        id: inboxId,
        automationId: input.id,
        title: input.inboxTitle,
        summary: input.inboxSummary,
        createdAt: input.firedAt,
        read: false,
      })
      // Mutate the row last so a failure earlier would leave the row untouched
      // (the in-memory path can't fail mid-way; the SQLite path uses a tx).
      const nextStatus: EngineAutomation["status"] =
        input.outcome === "errored" ? "errored" : input.nextRunAt === null ? "fired" : "scheduled"
      const advanced = buildRow({
        id: existing.id,
        title: existing.title,
        rule: existing.rule,
        prompt: existing.prompt,
        // When the row is being retired, freeze nextRunAt at firedAt so the
        // sort stays meaningful and queries are deterministic.
        nextRunAt: input.nextRunAt ?? input.firedAt,
        status: nextStatus,
        createdAt: existing.createdAt,
        fireCount: existing.fireCount + 1,
        lastRunAt: input.firedAt,
        ...(input.outcome === "errored" && input.errorMessage !== undefined
          ? { lastError: input.errorMessage }
          : {}),
      })
      rows.set(advanced.id, advanced)
      return Promise.resolve({ ok: true, value: advanced })
    },
  }

  return Object.freeze({
    schedule: engine.schedule,
    list: engine.list,
    cancel: engine.cancel,
    next: engine.next,
    markRun: engine.markRun,
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

const defaultIdAlloc = (kind: "run" | "inbox", automationId: string, firedAt: number): string =>
  `${kind}-${automationId}-${firedAt}`

const sortByDueThenId = (rows: EngineAutomation[]): void => {
  rows.sort((a, b) => {
    if (a.nextRunAt !== b.nextRunAt) return a.nextRunAt - b.nextRunAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

const buildRun = (input: MarkRunInput, runId: string): AutomationRun => {
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
