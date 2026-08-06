/**
 * RFC12-1 — web-local plan → mermaid `graph TD` projector.
 *
 * The web bundle lives OUTSIDE the root tsconfig `paths` (copy-not-import, same
 * posture as `types/protocol.ts`), so it cannot import the root
 * `@/tool/plan/plan-to-mermaid`. This is a byte-for-byte mirror of that pure
 * projector; the two are pinned identical by the root parity hellgate
 * `plan-to-mermaid-web-parity-hellgate.test.ts` (a fixture fed to BOTH must
 * yield the SAME string), so they can never drift.
 *
 * Consumes the agent-state todo mirror (`AgentStateTodo` — id/title/status +
 * the RFC12-1 optional `dependencies` DAG edges) and emits one node per todo +
 * one `dep --> id` edge per dependency. Deterministic (nodes sorted by id, edges
 * sorted + deduped), cycle-safe, dangling-dep-dropping. PURE — no React, no IO.
 */

import type { AgentStateTodo } from "../types/protocol"

/** Escape a node LABEL for a mermaid `id["..."]` declaration (mirror of the root
 *  projector's `escapeLabel`): a raw `"` closes the label early; mermaid renders
 *  `#quot;` back to a literal quote. `#` is escaped first so a title containing
 *  `#quot;` is not mistaken for our escape. */
const escapeLabel = (title: string): string => title.replace(/#/g, "#35;").replace(/"/g, "#quot;")

/**
 * Project the plan's todos into a mermaid `graph TD` string; `"graph TD"` alone
 * for an empty plan. Reads each todo's optional `dependencies` (the RFC07-3
 * blocked-by edges the wire mirror carries).
 */
export const planToMermaid = (todos: readonly AgentStateTodo[]): string => {
  const nodes = todos.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const known = new Set(nodes.map((n) => n.id))

  const seen = new Set<string>()
  const edges: { from: string; to: string }[] = []
  for (const n of nodes) {
    for (const dep of n.dependencies ?? []) {
      if (!known.has(dep)) continue // dangling — no phantom node/edge
      const key = `${dep} ${n.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: dep, to: n.id })
    }
  }
  edges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  )

  const lines: string[] = ["graph TD"]
  for (const n of nodes) lines.push(`  ${n.id}["${escapeLabel(n.title)}"]`)
  for (const e of edges) lines.push(`  ${e.from} --> ${e.to}`)
  for (const n of nodes) lines.push(`  class ${n.id} ${n.status}`)
  return lines.join("\n")
}
