/**
 * tools/slice-graph/report.ts — render `SliceGraph` + violations in three
 * formats: console table, Graphviz dot, Markdown summary.
 *
 * Plane-clean: `node:path` only + sibling tool modules. No `@/*`, no I/O
 * beyond stdout (the caller redirects to a `.dot` / `.md` file).
 *
 * Bun-runnable:
 *   bun tools/slice-graph/report.ts            # console table
 *   bun tools/slice-graph/report.ts --dot      # Graphviz dot
 *   bun tools/slice-graph/report.ts --markdown # Markdown summary
 */

import { type SliceGraph, buildSliceGraph } from "./build-graph"
import { type SliceGraphViolation, validateGraph } from "./validate"

export type ReportFormat = "console" | "dot" | "markdown"

export interface RenderOpts {
  readonly graph: SliceGraph
  readonly violations: ReadonlyArray<SliceGraphViolation>
}

/** Renders an ASCII table of violations grouped by source slice. */
export const renderConsole = ({ graph, violations }: RenderOpts): string => {
  const lines: string[] = []
  lines.push(`# slice-graph console report`)
  lines.push(`slices: ${graph.slices.length}`)
  lines.push(`edges:  ${graph.edges.length}`)
  lines.push(`violations: ${violations.length}`)
  lines.push("")
  if (violations.length === 0) {
    lines.push("(no violations)")
    return lines.join("\n")
  }
  const byFrom = new Map<string, SliceGraphViolation[]>()
  for (const v of violations) {
    const bucket = byFrom.get(v.from)
    if (bucket === undefined) byFrom.set(v.from, [v])
    else bucket.push(v)
  }
  const fromKeys = [...byFrom.keys()].sort()
  for (const from of fromKeys) {
    const bucket = byFrom.get(from) ?? []
    lines.push(`## ${from}  (${bucket.length} violation(s))`)
    for (const v of bucket) {
      lines.push(`  - ${v.file}`)
      lines.push(`      ${v.from} -> ${v.to}`)
      lines.push(`      ${v.reason}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

/** Renders a Graphviz dot graph. Forbidden edges are omitted (the dot
 *  should reflect the INTENDED architecture, not the broken one); a
 *  separate `comment` line lists them for the reader. */
export const renderDot = ({ graph, violations }: RenderOpts): string => {
  const forbidden = new Set<string>()
  for (const v of violations) forbidden.add(`${v.from}->${v.to}`)
  const lines: string[] = []
  lines.push(`digraph slices {`)
  lines.push(`  rankdir=LR;`)
  lines.push(`  node [shape=box, style=rounded];`)
  for (const slice of graph.slices) {
    lines.push(`  "${slice}";`)
  }
  for (const edge of graph.edges) {
    const key = `${edge.from}->${edge.to}`
    if (forbidden.has(key)) {
      lines.push(`  // FORBIDDEN: "${edge.from}" -> "${edge.to}"  (count=${edge.count})`)
      continue
    }
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.count}"];`)
  }
  lines.push(`}`)
  return lines.join("\n")
}

/** Renders a Markdown summary with top-10 most-imported slices + the
 *  full violations list. */
export const renderMarkdown = ({ graph, violations }: RenderOpts): string => {
  const incoming = new Map<string, number>()
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + edge.count)
  }
  const ranked = [...incoming.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const lines: string[] = []
  lines.push(`# Slice Graph Report`)
  lines.push("")
  lines.push(`- **slices**: ${graph.slices.length}`)
  lines.push(`- **edges**: ${graph.edges.length}`)
  lines.push(`- **violations**: ${violations.length}`)
  lines.push("")
  lines.push(`## Top 10 most-imported slices`)
  lines.push("")
  lines.push(`| Rank | Slice | Incoming imports |`)
  lines.push(`| --- | --- | --- |`)
  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i]
    if (entry === undefined) continue
    const [slice, count] = entry
    lines.push(`| ${i + 1} | \`${slice}\` | ${count} |`)
  }
  lines.push("")
  if (violations.length === 0) {
    lines.push(`## Violations`)
    lines.push("")
    lines.push(`(none — slice fence holds)`)
    return lines.join("\n")
  }
  lines.push(`## Violations`)
  lines.push("")
  for (const v of violations) {
    lines.push(`- \`${v.from}\` -> \`${v.to}\``)
    lines.push(`  - file: \`${v.file}\``)
    lines.push(`  - reason: ${v.reason}`)
  }
  return lines.join("\n")
}

const parseFormat = (argv: ReadonlyArray<string>): ReportFormat => {
  if (argv.includes("--dot")) return "dot"
  if (argv.includes("--markdown") || argv.includes("--md")) return "markdown"
  return "console"
}

const isDirectInvocation = (): boolean => {
  const meta = import.meta as unknown as { main?: boolean }
  if (typeof meta.main === "boolean") return meta.main
  const argv1 = typeof process !== "undefined" ? process.argv[1] : undefined
  return typeof argv1 === "string" && argv1.endsWith("report.ts")
}

if (isDirectInvocation()) {
  buildSliceGraph().then((graph) => {
    const violations = validateGraph(graph)
    const format = parseFormat(typeof process !== "undefined" ? process.argv : [])
    let rendered: string
    if (format === "dot") rendered = renderDot({ graph, violations })
    else if (format === "markdown") rendered = renderMarkdown({ graph, violations })
    else rendered = renderConsole({ graph, violations })
    // biome-ignore lint/suspicious/noConsole: CLI tool entry — stdout is the contract.
    console.log(rendered)
    process.exit(violations.length === 0 ? 0 : 1)
  })
}
