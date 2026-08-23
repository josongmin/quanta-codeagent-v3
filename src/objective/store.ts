/**
 * ADR-0394 — In-memory `ObjectivePort` implementation.
 *
 * Zero-dep reference store. The single mutator of the `Objective` model.
 * Determinism:
 *   - frozen snapshots returned to callers (no post-return mutation leaks).
 *   - injected `now` clock seam (default `Date.now`) for stable timestamps.
 *
 * NO-THROW contract: every method wraps its body in a try/catch and degrades
 * to `null` (mutators / get) or an empty result (`list`) on ANY internal
 * error or malformed input. No method ever throws.
 *
 * Status is NEVER stored as the source of truth on its own. We persist the
 * caller's last EXPLICIT `updateStatus` value separately and DERIVE the
 * public `status` on every read/write from the derivation rule (see
 * `./types` doc + ADR-0394). This keeps the blocked/completed invariants
 * impossible to violate via field drift.
 *
 * exactOptional: budget `max*` keys are OMITTED when absent.
 */

import { randomUUID } from "node:crypto"
import { errMessage, logger } from "@/shared"
import type {
  CheckSpec,
  CompletionReceipt,
  CriterionDeclaration,
  CriterionKind,
  ManualCompletionReceipt,
  VerifierCompletionReceipt,
} from "./criteria/model"
import { isManualReceipt, isVerifierReceipt, normalizeCheckDeclaration } from "./criteria/model"
import type { ExplicitStatus, ObjectiveThreadSnapshot } from "./model"
import type {
  Blocker,
  Objective,
  ObjectiveBudget,
  ObjectivePort,
  ObjectiveSnapshot,
  ObjectiveStatus,
  SuccessCriterion,
  WaitingOn,
} from "./types"

/**
 * RFC-03 C1 — the store's per-thread snapshot/restore surface, consumed by the
 * mutation authority (`./authority`) for EXACT undo. Extends `ObjectivePort`
 * with two per-thread methods the whole-store `to/fromSnapshot` codec cannot
 * express (they operate on ALL threads). `snapshotThread` captures the full
 * serializable state of one thread; `restoreThread` writes it back verbatim.
 */
export interface ObjectiveCore extends ObjectivePort {
  /** Full serializable state of one thread's objective, or `null` if unset. */
  snapshotThread(threadId: string): ObjectiveThreadSnapshot | null
  /** Restore one thread's objective from a snapshot; `true` iff it applied. When
   *  `state` was captured as absent the thread is DELETED (exact undo of a set). */
  restoreThread(threadId: string, state: ObjectiveThreadSnapshot | null): boolean
  /** RFC-03 C4 — read a criterion's kind + check identity for the authority's
   *  policy decisions (verifier-only enforcement). `null` ⇒ no such criterion. */
  getCriterion(
    threadId: string,
    criterionId: string,
  ): { readonly kind: CriterionKind; readonly met: boolean; readonly checkId: string | null } | null
  /** RFC-03 C4 — complete/uncomplete a MANUAL criterion with an authority-minted
   *  receipt (`null` ⇒ set met with no receipt / clear on unmark). Refuses (⇒
   *  `null`) a CHECKED criterion (verifier-only) or a missing one. */
  applyManualCompletion(
    threadId: string,
    criterionId: string,
    met: boolean,
    receipt: ManualCompletionReceipt | null,
  ): Objective | null
  /** RFC-03 C4 — the VERIFIER-ONLY checked completion. Sets met:true + the
   *  verifier receipt ONLY when the criterion is CHECKED and the receipt's
   *  `checkId` matches the declared `check.id`; refuses (⇒ `null`) otherwise. */
  applyVerifierCompletion(
    threadId: string,
    criterionId: string,
    receipt: VerifierCompletionReceipt,
  ): Objective | null
}

/** RFC-03 C4 — internal MUTABLE criterion cell. `kind` discriminates manual vs
 *  checked; `check` is present (frozen, immutable) only for checked criteria;
 *  `completion` is the evidence receipt present only while met with provenance.
 *  Projected to the public frozen {@link SuccessCriterion} union by
 *  {@link toCriterion}. Optional fields are OMITTED when absent (never
 *  `: undefined`) so the projection is byte-stable. */
interface CritCell {
  id: string
  text: string
  met: boolean
  kind: CriterionKind
  check?: CheckSpec
  completion?: CompletionReceipt
}

/** Internal mutable cell. `explicitStatus` is the caller's last non-derived
 *  intent ("active" | "completed"); the public status is always DERIVED. */
