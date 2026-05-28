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
import type { ApprovalRequest, Objective, RunEntry } from "../types/protocol"
import { type ObservabilityState, splitRunsByStatus } from "../ws/observability-hooks"

export interface ObservabilityPaneProps {
  readonly state: ObservabilityState
  /** Optional retry callback — when present, each Run row in the "Completed"
   *  column shows a "Retry" button. Wiring left to the host. */
  readonly onRetryRun?: (id: string) => void
}

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

export const ObservabilityPane = memo(
  ({ state, onRetryRun }: ObservabilityPaneProps): JSX.Element => {
    const { running, waiting, completed } = splitRunsByStatus(state.runs)
    return (
      <aside
        aria-label="agent observability"
        data-testid="observability-pane"
        className="flex w-80 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-neutral-800 bg-neutral-925 px-3 py-3 text-sm text-neutral-200"
      >
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
      <section
        className="rounded-md border border-neutral-800 bg-neutral-900 p-3"
        data-testid="observability-objective-empty"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Objective
        </h3>
        <p className="mt-1 text-xs text-neutral-500">No active objective.</p>
      </section>
    )
  }
  return (
    <section
      className="rounded-md border border-neutral-800 bg-neutral-900 p-3"
      data-testid="observability-objective"
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Objective
        </h3>
        <ObjectiveStatusBadge status={objective.status} />
      </header>
      <p className="mt-1 break-words text-sm text-neutral-100">{objective.goal}</p>
      {objective.blockers.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-red-400">
            Blockers
          </h4>
          <ul className="mt-1 space-y-1">
            {objective.blockers.map((b) => (
              <li key={b.id} className="text-xs text-neutral-300">
                <span className="text-red-400">●</span> {b.reason}{" "}
                <span className="text-neutral-500">({b.waitingOn})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {objective.nextActions.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Next actions
          </h4>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {objective.nextActions.map((a) => (
              <li key={a} className="text-xs text-neutral-300">
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
      ? "bg-red-900 text-red-100"
      : status === "completed"
        ? "bg-emerald-900 text-emerald-100"
        : "bg-neutral-800 text-neutral-300"
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
        <section
          className="rounded-md border border-neutral-800 bg-neutral-900 p-3"
          data-testid="observability-approvals-empty"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Pending approvals
          </h3>
          <p className="mt-1 text-xs text-neutral-500">No approvals waiting.</p>
        </section>
      )
    }
    return (
      <section
        className="rounded-md border border-amber-700 bg-amber-950 p-3"
        data-testid="observability-approvals"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">
          Pending approvals ({approvals.length})
        </h3>
        <ul className="mt-2 space-y-2">
          {approvals.map((a) => (
            <li key={a.id} className="rounded border border-amber-800 bg-amber-900/50 p-2">
              <div className="text-xs font-medium text-amber-100">{a.reason}</div>
              <div className="mt-1 text-[11px] text-amber-200/80">
                <span className="opacity-70">action:</span>{" "}
                <code className="rounded bg-black/40 px-1 py-0.5">{a.proposedAction}</code>
              </div>
              <div className="mt-0.5 text-[11px] text-amber-200/80">
                <span className="opacity-70">resume:</span> {a.resumeStep}
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
  emerald: "bg-emerald-500",
  amber: "bg-amber-400",
  neutral: "bg-neutral-500",
}

const RunColumn = memo(
  ({ title, runs, tone, onRetryRun }: RunColumnProps): JSX.Element => (
    <section
      className="rounded-md border border-neutral-800 bg-neutral-900 p-3"
      data-testid={`observability-runs-${title.toLowerCase()}`}
    >
      <header className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${TONE_TO_DOT[tone]}`} />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {title} ({runs.length})
        </h3>
      </header>
      {runs.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-600">Empty.</p>
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
    <li className="rounded border border-neutral-800 bg-neutral-925">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left hover:bg-neutral-800/50"
      >
        <span className="truncate text-xs text-neutral-200" title={run.title}>
          {run.title}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-500">
          {run.kind}
        </span>
      </button>
      {open ? (
        <div className="border-t border-neutral-800 px-2 py-1.5 text-[11px] text-neutral-300">
          <div>
            <span className="text-neutral-500">id:</span> {run.id}
          </div>
          {run.waitingOn !== undefined ? (
            <div>
              <span className="text-neutral-500">waiting on:</span> {run.waitingOn}
            </div>
          ) : null}
          {run.resumeAction !== undefined ? (
            <div>
              <span className="text-neutral-500">resume:</span>{" "}
              <code className="rounded bg-black/40 px-1">{run.resumeAction}</code>
            </div>
          ) : null}
          {run.error !== undefined ? (
            <div className="text-red-400">
              <span className="text-neutral-500">error:</span> {run.error}
            </div>
          ) : null}
          {run.artifacts.length > 0 ? (
            <div className="mt-1">
              <span className="text-neutral-500">artifacts:</span>
              <ul className="ml-2 mt-0.5 list-disc">
                {run.artifacts.map((a) => (
                  <li key={`${a.kind}:${a.ref}`}>
                    <span className="text-neutral-500">{a.kind}:</span> {a.ref}
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
              className="mt-2 rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
})
