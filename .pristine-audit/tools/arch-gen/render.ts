/**
 * tools/arch-gen/render.ts — markdown renderer.
 *
 * Consumes (adrs, slices) and emits the body of `ARCHITECTURE.generated.md`.
 * Plane clustering uses the same heuristic exposed in scan-adrs. The render
 * is byte-deterministic given the same inputs (sort everything; no Date.now
 * unless caller passes `today`).
 *
 * Pure: only depends on `node:path` (for path.relative when caller wires it).
 * No `@/*`.
 */
import type { AdrPlane, AdrSummary } from "./scan-adrs"
import type { SliceSummary } from "./scan-slices"

export interface RenderOpts {
  /** ISO date stamp (default "YYYY-MM-DD" from caller; tests fix it). */
  readonly today: string
  /** Optional: extra footer counters. */
  readonly hellgateCount?: number
  /** Optional: number of distinct ADR numbers (after collision collapse). */
  readonly distinctAdrCount?: number
}

const PLANE_ORDER: ReadonlyArray<AdrPlane | "uncategorized"> = [
  "domain",
  "application",
  "infrastructure",
  "observability",
  "security",
  "uncategorized",
]

const PLANE_HEADINGS: Record<AdrPlane | "uncategorized", string> = {
  domain: "Domain / Ports",
  application: "Application / Orchestration",
  infrastructure: "Infrastructure / Adapters",
  observability: "Observability / Telemetry",
  security: "Security / Sandboxing",
  uncategorized: "Uncategorized",
}

/** Group ADRs by plane (with uncategorized bucket). */
const groupAdrsByPlane = (
  adrs: ReadonlyArray<AdrSummary>,
): Map<AdrPlane | "uncategorized", ReadonlyArray<AdrSummary>> => {
  const out = new Map<AdrPlane | "uncategorized", AdrSummary[]>()
  for (const plane of PLANE_ORDER) out.set(plane, [])
  for (const adr of adrs) {
    const key: AdrPlane | "uncategorized" = adr.plane ?? "uncategorized"
    const bucket = out.get(key)
    if (bucket) bucket.push(adr)
  }
  return out
}

/** Build a relative link to `docs/decisions/<filename>` from a markdown line. */
const adrLink = (adr: AdrSummary): string => `[ADR-${adr.number}](./decisions/${adr.filename})`

const renderAdrLine = (adr: AdrSummary): string => {
  const related =
    adr.related.length > 0 ? ` — related: ${adr.related.map((n) => `ADR-${n}`).join(", ")}` : ""
  const dateStr = adr.date ? ` _(${adr.date})_` : ""
  return `- ${adrLink(adr)} **${adr.title}** — ${adr.status}${dateStr}${related}`
}

const renderSliceLine = (slice: SliceSummary): string => {
  const adrTags =
    slice.adrReferences.length > 0
      ? ` [${slice.adrReferences.map((n) => `ADR-${n}`).join(", ")}]`
      : ""
  const head = `### \`@/${slice.slicePath.replace(/^src\//, "")}\`${adrTags}`
  const purpose = `> ${slice.purpose}`
  const exportsBlock =
    slice.publicExports.length > 0
      ? `- Public surface: \`${slice.publicExports.join("`, `")}\``
      : "- Public surface: _(none parsed)_"
  const testsBlock = slice.testFile
    ? `- Hellgate: \`${slice.testFile.replace(/^.*\/tests\//, "tests/")}\``
    : "- Hellgate: _(none)_"
  return [head, "", purpose, "", exportsBlock, testsBlock, ""].join("\n")
}

/**
 * Group ADRs by date (ISO yyyy-mm-dd) for the timeline section.
 * Skip ADRs with no date.
 */