interface Cell {
  threadId: string
  goal: string
  criteria: CritCell[]
  blockers: Blocker[]
  nextActions: string[]
  explicitStatus: "active" | "paused" | "completed"
  /** H17 — epoch-ms until which a transient external usage/rate limit applies.
   *  `undefined` ⇒ no window. Derives `usage_limited` while `now < this` AND the
   *  store enforces; auto-clears (re-derives) once the clock passes it. */
  usageLimitedUntil?: number
  maxTokens?: number
  tokensUsed: number
  maxTurns?: number
  turnsUsed: number
  createdAt: number
  updatedAt: number
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

const finiteNonNegInt = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined
  return Math.floor(v)
}

/** H17 — exact (NOT heuristic) budget-exhaustion predicate. The objective has
 *  exceeded its envelope when a CONFIGURED cap is met by accumulated usage:
 *  `tokensUsed >= maxTokens` OR `turnsUsed >= maxTurns`. Comparison is `>=`
 *  (reaching the cap is exhaustion). A cap that is `undefined` never triggers;
 *  no caps at all ⇒ never exhausted. Pure function of the cell. */
const budgetExhausted = (cell: Cell): boolean =>
  (cell.maxTokens !== undefined && cell.tokensUsed >= cell.maxTokens) ||
  (cell.maxTurns !== undefined && cell.turnsUsed >= cell.maxTurns)

/** H17 — is a transient usage/rate window currently active? True only when a
 *  finite `usageLimitedUntil` is set AND the injected clock has NOT yet passed
 *  it (`now < until`). Equality (`now === until`) is the RESET instant: the
 *  window has elapsed and the status re-derives back to the explicit value — no
 *  sticky flag. Pure function of the cell + the clock reading. */
const usageWindowActive = (cell: Cell, now: number): boolean =>
  cell.usageLimitedUntil !== undefined && now < cell.usageLimitedUntil

/** Derive the public status from the immutable SIX-state rule (Codex
 *  `core/src/goals.rs`). Priority-ordered, TOTAL over the cell + injected clock:
 *
 *    1. blockers.length > 0                  ⇒ blocked        (highest)
 *    2. enforce ∧ usage window active        ⇒ usage_limited  (auto-resets)
 *    3. enforce ∧ budget exhausted (>= cap)  ⇒ budget_limited (hard stop)
 *    4. all criteria met (>=1)               ⇒ completed
 *    5. else                                 ⇒ explicit (active | paused)
 *
 *  `enforce` is the store-level H17 gate (default false). When false this is
 *  byte-identical to the ADR-0394 derivation (neither `usage_limited` nor
 *  `budget_limited` is ever produced — budget stays informational and any usage
 *  window is inert). `now` is the injected clock reading so the usage window
 *  resets deterministically. */
const deriveStatus = (cell: Cell, enforce: boolean, now: number): ObjectiveStatus => {
  if (cell.blockers.length > 0) return "blocked"
  if (enforce && usageWindowActive(cell, now)) return "usage_limited"
  if (enforce && budgetExhausted(cell)) return "budget_limited"
  if (cell.criteria.length > 0 && cell.criteria.every((c) => c.met)) return "completed"
  return cell.explicitStatus
}

/** RFC-03 C4 — project an internal {@link CritCell} to the frozen public
 *  {@link SuccessCriterion} union. `kind` is ALWAYS present (discriminant);
 *  `check`/`completion` are OMITTED when absent so the projection is byte-stable
 *  for a plain manual criterion (`{ kind, id, text, met }`). */
const toCriterion = (c: CritCell): SuccessCriterion => {
  if (c.kind === "checked" && c.check !== undefined) {
    return Object.freeze({
      kind: "checked" as const,
      id: c.id,
      text: c.text,
      met: c.met,
      check: c.check,
      ...(c.completion !== undefined && c.completion.source === "verifier"
        ? { completion: c.completion }
        : {}),
    })
  }
  return Object.freeze({
    kind: "manual" as const,
    id: c.id,
    text: c.text,
    met: c.met,
    ...(c.completion !== undefined && c.completion.source === "manual"
      ? { completion: c.completion }
      : {}),
  })
}

const buildBudget = (cell: Cell): ObjectiveBudget => {
  const base = { tokensUsed: cell.tokensUsed, turnsUsed: cell.turnsUsed }
  return Object.freeze({
    ...base,
    ...(cell.maxTokens !== undefined ? { maxTokens: cell.maxTokens } : {}),
    ...(cell.maxTurns !== undefined ? { maxTurns: cell.maxTurns } : {}),
  })
}

/** Project a cell to the frozen public `Objective`. Derives status here (with
 *  the injected clock reading `now`, for the usage-window reset) so no read can
 *  ever observe a status that contradicts blockers/criteria/budget/usage. */
