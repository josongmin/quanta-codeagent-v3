/**
 * QUANTA_WEB_AGENT_STATE — PlanPanel.
 *
 * Renders the latest agent plan mirror (name + version + todo list, one row
 * per todo with a per-status icon) inside the same CARD/LABEL chrome as
 * `ObservabilityPane`. The plan arrives over the out-of-band agent-state WS
 * channel (`plan.created` / `plan.snapshot` / `plan.updated`); the panel reads
 * the mirror verbatim and never mutates it.
 *
 * SELF-HIDING: `plan === null` ⇒ returns `null` (renders nothing). The
 * agent-state channel is default-OFF, so absent a frame no plan ever arrives
 * and this panel stays invisible — chat UI byte-unchanged.
 */

import { memo } from "react"
import type { AgentStatePlan, AgentStateTodoStatus } from "../types/protocol"

export interface PlanPanelProps {
  /** The latest plan mirror, or `null` when no plan has arrived (channel OFF
   *  or no `plan.*` frame yet). `null` ⇒ the panel renders nothing. */
  readonly plan: AgentStatePlan | null
}

/* shared card + section-label primitives (mirror ObservabilityPane tokens) */
const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/** Per-status glyph + tone (mirrors the CLI todo-status legend). */
const STATUS_ICON: Record<AgentStateTodoStatus, { readonly glyph: string; readonly tone: string }> =
  {
    pending: { glyph: "○", tone: "text-ink-tertiary" },
    in_progress: { glyph: "◐", tone: "text-info" },
    completed: { glyph: "●", tone: "text-ok" },
    cancelled: { glyph: "⊘", tone: "text-ink-faint" },
    blocked: { glyph: "▲", tone: "text-err" },
  }

export const PlanPanel = memo(({ plan }: PlanPanelProps): JSX.Element | null => {
  if (plan === null) return null
  return (
    <section className={CARD} data-testid="plan-panel">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className={LABEL}>Plan</h3>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-tertiary">
          v{plan.version}
        </span>
      </header>
      <p className="mt-1 break-words text-sm text-ink">{plan.name}</p>
      {plan.todos.length === 0 ? (
        <p className="mt-2 text-xs text-ink-tertiary">No todos.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {plan.todos.map((todo) => {
            const icon = STATUS_ICON[todo.status]
            return (
              <li
                key={todo.id}
                className="flex items-baseline gap-1.5 text-xs text-ink-secondary"
                data-status={todo.status}
              >
                <span className={`shrink-0 ${icon.tone}`} aria-hidden="true">
                  {icon.glyph}
                </span>
                <span className="break-words">{todo.title}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
})