const groupAdrsByDate = (
  adrs: ReadonlyArray<AdrSummary>,
): ReadonlyArray<{ readonly date: string; readonly adrs: ReadonlyArray<AdrSummary> }> => {
  const byDate = new Map<string, AdrSummary[]>()
  for (const a of adrs) {
    if (!a.date) continue
    const bucket = byDate.get(a.date) ?? []
    bucket.push(a)
    byDate.set(a.date, bucket)
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // most-recent first
    .map(([date, bucket]) => ({
      date,
      adrs: [...bucket].sort((a, b) => a.number.localeCompare(b.number)),
    }))
}

const DEPENDENCY_GRAPH_BLOCK = [
  "```",
  "domain   (llm · tool · permission · storage · runtime · patch · rules · shared)",
  "   ↓",
  "application   (agent · runner · scheduler · subagent · reactor)",
  "   ↓",
  "infrastructure   (apps · adapters · connectors · plugin-isolation · migration)",
  "",
  "observability ─┐",
  "security      ─┤  cross-cut (importable from any plane via injected ports)",
  "ipc · ui · session · skill · memory · mcp · lsp · retrieval · git · auth · stream · scheduler",
  "```",
].join("\n")

const renderSlicesSection = (slices: ReadonlyArray<SliceSummary>): ReadonlyArray<string> => {
  const out: string[] = [`## Slices (${slices.length} total)`, ""]
  if (slices.length === 0) {
    out.push("_(no slices discovered — `src/<slice>/index.ts` barrel missing)_", "")
    return out
  }
  for (const s of slices) out.push(renderSliceLine(s))
  return out
}

const renderAdrCatalogue = (
  adrs: ReadonlyArray<AdrSummary>,
  distinct: number,
): ReadonlyArray<string> => {
  const grouped = groupAdrsByPlane(adrs)
  const out: string[] = [
    `## ADR catalogue by plane (${adrs.length} entries, ${distinct} distinct numbers)`,
    "",
  ]
  for (const plane of PLANE_ORDER) {
    const bucket = grouped.get(plane) ?? []
    if (bucket.length === 0) continue
    const sorted = [...bucket].sort((a, b) => {
      if (a.number !== b.number) return a.number.localeCompare(b.number)
      return a.filename.localeCompare(b.filename)
    })
    out.push(`### ${PLANE_HEADINGS[plane]} (${sorted.length})`, "")
    for (const adr of sorted) out.push(renderAdrLine(adr))
    out.push("")
  }
  return out
}

const renderTimelineSection = (adrs: ReadonlyArray<AdrSummary>): ReadonlyArray<string> => {
  const timeline = groupAdrsByDate(adrs)
  const out: string[] = ["## ADR Timeline", ""]
  if (timeline.length === 0) {
    out.push("_(no dated ADRs)_", "")
    return out
  }
  for (const day of timeline) {
    out.push(`### ${day.date}`, "")
    for (const adr of day.adrs) {
      out.push(`- ${adrLink(adr)} ${adr.title} _(${adr.status})_`)
    }
    out.push("")
  }
  return out
}

const renderFooterSection = (
  adrs: ReadonlyArray<AdrSummary>,
  slices: ReadonlyArray<SliceSummary>,
  distinct: number,
  opts: RenderOpts,
): ReadonlyArray<string> => {
  const out: string[] = [
    "## Catalog parity",
    "",
    `- Total ADR files: ${adrs.length}`,
    `- Distinct ADR numbers: ${distinct}`,
    `- ADR collisions: ${adrs.length - distinct}`,
    `- Total slices: ${slices.length}`,
  ]
  if (opts.hellgateCount !== undefined) {
    out.push(`- Hellgate test files referenced: ${opts.hellgateCount}`)
  }
  out.push("", `> Footer auto-emitted ${opts.today}. Re-run \`bun tools/arch-gen/main.ts\` to regenerate.`, "")
  return out
}

export const render = (
  adrs: ReadonlyArray<AdrSummary>,
  slices: ReadonlyArray<SliceSummary>,
  opts: RenderOpts,
): string => {
  const distinct = opts.distinctAdrCount ?? new Set(adrs.map((a) => a.number)).size
  const lines: string[] = [
    "# Quanta — Architecture (Generated)",
    "",
    `> Auto-generated from \`tools/arch-gen\` on **${opts.today}** by walking \`docs/decisions/\` + \`src/**\`. Edit the source — re-run \`bun tools/arch-gen/main.ts\` to refresh. The hand-curated companion lives at \`docs/ARCHITECTURE.md\`.`,
    "",
  ]
  lines.push(...renderSlicesSection(slices))
  lines.push(...renderAdrCatalogue(adrs, distinct))
  lines.push(...renderTimelineSection(adrs))
  lines.push("## Dependency Graph (plane summary)", "", DEPENDENCY_GRAPH_BLOCK, "")
  lines.push(...renderFooterSection(adrs, slices, distinct, opts))
  return lines.join("\n")
}