const toObjective = (cell: Cell, enforce: boolean, now: number): Objective =>
  Object.freeze({
    threadId: cell.threadId,
    goal: cell.goal,
    successCriteria: Object.freeze(cell.criteria.map(toCriterion)),
    status: deriveStatus(cell, enforce, now),
    budget: buildBudget(cell),
    blockers: Object.freeze(cell.blockers.map((b) => Object.freeze({ ...b }))),
    nextActions: Object.freeze([...cell.nextActions]),
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  })

/**
 * SERDE fix — persist INTENT, not derivation.
 *
 * The public `Objective.status` is a DERIVED value (blockers/criteria win over
 * the caller's explicit intent). A snapshot that stored only that derived
 * `status` and restored `explicitStatus` from it would conflate auto-derived
 * completion ("all criteria met") with an explicit `updateStatus("completed")`.
 * After such a round-trip, unmarking a criterion would NOT revert to "active"
 * because the restored explicit intent had been silently upgraded to
 * "completed" — breaking the re-derivation invariant pinned by
 * objective-hellgate.test.ts:185.
 *
 * The cure is to serialize the underlying `explicitStatus` alongside the
 * derived view. `Objective` is a structural interface, so a snapshot entry that
 * carries one extra `explicitStatus` field is still assignable to it; the field
 * is read back verbatim on restore (never inferred from `status`). This keeps
 * the persist LOSSLESS — intent survives the round-trip — and keeps status
 * derivation a pure function of `explicitStatus + criteria + blockers`. */
interface SnapshotObjective extends Objective {
  /** The caller's last EXPLICIT intent — the ONLY status source on restore. */
  readonly explicitStatus: "active" | "paused" | "completed"
  /** H17 — the transient usage window expiry (epoch ms), persisted so a
   *  usage_limited goal stays limited across a snapshot round-trip until its
   *  window naturally elapses. Omitted when no window is set. */
  readonly usageLimitedUntil?: number
}

const toSnapshotObjective = (cell: Cell, enforce: boolean, now: number): SnapshotObjective =>
  Object.freeze({
    threadId: cell.threadId,
    goal: cell.goal,
    successCriteria: Object.freeze(cell.criteria.map(toCriterion)),
    status: deriveStatus(cell, enforce, now),
    explicitStatus: cell.explicitStatus,
    ...(cell.usageLimitedUntil !== undefined ? { usageLimitedUntil: cell.usageLimitedUntil } : {}),
    budget: buildBudget(cell),
    blockers: Object.freeze(cell.blockers.map((b) => Object.freeze({ ...b }))),
    nextActions: Object.freeze([...cell.nextActions]),
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  })

/** Audit R2 (F3) defensive caps. The agent populates its own threads, so the
 *  exploit surface is "agent misbehaves and floods its own state" — but a
 *  bounded cap is cheap and mirrors the mailbox/run-ledger/approval-LRU
 *  retention discipline. Tuned far above any realistic objective: 256 success
 *  criteria + 64 simultaneous blockers per thread are already absurd; the cap
 *  exists purely to bound pathological growth. */
const MAX_CRITERIA_PER_OBJECTIVE = 256
const MAX_BLOCKERS_PER_OBJECTIVE = 64

/** RFC-03 C4 — mint a fresh MANUAL criterion cell (not met, no completion). */
const manualCrit = (text: string): CritCell => ({
  id: randomUUID(),
  text,
  met: false,
  kind: "manual",
})

/** RFC-03 C4 — mint a fresh CHECKED criterion cell from a (validated) check
 *  declaration. The `check` is domain-stamped with a fresh immutable `id` +
 *  fixed `cwdPolicy:"thread"` and FROZEN so it can never mutate after creation. */
const checkedCrit = (text: string, decl: CheckSpecDeclarationLike): CritCell => ({
  id: randomUUID(),
  text,
  met: false,
  kind: "checked",
  check: Object.freeze({
    id: randomUUID(),
    kind: "command",
    argv: Object.freeze([...decl.argv]),
    cwdPolicy: "thread",
    timeoutMs: decl.timeoutMs,
    successExitCodes: Object.freeze([...decl.successExitCodes]),
  }),
})

type CheckSpecDeclarationLike = {
  argv: readonly string[]
  timeoutMs: number
  successExitCodes: readonly number[]
}

/** Append manual cells for each string in the legacy list, honoring the live cap
 *  (`push` returns false when full ⇒ stop). Non-string entries are skipped. */
const collectStringCriteria = (
  raw: readonly string[] | undefined,
  push: (c: CritCell) => boolean,
): void => {
  if (!Array.isArray(raw)) return
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    if (!push(manualCrit(entry))) break
  }
}

/** Append cells for each RFC-03 C4 rich declaration: a runnable `check` ⇒ checked,
 *  else manual. Honors the live cap via `push` (false ⇒ stop); malformed entries
 *  are skipped. */
