/**
 * ADR-0408 — Observability pane.
 *
 * Renders the three observability axes alongside (right of) the chat:
 *
 *   - **Running / Waiting / Completed** — three-column run-ledger view, one
 *     row per `RunEntry`. Click a row to expand artifacts + resume hint.
 *   - **Objective card** — goal / status / blockers / nextActions for the
 *     current thread.
 *   - **Pending Approvals** — every approval the agent is waiting on,
 *     each with the proposed action + resume step.
 *
 * Sources its data from `useObservabilityState` (which consumes the WS
 * `observability.*` channel). With no messages received it renders empty
 * placeholders so the pane is non-fatal when the env is OFF.
 */

import { memo, useState } from "react"
import type {
  ApprovalRequest,
  ArtifactReadyMessage,
  ContextUsageMessage,
  Objective,
  RunEntry,
  ToolDiffMessage,
} from "../types/protocol"
import type { ItemStreamState } from "../ws/item-stream-hooks"
import { type ObservabilityState, splitRunsByStatus } from "../ws/observability-hooks"
import { ArtifactStrip } from "./canvas/ArtifactStrip"
import { UsageBreakdownPanel } from "./canvas/UsageBreakdownPanel"
import { DiffPanel } from "./DiffPanel"
import { ItemStreamSection } from "./ItemStreamSection"

export interface ObservabilityPaneProps {
  readonly state: ObservabilityState
  /** ADR-0448 (RFC-10): the latest `context.usage` frame from RFC-06's canvas
   *  data port (`useContextUsage`). When present + non-null, the rich
   *  `UsageBreakdownPanel` (UsageBar + Swatch legend + per-category drilldown)
   *  mounts at the top of the pane. Absent / `null` ⇒ nothing renders
   *  (default-OFF — the pane is byte-unchanged when the canvas channel is OFF). */
  readonly usage?: ContextUsageMessage | null
  /** ADR-0440: the latest `tool.diff` frame per `toolCallId` from the canvas
   *  channel (`useToolDiffs`). When present + non-empty, a `DiffPanel` mounts
   *  per captured tool mutation. Absent / empty ⇒ nothing renders (default-OFF
   *  — the pane is byte-unchanged when the canvas channel is OFF). */
  readonly diffs?: ReadonlyMap<string, ToolDiffMessage> | null
  /** A2: the latest `artifact.ready` frame per `artifactId` from the canvas
   *  channel (`useArtifacts`). When present + non-empty, an `ArtifactStrip`
   *  mounts (per-kind preview / download cards). Absent / empty ⇒ nothing
   *  renders (default-OFF — byte-unchanged when the canvas channel is OFF). */
  readonly artifacts?: ReadonlyMap<string, ArtifactReadyMessage> | null
  /** S2: the folded `item.*` stream state from `useItemStream`. When present +
   *  non-empty, an `ItemStreamSection` mounts (subagent activity rows +
   *  plan/blocked status). Absent / empty ⇒ nothing renders (default-OFF —
   *  gated by `QUANTA_ITEM_STREAM`; no frames ⇒ empty). */
  readonly itemStream?: ItemStreamState | null
}

/* shared card + section-label primitives (Codex-aligned tokens) */
const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

