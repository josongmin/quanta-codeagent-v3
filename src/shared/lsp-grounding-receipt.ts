/**
 * LSP-grounding receipt SSOT (jun-23 LSP stability proof, ticket LSP-00).
 *
 * One typed vocabulary for "did the task-relevant language server actually
 * become usable?" — replacing the prior stringly state that was split across
 * a pool `logger.warn`, a remote `{ ready, detail }` verdict, and a CLI
 * log-tail. Every LSP-grounding consumer (warm pool, strict admission gate,
 * remote launch/ready probe, per-instance report, `bench box ls`) maps its
 * reality onto the SAME {@link LspGroundingOutcome} so that:
 *
 *   - strict admission can fail closed on a *typed* outcome, not a log string;
 *   - an expected lifecycle cancellation is never confused with a real failure;
 *   - `missing_binary`, `ready_timeout`, `fatal_transport` stay distinct;
 *   - a report/CLI renderer is a pure projection of the typed receipt.
 *
 * This module is DETERMINISTIC and BENCHMARK-BLIND: no env reads, no clock, no
 * instance/path tables. It only classifies signals it is handed. Timing is the
 * caller's responsibility (stamped into {@link LspGroundingReceipt.durationMs}).
 */

/** Which proof stage the receipt describes.
 *  - `launch`  — the server binary is present + spawnable (cheap preflight);
 *  - `ready`   — the task-relevant workspace reached verified-ready state;
 *  - `runtime` — a real tool call against an already-ready session. */
export type LspGroundingStage = "launch" | "ready" | "runtime"

/** The closed set of LSP-grounding outcomes. ORDER/membership is the contract:
 *  consumers switch exhaustively (see {@link assertNever}).
 *  - `ok`              — stage succeeded (binary launchable / workspace ready / tool answered);
 *  - `missing_binary`  — the required language-server binary is absent on PATH;
 *  - `start_failed`    — the binary exists but the client failed to start;
 *  - `ready_timeout`   — the server started but the workspace never reached
 *                        verified-ready inside the readiness budget;
 *  - `expected_cancel` — an in-flight open was cancelled by a NORMAL lifecycle
 *                        event (turn/session abort, bench session-end evict) —
 *                        observable but NON-alarming;
 *  - `fatal_transport` — the server process/transport died (exited, pump dead);
 *  - `tool_unavailable`— a runtime tool call degraded to "no answer / unavailable"
 *                        on an otherwise-ready session (utility loss, NOT an
 *                        admission failure). */
export type LspGroundingOutcome =
  | "ok"
  | "missing_binary"
  | "start_failed"
  | "ready_timeout"
  | "expected_cancel"
  | "fatal_transport"
  | "tool_unavailable"

/** One typed grounding observation. Pure data — safe to embed in a report row,
 *  a box snapshot, or a CLI render. `language`/`backend` identify WHICH server;
 *  `file` is the anchor/task file the stage exercised. */
export interface LspGroundingReceipt {
  readonly backend: string
  readonly language: string
  readonly stage: LspGroundingStage
  readonly outcome: LspGroundingOutcome
  readonly reason?: string
  readonly file?: string
  readonly durationMs?: number
  /** True when this observation came from a background prewarm (an
   *  OPTIMIZATION), never from the strict-admission ready proof. Admission
   *  authority must ignore prewarm-sourced receipts. */
  readonly fromPrewarm?: boolean
}

/** Outcomes that count as a successfully-proven stage. ONLY `ok`. Strict
 *  admission authority rests on this — a launchable-but-not-ready workspace
 *  (`ready_timeout`) is NOT admissible. */
export const isAdmissibleGroundingOutcome = (outcome: LspGroundingOutcome): boolean =>
  outcome === "ok"

/** Expected lifecycle outcomes are observable but MUST NOT be alarmed on (no
 *  warn log, no "LSP broken" verdict). Today only `expected_cancel`. */
export const isExpectedLifecycleOutcome = (outcome: LspGroundingOutcome): boolean =>
  outcome === "expected_cancel"

/** A genuine, operator-facing failure: not `ok` and not an expected lifecycle
 *  cancellation. These are the outcomes a warn channel reacts to. NOTE: this
 *  includes `tool_unavailable` — that is "real" in the warn-channel sense (a
 *  runtime utility loss worth surfacing), even though it is a RUNTIME-stage
 *  outcome that never reaches the strict-admission gate (which only ever emits
 *  launch/ready receipts). Admission authority uses {@link isAdmissibleGroundingOutcome}
 *  (ok only), not this predicate, so the two never conflict. */
export const isRealGroundingFailure = (outcome: LspGroundingOutcome): boolean =>
  outcome !== "ok" && !isExpectedLifecycleOutcome(outcome)