const collectDeclarationCriteria = (
  declarations: readonly CriterionDeclaration[] | undefined,
  push: (c: CritCell) => boolean,
): void => {
  if (!Array.isArray(declarations)) return
  for (const decl of declarations) {
    if (decl === null || typeof decl !== "object") continue
    const text = typeof decl.text === "string" ? decl.text : ""
    const check = normalizeCheckDeclaration(decl.check)
    if (!push(check !== null ? checkedCrit(text, check) : manualCrit(text))) break
  }
}

/** Build criterion cells from the legacy string list PLUS the RFC-03 C4 rich
 *  declarations. Strings ⇒ manual; a declaration with a runnable `check` ⇒
 *  checked; a declaration with no/invalid check ⇒ manual. Applies the live cap
 *  via the shared `push` (both collectors share the ONE cap budget). */
const sanitizeCriteria = (
  raw: readonly string[] | undefined,
  declarations: readonly CriterionDeclaration[] | undefined,
): CritCell[] => {
  const out: CritCell[] = []
  const push = (c: CritCell): boolean => {
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) return false
    out.push(c)
    return true
  }
  collectStringCriteria(raw, push)
  collectDeclarationCriteria(declarations, push)
  return out
}

/** A blank cell stamped at `t` — used when `set` receives malformed input but
 *  must still return a non-null `Objective` (the port contract). */
const emptyCell = (threadId: string, t: number): Cell => ({
  threadId: isNonEmptyString(threadId) ? threadId : "",
  goal: "",
  criteria: [],
  blockers: [],
  nextActions: [],
  explicitStatus: "active",
  tokensUsed: 0,
  turnsUsed: 0,
  createdAt: t,
  updatedAt: t,
})

/** Build a fresh cell from a well-formed `set` init payload. */
const cellFromInit = (
  threadId: string,
  init: {
    goal: string
    successCriteria?: readonly string[]
    criteria?: readonly CriterionDeclaration[]
    budget?: { maxTokens?: number; maxTurns?: number }
  },
  t: number,
): Cell => {
  const maxTokens = finiteNonNegInt(init.budget?.maxTokens)
  const maxTurns = finiteNonNegInt(init.budget?.maxTurns)
  return {
    threadId,
    goal: typeof init.goal === "string" ? init.goal : "",
    criteria: sanitizeCriteria(init.successCriteria, init.criteria),
    blockers: [],
    nextActions: [],
    explicitStatus: "active",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: 0,
    createdAt: t,
    updatedAt: t,
  }
}

/** RFC-03 C1 — the raw in-memory objective CORE. Renamed from the historical
 *  `createObjectiveStore`; the public `createObjectiveStore` now lives in
 *  `./authority` and wraps this core so every mutation is revisioned + CAS-gated
 *  (there is no un-revisioned store constructor in production). */
