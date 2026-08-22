/**
 * A3 (jul-03) — `/kb` Projects knowledge-base surface.
 *
 * `projects_kb` is a MODEL-invoke-only context-offloading tool (the agent writes
 * large local files into a session-scoped KB, then searches them, without paying
 * for the raw bytes in its own context window). Until now there was NO user-facing
 * way to SEE what had been offloaded — the store's `knowledge{}` byte-budget
 * accounting was surfaced only to the model (`project_info`).
 *
 * `/kb` reads that SAME accounting (byte budget + doc count) so the operator can
 * answer "what's in the KB, how big is it, is RAG active?". The store deliberately
 * hides doc BODIES (leak-safe by design — see `@/tool/projects-kb/store.ts`), so
 * `/kb` shows the byte-budget counters + the doc count, never doc contents.
 *
 * DEFAULT-OFF: the `projectsKb` ctx slot is threaded ONLY when `QUANTA_PROJECTS_KB`
 * is on AND the store is reachable; absent ⇒ `/kb` prints the D-6 not-wired
 * posture (hint names QUANTA_PROJECTS_KB) + exit 2 (UUX-2-22).
 *
 * Slice-clean: this module imports NO `@/tool` VALUE — it consumes a duck-typed
 * `KbSlashState` the surface builds over the live `ProjectsKbStore`.
 */

import { notWired } from "../not-wired"
import type { SlashCommand, SlashContext } from "../slash-contract"

/** The `knowledge{}` byte-budget accounting snapshot — structural mirror of
 *  `@/tool/projects-kb`'s `ProjectsKbKnowledge` (no `@/tool` value import). */
export interface KbKnowledgeView {
  readonly knowledge_size: number
  readonly max_knowledge_size: number
  readonly search_threshold: number
  readonly rag_active: boolean
  readonly remaining_budget: number
}

/** Read-only `/kb` wire over the live `ProjectsKbStore`. `knowledge()` reads the
 *  live byte-budget accounting; `docCount()` reads the retained doc count. */
export interface KbSlashState {
  readonly knowledge: () => KbKnowledgeView
  readonly docCount: () => number
}

/** Format a byte count human-legibly: `512 B`, `40.0 KiB`, `4.0 MiB`. */
const formatBytes = (n: number): string => {
  if (n < 1024) return `${Math.max(0, Math.trunc(n))} B`
  const kib = n / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}

/** Render the KB accounting panel. Pure — the caller supplies the live view. */
export const renderKbPanel = (k: KbKnowledgeView, docCount: number): string => {
  const pct =
    k.max_knowledge_size > 0 ? Math.round((k.knowledge_size / k.max_knowledge_size) * 100) : 0
  return [
    `Projects KB — ${docCount} doc${docCount === 1 ? "" : "s"} offloaded (bodies hidden — leak-safe):`,
    `  size       ${formatBytes(k.knowledge_size)} / ${formatBytes(k.max_knowledge_size)} (${pct}%)`,
    `  remaining  ${formatBytes(k.remaining_budget)}`,
    `  RAG        ${k.rag_active ? "active" : "inactive"} (threshold ${formatBytes(k.search_threshold)})`,
  ].join("\n")
}

/** `/kb` — show the Projects knowledge-base byte-budget accounting + doc count.
 *  Absent slot ⇒ "not wired" + exit 0 (default-OFF byte-identical). */
export const kbCmd: SlashCommand = {
  name: "/kb",
  describe: "Show the Projects knowledge-base accounting (offloaded docs, byte budget, RAG state)",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.projectsKb === undefined) {
      return notWired(ctx.out, { feature: "/kb", gate: "QUANTA_PROJECTS_KB" })
    }
    if (args.length > 0) {
      ctx.err("/kb: takes no arguments\n")
      return 1
    }
    const count = ctx.projectsKb.docCount()
    if (count === 0) {
      ctx.out("/kb: no documents offloaded yet\n")
      return 0
    }
    ctx.out(`${renderKbPanel(ctx.projectsKb.knowledge(), count)}\n`)
    return 0
  },
}