export const ObservabilityPane = memo(
  ({ state, usage, diffs, artifacts, itemStream }: ObservabilityPaneProps): JSX.Element => {
    const { running, waiting, completed } = splitRunsByStatus(state.runs)
    return (
      <aside
        aria-label="agent observability"
        data-testid="observability-pane"
        className="flex w-80 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-line-subtle bg-surface-raised px-3 py-4 text-sm text-ink-secondary"
      >
        <UsageBreakdownPanel usage={usage ?? null} />
        <ObjectiveCard objective={state.objective} />
        <DiffsSection diffs={diffs ?? null} />
        <ArtifactStrip artifacts={artifacts ?? null} />
        <ItemStreamSection state={itemStream ?? null} />
        <ApprovalsList approvals={state.approvals} />
        <RunColumn title="Running" runs={running} tone="emerald" />
        <RunColumn title="Waiting" runs={waiting} tone="amber" />
        <RunColumn title="Completed" runs={completed} tone="neutral" />
      </aside>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Tool diffs (ADR-0440)                                               */
/* ------------------------------------------------------------------ */

/** Renders one `DiffPanel` per captured tool mutation (latest-wins per
 *  `toolCallId`, insertion-ordered). Empty / null ⇒ renders nothing (the
 *  canvas channel is OFF or no mutation has been captured yet). */
const DiffsSection = memo(
  ({ diffs }: { diffs: ReadonlyMap<string, ToolDiffMessage> | null }): JSX.Element | null => {
    if (diffs === null || diffs.size === 0) return null
    return (
      <section className="flex flex-col gap-2" data-testid="diffs-section">
        <span className={LABEL}>Diffs</span>
        {[...diffs.values()].map((diff) => (
          <DiffPanel key={diff.toolCallId} diff={diff} />
        ))}
      </section>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Objective                                                           */
/* ------------------------------------------------------------------ */

const ObjectiveCard = memo(({ objective }: { objective: Objective | null }): JSX.Element => {
  if (objective === null) {
    return (
      <section className={CARD} data-testid="observability-objective-empty">
        <h3 className={LABEL}>Objective</h3>
        <p className="mt-1 text-xs text-ink-tertiary">No active objective.</p>
      </section>
    )
  }
  return (
    <section className={CARD} data-testid="observability-objective">
      <header className="flex items-baseline justify-between">
        <h3 className={LABEL}>Objective</h3>
        <ObjectiveStatusBadge status={objective.status} />
      </header>
      <p className="mt-1.5 break-words text-sm text-ink">{objective.goal}</p>
      {objective.blockers.length > 0 ? (
        <div className="mt-2.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-err">Blockers</h4>
          <ul className="mt-1 space-y-1">
            {objective.blockers.map((b) => (
              <li key={b.id} className="text-xs text-ink-secondary">
                <span className="text-err">●</span> {b.reason}{" "}
                <span className="text-ink-tertiary">({b.waitingOn})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {objective.nextActions.length > 0 ? (
        <div className="mt-2.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
            Next actions
          </h4>
          <ul className="mt-1 list-inside list-disc space-y-0.5 marker:text-ink-faint">
            {objective.nextActions.map((a) => (
              <li key={a} className="text-xs text-ink-secondary">
                {a}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
})

const ObjectiveStatusBadge = ({ status }: { status: Objective["status"] }): JSX.Element => {
  const tone =
    status === "blocked"
      ? "bg-err/15 text-err"
      : status === "completed"
        ? "bg-ok/15 text-ok"
        : "bg-black/[0.05] text-ink-secondary"
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {status}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * UUX-2-08 — honest approvals: the observability channel's approval rows are
 * READ-ONLY mirrors; the actionable surface is the live `EscalationCard` flow
 * next to the composer (`data-testid="pending-approvals"`). Rendering the raw
 * rows here looked actionable but wasn't, so this section is a COUNT + a link
 * that scrolls to the real card — no fake affordance.
 */
export const scrollToPendingApprovals = (): void => {
  if (typeof document === "undefined") return
  document
    .querySelector('[data-testid="pending-approvals"]')
    ?.scrollIntoView({ behavior: "smooth", block: "center" })
}

const ApprovalsList = memo(
  ({ approvals }: { approvals: readonly ApprovalRequest[] }): JSX.Element => {
    if (approvals.length === 0) {
      return (
        <section className={CARD} data-testid="observability-approvals-empty">
          <h3 className={LABEL}>Pending approvals</h3>
          <p className="mt-1 text-xs text-ink-tertiary">No approvals waiting.</p>
        </section>
      )
    }
    return (
      <section
        className="rounded-xl border border-warn/30 bg-warn/5 p-3"
        data-testid="observability-approvals"
      >
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-warn">
          Pending approvals ({approvals.length})
        </h3>
        <p className="mt-1 text-xs text-ink-secondary">
          The agent is waiting on {approvals.length === 1 ? "a decision" : "decisions"} — respond in
          the approval card by the composer.
        </p>
        <button
          type="button"
          onClick={scrollToPendingApprovals}
          className="mt-2 rounded-lg border border-warn/40 px-2 py-0.5 text-[11px] text-ink-secondary transition hover:bg-warn/10 hover:text-ink"
        >
          Go to approval card
        </button>
      </section>
    )
  },
)

/* ------------------------------------------------------------------ */
/* Run columns                                                         */
/* ------------------------------------------------------------------ */

interface RunColumnProps {
  readonly title: "Running" | "Waiting" | "Completed"
  readonly runs: readonly RunEntry[]
  readonly tone: "emerald" | "amber" | "neutral"
}

const TONE_TO_DOT: Record<RunColumnProps["tone"], string> = {
  emerald: "bg-info",
  amber: "bg-warn",
  neutral: "bg-ink-tertiary",
}

const RunColumn = memo(
  ({ title, runs, tone }: RunColumnProps): JSX.Element => (
    <section className={CARD} data-testid={`observability-runs-${title.toLowerCase()}`}>
      <header className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${TONE_TO_DOT[tone]}`} />
        <h3 className={LABEL}>
          {title} ({runs.length})
        </h3>
      </header>
      {runs.length === 0 ? (
        <p className="mt-2 text-xs text-ink-tertiary">Empty.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </section>
  ),
)

interface RunRowProps {
  readonly run: RunEntry
}

// D-8 (UUX-2-09): the per-run "Retry" button was removed — App never passed
// `onRetryRun`, so it was a permanently dead affordance. Reintroduce only
// when a real run-control endpoint exists.
const RunRow = memo(({ run }: RunRowProps): JSX.Element => {
  const [open, setOpen] = useState(false)
  const toggle = (): void => setOpen((prev) => !prev)
  return (
    <li className="rounded-lg border border-line-subtle bg-surface-raised">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/[0.05]"
      >
        <span className="truncate text-xs text-ink-secondary" title={run.title}>
          {run.title}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-tertiary">
          {run.kind}
        </span>
      </button>
      {open ? (
        <div className="border-t border-line-subtle px-2 py-1.5 text-[11px] text-ink-secondary">
          <div>
            <span className="text-ink-tertiary">id:</span>{" "}
            <span className="font-mono">{run.id}</span>
          </div>
          {run.waitingOn !== undefined ? (
            <div>
              <span className="text-ink-tertiary">waiting on:</span> {run.waitingOn}
            </div>
          ) : null}
          {run.resumeAction !== undefined ? (
            <div>
              <span className="text-ink-tertiary">resume:</span>{" "}
              <code className="rounded bg-surface-input px-1 font-mono">{run.resumeAction}</code>
            </div>
          ) : null}
          {run.error !== undefined ? (
            <div className="text-err">
              <span className="text-ink-tertiary">error:</span> {run.error}
            </div>
          ) : null}
          {run.artifacts.length > 0 ? (
            <div className="mt-1">
              <span className="text-ink-tertiary">artifacts:</span>
              <ul className="ml-2 mt-0.5 list-disc marker:text-ink-faint">
                {run.artifacts.map((a) => (
                  <li key={`${a.kind}:${a.ref}`}>
                    <span className="text-ink-tertiary">{a.kind}:</span> {a.ref}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})