export const createObjectiveCoreStore = (opts?: {
  now?: () => number
  /** H17 — when true the public `status` derives `"budget_limited"` once a
   *  configured cap is reached (see `deriveStatus`/`budgetExhausted`). Default
   *  false ⇒ budget is purely informational and the status is byte-identical
   *  to ADR-0394 (this flag is the SSOT for whether the store enforces; the
   *  host wires it from `QUANTA_OBJECTIVE_BUDGET_ENFORCE`). */
  enforceBudget?: boolean
}): ObjectiveCore => {
  const now = opts?.now ?? Date.now
  const enforce = opts?.enforceBudget === true
  const cells = new Map<string, Cell>()

  const clockNow = (): number => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** Resolve a cell by threadId, run `fn`, stamp updatedAt, return projection.
   *  Unknown thread ⇒ null. Any throw ⇒ null. */
  const mutate = (threadId: string, fn: (cell: Cell) => void): Objective | null => {
    try {
      if (!isNonEmptyString(threadId)) return null
      const cell = cells.get(threadId)
      if (cell === undefined) return null
      fn(cell)
      const t = clockNow()
      cell.updatedAt = t
      return toObjective(cell, enforce, t)
    } catch {
      return null
    }
  }

  return {
    set(threadId, init): Objective {
      try {
        // Malformed input still returns a non-null Objective (port contract):
        // degrade to a synthetic empty cell rather than throwing.
        if (!isNonEmptyString(threadId) || init === null || typeof init !== "object") {
          const t = clockNow()
          return toObjective(emptyCell(threadId, t), enforce, t)
        }
        const t = clockNow()
        const cell = cellFromInit(threadId, init, t)
        cells.set(threadId, cell)
        return toObjective(cell, enforce, t)
      } catch {
        const t = Date.now()
        return toObjective(emptyCell(threadId, t), enforce, t)
      }
    },

    get(threadId): Objective | null {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        return cell === undefined ? null : toObjective(cell, enforce, clockNow())
      } catch {
        return null
      }
    },

    updateStatus(threadId, status): Objective | null {
      return mutate(threadId, (cell) => {
        // Only "active" / "paused" / "completed" are explicit intents. The other
        // three values (`blocked` / `usage_limited` / `budget_limited`) are
        // DERIVED (from blockers / usage window / budget) and cannot be set
        // directly — passing one is a silent no-op (the port is NO-THROW).
        if (status === "active" || status === "paused" || status === "completed") {
          cell.explicitStatus = status
        }
      })
    },

    markUsageLimited(threadId, untilEpochMs): Objective | null {
      return mutate(threadId, (cell) => {
        // A finite, future-or-equal epoch sets the window; anything else (NaN /
        // Infinity / negative / non-number) CLEARS it. The derive uses the
        // injected clock so the window auto-resets — no sticky flag here.
        // exactOptionalPropertyTypes: set or DELETE (never assign `undefined`).
        if (typeof untilEpochMs === "number" && Number.isFinite(untilEpochMs) && untilEpochMs > 0) {
          cell.usageLimitedUntil = untilEpochMs
        } else {
          delete cell.usageLimitedUntil
        }
      })
    },

    addBlocker(threadId, blocker): Objective | null {
      return mutate(threadId, (cell) => {
        // Audit R2 (F3): bounded blocker count per objective. Silently dropping
        // is correct here — an agent that has hit 64 simultaneous unresolved
        // blockers on one thread is already in a pathological state; adding a
        // 65th would not help diagnosis.
        if (cell.blockers.length >= MAX_BLOCKERS_PER_OBJECTIVE) return
        const waitingOn: WaitingOn =
          blocker?.waitingOn === "user" ||
          blocker?.waitingOn === "tool" ||
          blocker?.waitingOn === "network" ||
          blocker?.waitingOn === "child_agent"
            ? blocker.waitingOn
            : "user"
        cell.blockers.push({
          id: randomUUID(),
          reason: typeof blocker?.reason === "string" ? blocker.reason : "",
          waitingOn,
          since: clockNow(),
        })
      })
    },

    clearBlocker(threadId, blockerId): Objective | null {
      return mutate(threadId, (cell) => {
        cell.blockers = cell.blockers.filter((b) => b.id !== blockerId)
      })
    },

    setNextActions(threadId, actions): Objective | null {
      return mutate(threadId, (cell) => {
        cell.nextActions = Array.isArray(actions)
          ? actions.filter((a): a is string => typeof a === "string")
          : []
      })
    },

    markCriterion(threadId, criterionId, met): Objective | null {
      // RFC-03 C4 — the RAW (no-provenance) path. Kind-aware: a CHECKED criterion
      // is verifier-only, so a plain markCriterion NEVER changes its met flag
      // (structural, independent of any gate). A MANUAL criterion flips met and
      // (this dumb path carries no receipt) CLEARS any completion evidence.
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((c) => {
          if (c.id !== criterionId) return c
          if (c.kind === "checked") return c // verifier-only — no-op
          const next: CritCell = { ...c, met: met === true }
          delete next.completion
          return next
        })
      })
    },

    getCriterion(threadId, criterionId) {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        if (cell === undefined) return null
        const c = cell.criteria.find((x) => x.id === criterionId)
        if (c === undefined) return null
        return {
          kind: c.kind,
          met: c.met,
          checkId: c.kind === "checked" && c.check !== undefined ? c.check.id : null,
        }
      } catch (e) {
        // NO-THROW contract preserved (still `null`) — but a read fault that
        // reads as "no such criterion" would make a checked criterion look
        // absent instead of unreadable.
        logger.warn(`objective.getCriterion: ${errMessage(e)}`)
        return null
      }
    },

    applyManualCompletion(threadId, criterionId, met, receipt): Objective | null {
      // Set met on a MANUAL criterion with an authority-minted receipt. Refuses a
      // CHECKED criterion (verifier-only) or a missing one ⇒ null (no bump).
      const c = cells.get(threadId)?.criteria.find((x) => x.id === criterionId)
      if (c === undefined || c.kind === "checked") return null
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((x) => {
          if (x.id !== criterionId || x.kind === "checked") return x
          const next: CritCell = { ...x, met: met === true }
          if (met === true && receipt !== null) next.completion = receipt
          else delete next.completion
          return next
        })
      })
    },

    applyVerifierCompletion(threadId, criterionId, receipt): Objective | null {
      // The VERIFIER-ONLY path. Completes a CHECKED criterion ⇔ its declared
      // `check.id` matches the receipt's `checkId` and the result passed. Refuses
      // (⇒ null) a manual/missing criterion or an id/verdict mismatch.
      const c = cells.get(threadId)?.criteria.find((x) => x.id === criterionId)
      if (c === undefined || c.kind !== "checked" || c.check === undefined) return null
      if (receipt.checkId !== c.check.id) return null
      if (receipt.verifierResult.passed !== true) return null
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((x) =>
          x.id === criterionId ? { ...x, met: true, completion: receipt } : x,
        )
      })
    },

    recordUsage(threadId, used): Objective | null {
      return mutate(threadId, (cell) => {
        const dTokens = finiteNonNegInt(used?.tokens)
        const dTurns = finiteNonNegInt(used?.turns)
        if (dTokens !== undefined) cell.tokensUsed += dTokens
        if (dTurns !== undefined) cell.turnsUsed += dTurns
      })
    },

    list(): readonly Objective[] {
      try {
        const t = clockNow()
        return Object.freeze([...cells.values()].map((c) => toObjective(c, enforce, t)))
      } catch {
        return Object.freeze([])
      }
    },

    toSnapshot(): ObjectiveSnapshot {
      try {
        const t = clockNow()
        return Object.freeze({
          objectives: Object.freeze(
            [...cells.values()].map((c) => toSnapshotObjective(c, enforce, t)),
          ),
        })
      } catch {
        return Object.freeze({ objectives: Object.freeze([]) })
      }
    },

    fromSnapshot(snap): void {
      try {
        cells.clear()
        const objectives = (snap as ObjectiveSnapshot | undefined)?.objectives
        if (!Array.isArray(objectives)) return
        for (const o of objectives) {
          const cell = cellFromObjective(o)
          if (cell !== null) cells.set(cell.threadId, cell)
        }
      } catch {
        // leave whatever survived; never throw
      }
    },

    // RFC-03 C1 — per-thread exact snapshot/restore for the authority's undo.
    snapshotThread(threadId): ObjectiveThreadSnapshot | null {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        if (cell === undefined) return null
        return Object.freeze({
          objective: toObjective(cell, enforce, clockNow()),
          explicitStatus: cell.explicitStatus,
          ...(cell.usageLimitedUntil !== undefined
            ? { usageLimitedUntil: cell.usageLimitedUntil }
            : {}),
        })
      } catch (e) {
        // RFC-03 C1 — NO-THROW contract preserved (still `null`), but the fault is
        // now attributed: a snapshot that silently returns null is indistinguishable
        // from "no objective on this thread", which would make the authority's undo
        // look like a no-op instead of a failure.
        logger.warn(`objective.snapshotThread: ${errMessage(e)}`)
        return null
      }
    },

    restoreThread(threadId, state): boolean {
      try {
        if (!isNonEmptyString(threadId)) return false
        // A null prior state means the objective did not exist at snapshot time:
        // exact undo of a `set` is DELETION of the thread's objective.
        if (state === null) return cells.delete(threadId)
        const cell = cellFromThreadSnapshot(threadId, state)
        if (cell === null) return false
        cells.set(threadId, cell)
        return true
      } catch (e) {
        // Same contract, same `false` — but an undo that fails to restore is a
        // DATA-LOSS class event for the caller's rollback, so it must not be silent.
        logger.warn(`objective.restoreThread: ${errMessage(e)}`)
        return false
      }
    },
  }
}

