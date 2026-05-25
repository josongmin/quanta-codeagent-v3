/**
 * Focus-chain adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Adapts `AgentConfig.focusChain.tracker` (ADR-0219 FocusChainPort) onto
 * the `SlashContext.focusChain` shape `/focus-chain` consumes. The
 * tracker owns the todo + turn state — this adapter is a thin façade
 * mapping `snapshot/reset/skip` to its `snapshotTodos/setTodos([])/
 * tickTurn` primitives. `reset` clears the list; `skip` bumps the
 * counter past the next injection slot.
 */

import type { FocusChainPort, FocusTodo } from "@/agent/focus-chain"

export interface FocusChainAdapter {
  readonly snapshot: () => {
    readonly todos: ReadonlyArray<{ readonly text: string; readonly state: string }>
    readonly currentTurn: number
    readonly driftWarning: string | null
  }
  readonly reset: () => void
  readonly skip: () => void
}

const projectTodo = (t: FocusTodo): { readonly text: string; readonly state: string } => ({
  text: t.text,
  state: t.state,
})

/** Build the adapter over the AgentConfig.focusChain.tracker. */
export const buildFocusChainAdapter = (tracker: FocusChainPort): FocusChainAdapter => ({
  snapshot: () => {
    const todos = tracker.snapshotTodos().map(projectTodo)
    return {
      todos,
      currentTurn: tracker.currentTurn(),
      driftWarning: tracker.getDriftWarning(),
    }
  },
  reset: (): void => {
    tracker.setTodos([])
  },
  skip: (): void => {
    tracker.tickTurn()
  },
})
