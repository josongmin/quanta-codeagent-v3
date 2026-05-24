/**
 * tools/arch-gen/scan-adrs.ts — ADR walker.
 *
 * Walks `docs/decisions/*.md`, regex-parses the header block of each ADR
 * (Korean `**상태**`/`**날짜**`/`**관련**`/`**참조**` AND English
 * `**Status**`/`**Date**`/`**Related**`) and clusters by plane via title
 * keyword heuristic.
 *
 * Pure: only depends on `node:fs/promises` + `node:path`. No `@/*`.
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

export type AdrPlane =
  | "domain"
  | "application"
  | "infrastructure"
  | "observability"
  | "security"

export interface AdrSummary {
  readonly number: string
  readonly title: string
  readonly date: string
  readonly status: string
  readonly related: ReadonlyArray<string>
  readonly slicePaths: ReadonlyArray<string>
  readonly plane?: AdrPlane
  readonly filename: string
}

export interface ScanAdrsResult {
  readonly adrs: ReadonlyArray<AdrSummary>
  readonly skipped: ReadonlyArray<{ readonly filename: string; readonly reason: string }>
}

const TITLE_RE = /^#\s+ADR-(\d{3,4})\s*:\s*(.+?)\s*$/m
// Allow either bullet (`- **Status**`) OR plain (`**Status**`) opening.
const STATUS_RE = /^(?:-\s*)?\*\*(?:Status|상태|status)\*\*\s*:\s*(.+?)\s*$/im
const DATE_RE = /^(?:-\s*)?\*\*(?:Date|날짜|date)\*\*\s*:\s*(.+?)\s*$/im
const RELATED_RE = /^(?:-\s*)?\*\*(?:Related|관련|related)\*\*\s*:\s*(.+?)\s*$/im
const REFERENCE_RE = /^(?:-\s*)?\*\*(?:참조|References?|references?)\*\*\s*:\s*(.+?)\s*$/im
const PLANE_RE = /^(?:-\s*)?\*\*plane\*\*\s*:\s*(.+?)\s*$/im
const ADR_REF_RE = /ADR-?(\d{3,4})/g
const SLICE_PATH_RE = /`([^`]+)`/g

/** Cluster a title into a plane via keyword heuristic. */
const inferPlane = (title: string, explicit?: string): AdrPlane | undefined => {
  if (explicit) {
    const norm = explicit.toLowerCase().trim()
    if (
      norm === "domain" ||
      norm === "application" ||
      norm === "infrastructure" ||
      norm === "observability" ||
      norm === "security"
    ) {
      return norm
    }
  }
  const t = title.toLowerCase()
  // Order matters: most-specific first.
  if (
    /\b(sandbox|seccomp|landlock|seatbelt|jail|permission|pii|redact|secret|policy|trust|allowlist|deny)\b/.test(
      t,
    )
  ) {
    return "security"
  }
  if (
    /\b(metric|telemetry|otel|trace|span|log|observab|health|dashboard|cost|gauge|counter|coverage|monitor)\b/.test(
      t,
    )
  ) {
    return "observability"
  }
  if (
    /\b(adapter|provider|bedrock|vertex|foundry|sdk|backend|wrap|swap|lib|impl|native|rust|crate|http|sqlite|redis)\b/.test(
      t,
    )
  ) {
    return "infrastructure"
  }
  if (
    /\b(agent|orchestrat|dispatch|loop|reactor|scheduler|plan|hitl|memory|consolidat|subagent|skill|hook|composition)\b/.test(
      t,
    )
  ) {
    return "application"
  }
  if (/\b(port|type|schema|invariant|contract|dsl|isolation|slice|domain|grammar)\b/.test(t)) {
    return "domain"
  }
  return undefined
}

/** Extract slice paths cited in a `**참조**:` / `**References**:` line. */
const extractSlicePaths = (s: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const m of s.matchAll(SLICE_PATH_RE)) {
    const p = m[1]
    if (!p) continue
    // Heuristic: only keep src/* or tests/* references.
    if (p.startsWith("src/") || p.startsWith("tests/")) {
      out.push(p)
    }
  }
  return out
}

/** Extract related ADR numbers from a `**관련**:` line. */
const extractRelated = (s: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const m of s.matchAll(ADR_REF_RE)) {
    const n = m[1]
    if (n) out.push(n.padStart(4, "0"))
  }
  // De-dupe while preserving order.
  return Array.from(new Set(out))
}

/** Parse a single ADR file. Returns `null` if malformed (caller logs skip). */
export const parseAdr = (
  filename: string,
  text: string,
): { ok: true; adr: AdrSummary } | { ok: false; reason: string } => {
  const titleMatch = TITLE_RE.exec(text)
  if (!titleMatch?.[1] || !titleMatch[2]) {
    return { ok: false, reason: "missing `# ADR-NNNN: <title>` header" }
  }
  const number = titleMatch[1].padStart(4, "0")
  const title = titleMatch[2].trim()

  const statusMatch = STATUS_RE.exec(text)
  const dateMatch = DATE_RE.exec(text)
  const relatedMatch = RELATED_RE.exec(text)
  const referenceMatch = REFERENCE_RE.exec(text)
  const planeMatch = PLANE_RE.exec(text)

  const status = statusMatch?.[1]?.trim() ?? "Unknown"
  const date = dateMatch?.[1]?.trim() ?? ""
  const related = relatedMatch?.[1] ? extractRelated(relatedMatch[1]) : []
  const slicePaths = referenceMatch?.[1] ? extractSlicePaths(referenceMatch[1]) : []
  const plane = inferPlane(title, planeMatch?.[1])

  return {
    ok: true,
    adr: { number, title, date, status, related, slicePaths, plane, filename },
  }
}

const DEFAULT_DIR = "docs/decisions"

export const scanAdrs = async (dir: string = DEFAULT_DIR): Promise<ScanAdrsResult> => {
  const abs = path.isAbsolute(dir) ? dir : path.resolve(dir)
  let entries: ReadonlyArray<string>
  try {
    entries = await readdir(abs)
  } catch {
    return { adrs: [], skipped: [] }
  }

  const adrs: AdrSummary[] = []
  const skipped: { filename: string; reason: string }[] = []

  for (const name of entries) {
    if (!name.endsWith(".md")) continue
    if (name === "README.md") continue
    if (!/^\d/.test(name)) continue
    const filePath = path.join(abs, name)
    let text: string
    try {
      text = await readFile(filePath, "utf8")
    } catch (e) {
      skipped.push({ filename: name, reason: `read error: ${(e as Error).message}` })
      continue
    }
    const parsed = parseAdr(name, text)
    if (!parsed.ok) {
      skipped.push({ filename: name, reason: parsed.reason })
      continue
    }
    adrs.push(parsed.adr)
  }

  // Deterministic order: number asc, then filename for collisions.
  const sorted = [...adrs].sort((a, b) => {
    if (a.number !== b.number) return a.number.localeCompare(b.number)
    return a.filename.localeCompare(b.filename)
  })

  return { adrs: sorted, skipped }
}