/** Reconstruct a mutable cell from a captured per-thread snapshot. Exact:
 *  criterion ids/met, blocker ids/since, next actions, explicit intent, usage
 *  window, budget and timestamps all round-trip verbatim (used by the
 *  authority's `restore`, so an undo never re-mints ids or drops `met`). */
const cellFromThreadSnapshot = (threadId: string, state: ObjectiveThreadSnapshot): Cell | null => {
  const o = state.objective
  if (o === null || typeof o !== "object") return null
  const explicit: ExplicitStatus =
    state.explicitStatus === "completed"
      ? "completed"
      : state.explicitStatus === "paused"
        ? "paused"
        : "active"
  const maxTokens = finiteNonNegInt(o.budget?.maxTokens)
  const maxTurns = finiteNonNegInt(o.budget?.maxTurns)
  return {
    threadId,
    goal: typeof o.goal === "string" ? o.goal : "",
    // RFC-03 C4 — rebuild criteria kind/check/completion verbatim (ids + check
    // ids preserved) so an EXACT undo/restore never drops provenance.
    criteria: rebuildCriteria(o.successCriteria),
    blockers: (Array.isArray(o.blockers) ? o.blockers : []).map((b) => ({
      id: isNonEmptyString(b.id) ? b.id : randomUUID(),
      reason: typeof b.reason === "string" ? b.reason : "",
      waitingOn: b.waitingOn,
      since: finiteOrZero(b.since),
    })),
    nextActions: Array.isArray(o.nextActions)
      ? o.nextActions.filter((a): a is string => typeof a === "string")
      : [],
    explicitStatus: explicit,
    ...(state.usageLimitedUntil !== undefined &&
    Number.isFinite(state.usageLimitedUntil) &&
    state.usageLimitedUntil > 0
      ? { usageLimitedUntil: state.usageLimitedUntil }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: finiteNonNegInt(o.budget?.tokensUsed) ?? 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: finiteNonNegInt(o.budget?.turnsUsed) ?? 0,
    createdAt: finiteOrZero(o.createdAt),
    updatedAt: finiteOrZero(o.updatedAt),
  }
}

const finiteOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Re-apply the live `sanitizeCriteria` caps when rebuilding from a snapshot.
 *  R4 audit-M closure: without this, a hostile/corrupted snapshot could ship
 *  a 1M-entry `successCriteria` array and inflate the in-memory cell past the
 *  256-criterion live cap that `set()` enforces. Slice equally with the live
 *  path so byte-identical snapshot round-trip from a healthy run stays exact
 *  (every healthy snapshot is already ≤ MAX_CRITERIA_PER_OBJECTIVE).
 *
 *  R5 audit-H4 closure: emit a `logger.warn` when the cap is hit so the
 *  truncation is observable (silent truncation was invisible to operators
 *  inspecting why a snapshot lost data). Single line per rebuild — the
 *  label-keyed leaky bucket in `logger.ts` bounds the rate even under a
 *  pathological replay flood. */
/** RFC-03 C4 — rebuild the IMMUTABLE {@link CheckSpec} from a persisted/snapshot
 *  record, PRESERVING its `id` verbatim (a verifier receipt references it, so it
 *  must never be re-minted). Returns `null` when the record is not a runnable
 *  command check (⇒ the criterion downgrades to manual). Stored frozen. */
const rebuildCheck = (raw: unknown): CheckSpec | null => {
  if (raw === null || typeof raw !== "object") return null
  const r = raw as { id?: unknown }
  if (!isNonEmptyString(r.id)) return null
  const decl = normalizeCheckDeclaration(raw)
  if (decl === null) return null
  return Object.freeze({
    id: r.id,
    kind: "command" as const,
    argv: Object.freeze([...decl.argv]),
    cwdPolicy: "thread" as const,
    timeoutMs: decl.timeoutMs,
    successExitCodes: Object.freeze([...decl.successExitCodes]),
  })
}

/** RFC-03 C4 — rebuild a completion receipt from a persisted/snapshot record,
 *  matching the arm: a MANUAL criterion accepts only a manual receipt, a CHECKED
 *  criterion only a verifier receipt. A malformed/mismatched receipt is DROPPED
 *  (⇒ undefined) rather than fabricated. Stored frozen. */
const rebuildCompletion = (raw: unknown, kind: CriterionKind): CompletionReceipt | undefined => {
  if (kind === "checked") return isVerifierReceipt(raw) ? Object.freeze({ ...raw }) : undefined
  return isManualReceipt(raw) ? Object.freeze({ ...raw }) : undefined
}

/** RFC-03 C4 — rebuild ONE criterion cell from a persisted/snapshot record. A
 *  record with `kind:"checked"` and a valid check ⇒ checked (id preserved); any
 *  other record (legacy `{id,text,met}`, `kind:"manual"`, or a checked record
 *  whose check is unrecoverable) ⇒ manual. Completion evidence rides along when
 *  it matches the arm. */
const rebuildCritCell = (raw: unknown): CritCell | null => {
  if (raw === null || typeof raw !== "object") return null
  const r = raw as {
    id?: unknown
    text?: unknown
    met?: unknown
    kind?: unknown
    check?: unknown
    completion?: unknown
  }
  const id = isNonEmptyString(r.id) ? r.id : randomUUID()
  const text = typeof r.text === "string" ? r.text : ""
  const met = r.met === true
  const check = r.kind === "checked" ? rebuildCheck(r.check) : null
  if (check !== null) {
    // RFC-03 C4 + M8 — a CHECKED criterion is met ONLY with a valid verifier
    // receipt that BINDS this check (checkId === check.id) AND passed — the exact
    // invariant `applyVerifierCompletion` enforces on the live path. A forged
    // `met:true` with an absent/mismatched/failed receipt (hand-edited snapshot)
    // is downgraded to the un-completed checked state (met:false, no completion).
    const comp = rebuildCompletion(r.completion, "checked")
    const bound =
      comp !== undefined &&
      comp.source === "verifier" &&
      comp.checkId === check.id &&
      comp.verifierResult.passed === true
    const metChecked = met && bound
    const cell: CritCell = { id, text, met: metChecked, kind: "checked", check }
    if (metChecked && comp !== undefined) cell.completion = comp
    return cell
  }
  const cell: CritCell = { id, text, met, kind: "manual" }
  const comp = rebuildCompletion(r.completion, "manual")
  if (comp !== undefined) cell.completion = comp
  return cell
}

const rebuildCriteria = (raw: unknown): CritCell[] => {
  if (!Array.isArray(raw)) return []
  const out: CritCell[] = []
  for (const c of raw) {
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) break
    const cell = rebuildCritCell(c)
    if (cell !== null) out.push(cell)
  }
  if (raw.length > MAX_CRITERIA_PER_OBJECTIVE) {
    logger.warn(
      `objective.rebuild.truncate: criteria=${raw.length} capped to ${MAX_CRITERIA_PER_OBJECTIVE}`,
    )
  }
  return out
}

