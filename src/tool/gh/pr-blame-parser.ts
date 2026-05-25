/**
 * ADR-0103 — `gh_pr_blame` pure parser + renderer (no runner, no I/O).
 *
 * Split from `index.ts` so the parser is callable from unit tests with
 * canned `RawPrViewJson` records (no GhRunner round-trip needed for the
 * structural / proximity / tag-rendering cases). The tool factory in
 * `index.ts` is now responsible ONLY for argv + runner orchestration —
 * the structural logic lives here.
 *
 * Pure functions only — every output is determined by its inputs. No
 * `Date.now()`, no random, no env reads. The renderer is the only
 * stringly-typed surface (the body the LLM sees); everything else is
 * narrowly typed against the shapes in `pr-blame-types.ts`.
 */

import {
  PR_BLAME_PROXIMITY_LINES,
  type RawPrViewJson,
  type ReviewThread,
} from "./pr-blame-types"

/** Normalize the two possible `reviewThreads` shapes (`{nodes:[...]}` vs
 *  bare array) so callers see one flat array. */
export const extractThreads = (raw: RawPrViewJson): readonly ReviewThread[] => {
  const rt = raw.reviewThreads
  if (rt === undefined) return []
  if (Array.isArray(rt)) return rt
  return rt.nodes ?? []
}

/** True when `thread` survives the file + line proximity filter. Both
 *  filters are optional; an undefined filter is a no-op (passes everything).
 *  The line filter uses `line ?? originalLine` so threads that target an
 *  outdated line still match within proximity of the requested anchor. */
export const matchesPrBlameFilter = (
  thread: ReviewThread,
  fileFilter: string | undefined,
  lineFilter: number | undefined,
): boolean => {
  if (fileFilter !== undefined && thread.path !== fileFilter) return false
  if (lineFilter !== undefined) {
    const anchor = thread.line ?? thread.originalLine ?? null
    if (anchor === null) return false
    if (Math.abs(anchor - lineFilter) > PR_BLAME_PROXIMITY_LINES) return false
  }
  return true
}

/** Render one thread block — header (`[idx] path:line (resolved, outdated)`)
 *  followed by indented `@author: body` lines, one per comment. Blank-body
 *  threads collapse to `(no comment body)` so the output never has dangling
 *  headers. */
export const renderPrBlameThread = (thread: ReviewThread, idx: number): string => {
  const path = thread.path ?? "(file unknown)"
  const line = thread.line ?? thread.originalLine ?? "?"
  const tags: string[] = []
  if (thread.isResolved === true) tags.push("resolved")
  if (thread.isOutdated === true) tags.push("outdated")
  const header = `[${idx + 1}] ${path}:${line}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`
  const comments = thread.comments?.nodes ?? []
  if (comments.length === 0) return `${header}\n  (no comment body)`
  const lines = comments.map((c) => {
    const author = c.author?.login ?? "(unknown)"
    const body = (c.body ?? "").trim().split("\n").join("\n  ")
    return `  @${author}: ${body}`
  })
  return `${header}\n${lines.join("\n")}`
}

/** Compose all three pure steps: extract → filter → render. Returns the
 *  body string the tool will emit, OR a short reason string when nothing
 *  matched. Header (`PR: <url-or-ref>`) is concatenated by the tool factory
 *  so this module stays pure (no knowledge of the gh argv ref). */
export const buildBlameBody = (
  raw: RawPrViewJson,
  fileFilter: string | undefined,
  lineFilter: number | undefined,
): { kind: "body"; text: string } | { kind: "empty"; reason: string } => {
  const threads = extractThreads(raw)
  const filtered = threads.filter((t) => matchesPrBlameFilter(t, fileFilter, lineFilter))
  if (filtered.length === 0) {
    const reason =
      fileFilter !== undefined || lineFilter !== undefined
        ? "no review threads match the filter"
        : "no review threads on this PR"
    return { kind: "empty", reason }
  }
  return { kind: "body", text: filtered.map(renderPrBlameThread).join("\n\n") }
}
