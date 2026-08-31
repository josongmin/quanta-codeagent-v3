import type { GoalReadoutData, GoalReadoutWakeView } from "../types/protocol.readout.generated"

const wakeCopy = (wake: GoalReadoutWakeView | null, now: number): string => {
  if (wake === null) return "wake unavailable"
  if (wake.kind === "stopped") return "wake stopped"
  if (wake.kind === "idle") {
    if (wake.retryAt !== undefined) {
      return `wake ${wake.skipReason} · retry ${Math.max(0, Math.ceil((wake.retryAt - now) / 1_000))}s`
    }
    return `wake ${wake.skipReason}`
  }
  const at = wake.kind === "armed" ? wake.wakeAt : wake.retryAt
  const label = wake.kind === "armed" ? "wake" : "ready"
  return `${label} ${Math.max(0, Math.ceil((at - now) / 1_000))}s`
}

export const GoalStateBar = ({
  state,
  now = Date.now(),
}: {
  state: GoalReadoutData
  now?: number
}) => {
  const objective = state.objective
  const settlement = state.latestSettlement
  return (
    <section
      aria-label="goal status"
      data-testid="goal-state-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle bg-surface-raised px-4 py-2 text-xs"
    >
      <span className="font-medium text-ink">Goal</span>
      {objective === null ? (
        <span className="text-ink-muted">No active goal</span>
      ) : (
        <>
          <span className="max-w-[36rem] truncate text-ink" title={objective.goal}>
            {objective.goal}
          </span>
          <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-ink-muted">
            {objective.status}
          </span>
          <span className="text-ink-muted">freshness {state.freshness}</span>
          <span className="text-ink-muted">{wakeCopy(state.wake, now)}</span>
          {settlement !== null ? (
            <span className="text-ink-muted">
              last {settlement.turnOutcome} · rev {settlement.objectiveRevisionAfter}
            </span>
          ) : null}
        </>
      )}
    </section>
  )
}