/** Mirror of `rebuildCriteria` for the 64-blocker live cap. Hostile snapshot
 *  could otherwise ship N blockers and stick the objective in `blocked` state
 *  forever (status derivation requires blockers.length === 0 to leave).
 *
 *  R5 audit-H4 closure: same observability discipline as `rebuildCriteria`. */
const rebuildBlockers = (raw: unknown): Blocker[] => {
  if (!Array.isArray(raw)) return []
  const out: Blocker[] = []
  for (const b of raw) {
    if (b === null || typeof b !== "object") continue
    if (out.length >= MAX_BLOCKERS_PER_OBJECTIVE) break
    out.push({
      id: isNonEmptyString(b.id) ? b.id : randomUUID(),
      reason: typeof b.reason === "string" ? b.reason : "",
      waitingOn: b.waitingOn,
      since: finiteOrZero(b.since),
    })
  }
  if (raw.length > MAX_BLOCKERS_PER_OBJECTIVE) {
    logger.warn(
      `objective.rebuild.truncate: blockers=${raw.length} capped to ${MAX_BLOCKERS_PER_OBJECTIVE}`,
    )
  }
  return out
}

/**
 * Recover the persisted EXPLICIT intent from a snapshot entry.
 *
 * SERDE fix: read ONLY the dedicated `explicitStatus` field — NEVER the derived
 * `status`. If the explicit field is absent (legacy snapshot written before the
 * field existed, or a hostile payload), we cannot know whether a `completed`
 * status was explicit intent or auto-derived from met criteria; the safe,
 * non-fabricating answer is `active`. Defaulting to `active` is correct rather
 * than a silent fallback: the public `status` is RE-DERIVED from criteria after
 * restore, so a genuinely-complete objective (all criteria met) still reports
 * `completed`, and only the explicit-vs-derived distinction is reset — exactly
 * the field whose legacy value is unknowable. This never UPGRADES a derived
 * completion to explicit intent (the bug), it only ever stays/declines. */