/** The decomposed signals a caller observed around a ready/launch attempt.
 *  Kept as plain booleans so this classifier stays a pure function with NO
 *  knowledge of the pool's error strings or transport heuristics — the caller
 *  computes each flag from its own (already-tested) predicates and hands them
 *  in. This is what prevents a SECOND, divergent readiness heuristic. */
export interface LspGroundingErrorSignals {
  /** The open/ready was cancelled by an AbortSignal (turn/session abort). */
  readonly aborted: boolean
  /** The cwd was hard-evicted (bench session-end teardown) mid-flight. */
  readonly evicted: boolean
  /** The error is a FATAL transport death (process gone / pump dead). */
  readonly fatalTransport: boolean
  /** The error is the "shared session closed" sentinel (a benign teardown
   *  race, not a transport failure). */
  readonly closedSentinel: boolean
}

/**
 * Classify a thrown launch/ready error into a typed outcome. Pure: same inputs
 * → same outcome. The `stage` only disambiguates the generic tail (a non-cancel,
 * non-transport failure is `start_failed` at launch vs `ready_timeout` at ready).
 *
 * Precedence (high → low):
 *   1. expected cancellation — a lifecycle abort/evict race;
 *   2. fatal transport death;
 *   3. the stage's generic failure.
 *
 * A closed-sentinel error is treated as expected ONLY inside a lifecycle context
 * (clause 1: aborted, or evicted-and-closed). A BARE closed sentinel with no
 * abort/evict context is NOT silently demoted — it falls through to the generic
 * failure (e.g. a sibling fatal-transport teardown that surfaced here as the
 * sentinel must stay on the warn channel). Clause 1 reproduces the warm pool's
 * prior `(hardEvicted || aborted) && (aborted || closedSentinel)` gate exactly,
 * so routing the pool through this classifier preserves its warn/debug split.
 */
export const classifyLspGroundingError = (
  signals: LspGroundingErrorSignals,
  stage: "launch" | "ready",
): LspGroundingOutcome => {
  if ((signals.evicted || signals.aborted) && (signals.aborted || signals.closedSentinel)) {
    return "expected_cancel"
  }
  if (signals.fatalTransport) return "fatal_transport"
  return stage === "launch" ? "start_failed" : "ready_timeout"
}

/** A flattened, render-ready projection of the grounding stages for ONE
 *  workspace — the shape stored in a report row, a box snapshot, and rendered
 *  by `bench box ls`. Each stage outcome is independently optional so a
 *  launch-only probe (no ready proof) is representable without lying about
 *  readiness. */
export interface LspGroundingStatus {
  readonly backend: string
  readonly language: string
  readonly launch?: LspGroundingOutcome
  readonly ready?: LspGroundingOutcome
  readonly runtime?: LspGroundingOutcome
  readonly durationMs?: number
  readonly reason?: string
}

/** Fold an ordered list of receipts (launch → ready → runtime) into one
 *  {@link LspGroundingStatus}. Last write per stage wins (a re-probe supersedes).
 *  Pure: no clock, no env. `durationMs`/`reason` track the highest-stage receipt
 *  so the rendered line reflects the furthest the workspace got. */
export const foldGroundingReceipts = (
  receipts: readonly LspGroundingReceipt[],
): LspGroundingStatus | undefined => {
  if (receipts.length === 0) return undefined
  // Mutable accumulator keyed by stage; last write per stage wins. Building it
  // imperatively (vs nested ternary spreads) keeps cognitive complexity low.
  const acc: { backend: string; language: string } & Partial<LspGroundingStatus> = {
    backend: "",
    language: "",
  }
  for (const r of receipts) {
    if (r.backend !== "") acc.backend = r.backend
    if (r.language !== "") acc.language = r.language
    acc[r.stage] = r.outcome
    if (r.durationMs !== undefined) acc.durationMs = r.durationMs
    if (r.reason !== undefined && r.reason !== "") acc.reason = r.reason
  }
  return acc
}

const GROUNDING_OUTCOMES: ReadonlySet<string> = new Set<LspGroundingOutcome>([
  "ok",
  "missing_binary",
  "start_failed",
  "ready_timeout",
  "expected_cancel",
  "fatal_transport",
  "tool_unavailable",
])

/** Type guard for a value off the wire (a parsed box snapshot JSON) being a
 *  member of the closed {@link LspGroundingOutcome} union. */
export const isLspGroundingOutcome = (value: unknown): value is LspGroundingOutcome =>
  typeof value === "string" && GROUNDING_OUTCOMES.has(value)

/** Defensive parse of an untrusted (JSON-parsed) value into a typed
 *  {@link LspGroundingStatus}, or `undefined` if it is not a valid status. Used
 *  by the `bench box ls` snapshot reader so the CLI consumes the SAME typed enum
 *  the writer emitted instead of re-deriving state from a log tail. Unknown
 *  outcome strings are dropped per-stage (forward-compatible) rather than
 *  poisoning the whole status. */
