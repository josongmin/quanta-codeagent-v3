import { byteCompare } from "@/shared/byte-compare"
import type { Plan, TodoItem } from "./types"

const orderedTodos = (plan: Plan): TodoItem[] =>
  Object.values(plan.todos).sort((a, b) => a.createdAt - b.createdAt || byteCompare(a.id, b.id))

const todoMarker = (todo: TodoItem): string => {
  switch (todo.status) {
    case "completed":
      return "[x]"
    case "in_progress":
      return "[~]"
    case "pending":
    case "blocked":
    case "cancelled":
      return "[ ]"
    default: {
      const exhaustive: never = todo.status
      return exhaustive
    }
  }
}

/** Render a structured plan into a deterministic markdown body suitable for
 *  read-only prompt injection after plan approval. */
export const renderPlanAsMarkdown = (plan: Plan): string => {
  const lines: string[] = [`# ${plan.name}`]
  if (plan.overview.trim().length > 0) {
    lines.push("")
    lines.push(plan.overview)
  }
  const todos = orderedTodos(plan)
  if (todos.length > 0) {
    lines.push("")
    lines.push("## Todos")
    for (const todo of todos) {
      lines.push(`- ${todoMarker(todo)} ${todo.content}`)
    }
  }
  return lines.join("\n")
}
