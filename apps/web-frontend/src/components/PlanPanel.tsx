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
 *
 * RFC12-1 (plan DAG visualization): when `graphEnabled` is set (the daemon
 * threads `QUANTA_PLAN_GRAPH` through as a capability bit) the panel gains a
 * list⇄graph TOGGLE. The graph view projects the plan's `dependencies` edges to
 * a mermaid `graph TD` string (`planToMermaid`) and renders it via the EXISTING
 * lazy `MermaidDiagram` (in-memory `source` — no artifact fetch). `graphEnabled`
 * UNSET ⇒ no toggle, flat list only — byte-identical to the pre-RFC12-1 panel.
 */

import { lazy, memo, Suspense, useState } from "react"
import type { AgentStatePlan, AgentStateTodoStatus } from "../types/protocol"
import { planToMermaid } from "./PlanMermaid"

/* Heavy renderer — LAZY so mermaid.js stays behind the async boundary and never
 * lands in the initial chunk (same pattern as ArtifactStrip). */
const LazyMermaidDiagram = lazy(async () => {
  const m = await import("./canvas/MermaidDiagram")
  return { default: m.MermaidDiagram }
})

export interface PlanPanelProps {
  /** The latest plan mirror, or `null` when no plan has arrived (channel OFF
   *  or no `plan.*` frame yet). `null` ⇒ the panel renders nothing. */
  readonly plan: AgentStatePlan | null
  /** RFC12-1 — when set, the list⇄graph toggle is offered (the daemon threads
   *  `QUANTA_PLAN_GRAPH`). Unset ⇒ no toggle, flat list only (byte-identical). */
  readonly graphEnabled?: boolean
  /** RFC12-1 — initial view when `graphEnabled` (test seam / deep-link).
   *  Defaults to the flat list. */
  readonly initialView?: "list" | "graph"
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

/** The flat todo list (the pre-RFC12-1 render, extracted verbatim). */
const PlanList = ({ plan }: { plan: AgentStatePlan }): JSX.Element =>
  plan.todos.length === 0 ? (
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
  )

/** The DAG view — projects the plan's `dependencies` edges to a mermaid string
 *  and renders it via the existing lazy MermaidDiagram (in-memory source).
 *
 *  The projected `source` is stamped on an OUTER container (`data-mermaid-source`)
 *  so it is observable WITHOUT resolving the lazy mermaid.js chunk (SSR / a
 *  pre-hydration paint shows the diagram source; the client lazily upgrades it to
 *  a rendered SVG). The `<pre>` inside the Suspense fallback shows the source as
 *  text until the renderer loads. */
const PlanGraph = ({ plan }: { plan: AgentStatePlan }): JSX.Element => {
  const source = planToMermaid(plan.todos)
  return (
    <div className="mt-2" data-testid="plan-graph" data-mermaid-source={source}>
      <Suspense
        fallback={
          <pre className="max-h-56 overflow-auto rounded-lg bg-surface-input px-2 py-1.5 font-mono text-[11px] text-ink-secondary">
            {source}
          </pre>
        }
      >
        <LazyMermaidDiagram source={source} />
      </Suspense>
    </div>
  )
}

export const PlanPanel = memo(
  ({ plan, graphEnabled = false, initialView = "list" }: PlanPanelProps): JSX.Element | null => {
    const [view, setView] = useState<"list" | "graph">(initialView)
    if (plan === null) return null
    const showGraph = graphEnabled && view === "graph"
    return (
      <section className={CARD} data-testid="plan-panel">
        <header className="flex items-baseline justify-between gap-2">
          <h3 className={LABEL}>Plan</h3>
          {/* GATE-OFF byte-identity: when `graphEnabled` is false the header is
              the EXACT pre-RFC12-1 markup (bare version span, no wrapper/toggle).
              The toggle + wrapping div only appear when the graph view is armed. */}
          {graphEnabled ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="plan-view-toggle"
                onClick={() => setView((v) => (v === "list" ? "graph" : "list"))}
                className="rounded-lg border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-secondary hover:bg-black/[0.05] hover:text-ink"
              >
                {view === "list" ? "Graph" : "List"}
              </button>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-tertiary">
                v{plan.version}
              </span>
            </div>
          ) : (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-tertiary">
              v{plan.version}
            </span>
          )}
        </header>
        <p className="mt-1 break-words text-sm text-ink">{plan.name}</p>
        {showGraph ? <PlanGraph plan={plan} /> : <PlanList plan={plan} />}
      </section>
    )
  },
)