const explicitFromSnapshot = (rec: {
  explicitStatus?: unknown
}): "active" | "paused" | "completed" => {
  if (rec.explicitStatus === "completed") return "completed"
  if (rec.explicitStatus === "paused") return "paused"
  return "active"
}

/** Reconstruct a mutable cell from a (possibly hostile) snapshot entry. */
function cellFromObjective(o: unknown): Cell | null {
  if (o === null || typeof o !== "object") return null
  const rec = o as Partial<SnapshotObjective>
  if (!isNonEmptyString(rec.threadId)) return null
  const budget = (rec.budget ?? {}) as Partial<ObjectiveBudget>
  const maxTokens = finiteNonNegInt(budget.maxTokens)
  const maxTurns = finiteNonNegInt(budget.maxTurns)
  return {
    threadId: rec.threadId,
    goal: typeof rec.goal === "string" ? rec.goal : "",
    criteria: rebuildCriteria(rec.successCriteria),
    blockers: rebuildBlockers(rec.blockers),
    nextActions: Array.isArray(rec.nextActions)
      ? rec.nextActions.filter((a): a is string => typeof a === "string")
      : [],
    explicitStatus: explicitFromSnapshot(rec),
    ...(typeof rec.usageLimitedUntil === "number" &&
    Number.isFinite(rec.usageLimitedUntil) &&
    rec.usageLimitedUntil > 0
      ? { usageLimitedUntil: rec.usageLimitedUntil }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: finiteNonNegInt(budget.tokensUsed) ?? 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: finiteNonNegInt(budget.turnsUsed) ?? 0,
    createdAt: finiteOrZero(rec.createdAt),
    updatedAt: finiteOrZero(rec.updatedAt),
  }
}