export const parseLspGroundingStatus = (value: unknown): LspGroundingStatus | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  const backend = typeof v.backend === "string" ? v.backend : undefined
  const language = typeof v.language === "string" ? v.language : undefined
  if (backend === undefined || language === undefined) return undefined
  return {
    backend,
    language,
    ...(isLspGroundingOutcome(v.launch) ? { launch: v.launch } : {}),
    ...(isLspGroundingOutcome(v.ready) ? { ready: v.ready } : {}),
    ...(isLspGroundingOutcome(v.runtime) ? { runtime: v.runtime } : {}),
    ...(typeof v.durationMs === "number" && Number.isFinite(v.durationMs)
      ? { durationMs: v.durationMs }
      : {}),
    ...(typeof v.reason === "string" && v.reason !== "" ? { reason: v.reason } : {}),
  }
}

/** Aggregate measurement (LSP-03). A per-stage outcome histogram + ready-proof
 *  duration summary, folded from a set of grounding statuses (e.g. every
 *  grounding-preset row in a report.json). This is the instrumentation a budget
 *  or anchor-policy change must be justified against — repeated measurement, not
 *  an n=1 timeout twiddle. Pure: no clock, no env, no I/O. */
export interface LspGroundingSummary {
  /** Number of statuses folded. */
  readonly total: number
  /** Count of each outcome at the `launch` stage. */
  readonly launchOutcomes: Readonly<Partial<Record<LspGroundingOutcome, number>>>
  /** Count of each outcome at the `ready` stage. */
  readonly readyOutcomes: Readonly<Partial<Record<LspGroundingOutcome, number>>>
  /** Count of `ready_timeout` across the set (the budget-pressure signal). */
  readonly readyTimeouts: number
  /** Count of `expected_cancel` across all stages (benign lifecycle races). */
  readonly expectedCancels: number
  /** Count of `fatal_transport` across all stages (server death). */
  readonly fatalTransports: number
  /** Ready-proof durations (ms) for statuses that recorded one — sorted asc, so
   *  a caller can read min/median/max without a second pass. Empty ⇒ no timings. */
  readonly readyDurationsMs: readonly number[]
}

const bump = (
  m: Partial<Record<LspGroundingOutcome, number>>,
  o: LspGroundingOutcome | undefined,
): void => {
  if (o !== undefined) m[o] = (m[o] ?? 0) + 1
}

/** Fold grounding statuses into a measurement {@link LspGroundingSummary}. */
export const summarizeGroundingStatuses = (
  statuses: readonly LspGroundingStatus[],
): LspGroundingSummary => {
  const launchOutcomes: Partial<Record<LspGroundingOutcome, number>> = {}
  const readyOutcomes: Partial<Record<LspGroundingOutcome, number>> = {}
  const durations: number[] = []
  let readyTimeouts = 0
  let expectedCancels = 0
  let fatalTransports = 0
  for (const s of statuses) {
    bump(launchOutcomes, s.launch)
    bump(readyOutcomes, s.ready)
    for (const o of [s.launch, s.ready, s.runtime]) {
      if (o === "ready_timeout") readyTimeouts += 1
      if (o === "expected_cancel") expectedCancels += 1
      if (o === "fatal_transport") fatalTransports += 1
    }
    if (s.durationMs !== undefined && Number.isFinite(s.durationMs)) durations.push(s.durationMs)
  }
  return {
    total: statuses.length,
    launchOutcomes,
    readyOutcomes,
    readyTimeouts,
    expectedCancels,
    fatalTransports,
    readyDurationsMs: durations.sort((a, b) => a - b),
  }
}

/** Compact, deterministic one-line render of a grounding status for human
 *  surfaces (`bench box ls`, a degraded verdict line). The STORAGE/transport is
 *  the typed {@link LspGroundingStatus}; this is only a renderer. Shape:
 *  `pyright/python launch=ok ready=ready_timeout (12ms): <reason>`. */
export const renderLspGroundingStatus = (status: LspGroundingStatus): string => {
  const head = `${status.backend || "lsp"}/${status.language || "?"}`
  const stages: string[] = []
  if (status.launch !== undefined) stages.push(`launch=${status.launch}`)
  if (status.ready !== undefined) stages.push(`ready=${status.ready}`)
  if (status.runtime !== undefined) stages.push(`runtime=${status.runtime}`)
  const timing = status.durationMs !== undefined ? ` (${status.durationMs}ms)` : ""
  const reason = status.reason !== undefined && status.reason !== "" ? `: ${status.reason}` : ""
  return `${head} ${stages.join(" ")}${timing}${reason}`.trimEnd()
}
