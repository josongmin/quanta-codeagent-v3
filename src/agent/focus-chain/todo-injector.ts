/**
 * Todo-list injection text renderer (ADR-0219).
 *
 * Pure stringification — turns a {@link FocusTodo[]} into the markdown block
 * the host splices into the prompt. Format is deliberately simple so the
 * model has zero ambiguity about which items remain:
 *
 *   ## Focus Chain — Todos
 *   - [ ] pending item
 *   - [~] in-progress item
 *   - [x] done item
 *
 * The leading `##` heading is required: it lets the model navigate to the
 * block from a long context window via its own attention. Without a
 * heading the list blends into prior `<system-reminder>` content.
 *
 * No IO, no clock — entirely structural.
 */

import type { FocusTodo } from "./port"

const PREFIX: Readonly<Record<FocusTodo["state"], string>> = Object.freeze({
  pending: "- [ ]",
  "in-progress": "- [~]",
  done: "- [x]",
})

const HEADING = "## Focus Chain — Todos"

const TEXT_LIMIT = 200

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s

/** Render a todo list into the markdown block. Returns `null` for an empty
 *  list — the caller treats null as "do not splice anything". */
export const renderTodos = (todos: readonly FocusTodo[]): string | null => {
  if (todos.length === 0) return null
  const lines: string[] = [HEADING]
  for (const t of todos) {
    if (typeof t.text !== "string") continue
    const prefix = PREFIX[t.state]
    if (prefix === undefined) continue
    lines.push(`${prefix} ${truncate(t.text, TEXT_LIMIT)}`)
  }
  // If after filtering nothing survived (every entry was bad shape), return
  // null so the host doesn't splice an empty heading.
  if (lines.length === 1) return null
  return lines.join("\n")
}

/** Sanitize a caller-supplied todo. Drops bad text + clamps the state arm
 *  to `"pending"` for unknown values. Returns null when the todo is so
 *  malformed it should be dropped (non-string text). */
export const sanitizeTodo = (raw: unknown): FocusTodo | null => {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Partial<FocusTodo>
  if (typeof r.text !== "string") return null
  const state =
    r.state === "pending" || r.state === "in-progress" || r.state === "done" ? r.state : "pending"
  return { text: r.text, state }
}
