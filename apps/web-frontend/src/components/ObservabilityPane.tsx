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
import type { ApprovalRequest, ContextUsageMessage, Objective, RunEntry } from "../types/protocol"
import { type ObservabilityState, splitRunsByStatus } from "../ws/observability-hooks"
import { UsageBreakdownPanel } from "./canvas/UsageBreakdownPanel"

export interface ObservabilityPaneProps {
  readonly state: ObservabilityState
  /** Optional retry callback — when present, each Run row in the "Completed"
   *  column shows a "Retry" button. Wiring left to the host. */
  readonly onRetryRun?: (id: string) => void
  /** ADR-0448 (RFC-10): the latest `context.usage` frame from RFC-06's canvas
   *  data port (`useContextUsage`). When present + non-null, the rich
   *  `UsageBreakdownPanel` (UsageBar + Swatch legend + per-category drilldown)
   *  mounts at the top of the pane. Absent / `null` ⇒ nothing renders
   *  (default-OFF — the pane is byte-unchanged when the canvas channel is OFF). */
  readonly usage?: ContextUsageMessage | null
}

/* shared card + section-label primitives (Codex-aligned tokens) */
const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

export const ObservabilityPane = memo(
  ({ state, onRetryRun, usage }: ObservabilityPaneProps): JSX.Element => {
    const { running, waiting, completed } = splitRunsByStatus(state.runs)
    return (
      <aside
        aria-label="agent observability"
        data-testid="observability-pane"
        className="flex w-80 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-line-subtle bg-surface-raised px-3 py-4 text-sm text-ink-secondary"
      >
        <UsageBreakdownPanel usage={usage ?? null} />
        <ObjectiveCard objective={state.objective} />
        <ApprovalsList approvals={state.approvals} />
        <RunColumn title="Running" runs={running} tone="emerald" />
        <RunColumn title="Waiting" runs={waiting} tone="amber" />
        <RunColumn
          title="Completed"
          runs={completed}
          tone="neutral"
          {...(onRetryRun !== undefined ? { onRetryRun } : {})}
        />
      </aside>
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
        <ul className="mt-2 space-y-2">
          {approvals.map((a) => (
            <li key={a.id} className="rounded-lg border border-warn/20 bg-warn/5 p-2">
              <div className="text-xs font-medium text-ink">{a.reason}</div>
              <div className="mt-1 text-[11px] text-ink-secondary">
                <span className="text-ink-tertiary">action:</span>{" "}
                <code className="rounded bg-surface-input px-1 py-0.5 font-mono">
                  {a.proposedAction}
                </code>
              </div>
              <div className="mt-0.5 text-[11px] text-ink-secondary">
                <span className="text-ink-tertiary">resume:</span> {a.resumeStep}
              </div>
            </li>
          ))}
        </ul>
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
  readonly onRetryRun?: (id: string) => void
}

const TONE_TO_DOT: Record<RunColumnProps["tone"], string> = {
  emerald: "bg-info",
  amber: "bg-warn",
  neutral: "bg-ink-tertiary",
}

const RunColumn = memo(
  ({ title, runs, tone, onRetryRun }: RunColumnProps): JSX.Element => (
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
            <RunRow key={r.id} run={r} {...(onRetryRun !== undefined ? { onRetryRun } : {})} />
          ))}
        </ul>
      )}
    </section>
  ),
)

interface RunRowProps {
  readonly run: RunEntry
  readonly onRetryRun?: (id: string) => void
}

const RunRow = memo(({ run, onRetryRun }: RunRowProps): JSX.Element => {
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
            <span className="text-ink-tertiary">id:</span> <span className="font-mono">{run.id}</span>
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
          {onRetryRun !== undefined &&
          (run.status === "failed" || run.status === "stopped" || run.status === "completed") ? (
            <button
              type="button"
              onClick={() => onRetryRun(run.id)}
              className="mt-2 rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-secondary hover:bg-black/[0.05] hover:text-ink"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})
