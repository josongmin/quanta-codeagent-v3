/**
 * ADR-0131 — Memory frontmatter lint rules.
 *
 * Emits **warnings only** (no throws) so opt-in adoption is friction-free
 * (ADR-0131 §Tradeoffs: "frontmatter linting overhead … mitigation: lint
 * warning, error 아님"). Caller (e.g. memory writer pre-commit hook,
 * future authoring CLI) decides whether to surface them, gate publishing
 * on them, or store them as evidence-of-debt.
 *
 * Rules implemented (all WARNING severity):
 *
 *   W1. `outcome` declared but `outcome_evidence` absent
 *       (ADR-0131 §1: "outcome_evidence: required if outcome present").
 *   W2. `outcome_evidence` declared but doesn't match a recognized anchor
 *       shape (`file:line` | URL | commit SHA).
 *   W3. Body contains a `\d+% (done|complete|finished)` percentage-grace
 *       phrase — the exact inflation pattern the 4-state enum exists to
 *       replace (ADR-0131 §Problem.1).
 *
 * Out of scope (deferred, V2): outcome ↔ body cross-validation, evidence
 * URL liveness, SHA git-cat-file probe. This file is **pure** — no I/O,
 * no clock — so a snapshot-test can pin every rule's behaviour cheaply.
 */

/** A single lint finding. `line` is 1-based; `0` means "frontmatter as a whole"
 *  when the warning concerns metadata. */
export interface LintIssue {
  readonly rule: "outcome-evidence-missing" | "outcome-evidence-shape" | "percentage-grace"
  readonly severity: "warning"
  readonly message: string
  readonly line: number
}

/** Output of {@link lintMemoryFrontmatter}. Always returns `errors: []` —
 *  the field exists for future-extensibility (V2 may promote some rules
 *  to errors with an opt-in `strict: true` mode). Caller MUST NOT short-
 *  circuit on `warnings.length === 0`; presence of warnings is informational
 *  only, never blocking. */
export interface LintReport {
  readonly warnings: readonly LintIssue[]
  readonly errors: readonly LintIssue[]
}

// ─── Frontmatter parsing primitives (lightweight, no YAML lib) ──────────
//
// We use a YAML LIBRARY-FREE parse because this file ships into the
// `src/memory/consolidate/` slice which is restricted from importing
// authoring tooling (RFC §3.1 slice isolation). The grammar we support is
// the minimal `key: value` and 2-space-indented `subkey: value` Codex/our
// memory frontmatter convention — no flow style, no anchors, no folded
// scalars. A richer YAML body simply yields no metadata matches and the
// lint passes (W3 still scans the body).

const FRONTMATTER_FENCE = /^---\s*\n/

/** Extract the frontmatter region (lines between leading `---` fences) and
 *  the body (everything after the closing fence). When no frontmatter is
 *  present, the whole input is treated as body (frontmatter is `null`).
 *  Both regions are returned along with the 1-based line offset where
 *  the body starts, so W3 lint messages can cite accurate line numbers. */
const splitFrontmatter = (
  content: string,
): { frontmatter: string | null; body: string; bodyStartLine: number } => {
  if (!FRONTMATTER_FENCE.test(content)) {
    return { frontmatter: null, body: content, bodyStartLine: 1 }
  }
  // Find the closing fence — second `---` on its own line. We deliberately
  // don't use a single greedy regex because a body containing `---` should
  // not be misinterpreted; the closing fence must be the FIRST `---` after
  // the opening one (Codex / Pandoc convention).
  const afterOpen = content.replace(FRONTMATTER_FENCE, "")
  const closeIdx = afterOpen.search(/\n---\s*(?:\n|$)/)
  if (closeIdx === -1) {
    // Malformed — opening fence with no closing. Treat as no frontmatter
    // (lint is forgiving; a future schema validator can reject this).
    return { frontmatter: null, body: content, bodyStartLine: 1 }
  }
  const frontmatter = afterOpen.slice(0, closeIdx)
  const closingLineLen = afterOpen.slice(closeIdx).match(/^\n---\s*\n?/)?.[0].length ?? 0
  const body = afterOpen.slice(closeIdx + closingLineLen)
  // bodyStartLine = 1 (opening ---) + frontmatter line count + 1 (closing ---) + 1
  const fmLines = frontmatter.split("\n").length
  const bodyStartLine = 1 + fmLines + 1 + 1
  return { frontmatter, body, bodyStartLine }
}

/** Normalize a raw YAML scalar capture: trim, strip outer quotes, drop
 *  inline `# comment` tails. Returns the cleaned string (may be empty,
 *  meaning "present but blank" — caller decides). */
const normalizeScalarValue = (raw: string): string => {
  let v = raw.trim()
  // Strip a single layer of surrounding quotes (matching pair only).
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  // Drop inline `# comment` tails.
  const hashIdx = v.indexOf("#")
  if (hashIdx >= 0) v = v.slice(0, hashIdx).trim()
  return v
}

/** Extract a single top-level or nested `metadata.<key>` value from the
 *  frontmatter region. Returns the trimmed value as a string, or `null`
 *  if the key is absent. Strips surrounding quotes. */
const readMetaKey = (frontmatter: string, key: string): string | null => {
  // Two patterns: `outcome: success` at top level, or `  outcome: success`
  // nested under `metadata:`. We accept either form (ADR is permissive).
  const lines = frontmatter.split("\n")
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "i")
  for (const line of lines) {
    const m = re.exec(line)
    if (m === null || typeof m[1] !== "string") continue
    const v = normalizeScalarValue(m[1])
    if (v.length > 0) return v
  }
  return null
}

// ─── Anchor shape recognizers ───────────────────────────────────────────
//
// Each predicate is a single regex over the entire trimmed value. Order:
//
//   file:line  — `path/to/file.ts:42` (line range `:42-50` also accepted)
//   URL        — `http://` or `https://` (any scheme would pass; we restrict
//                to http/https to avoid `outcome_evidence: ftp://...` slipping)
//   commit SHA — 7-40 hex chars, isolated
//
// Anything else falls through to W2.

const ANCHOR_FILE_LINE = /^[^\s:]+\.[A-Za-z0-9]+:\d+(?:-\d+)?$/
const ANCHOR_URL = /^https?:\/\/\S+$/
const ANCHOR_SHA = /^[0-9a-f]{7,40}$/i

const isValidEvidenceAnchor = (s: string): boolean =>
  ANCHOR_FILE_LINE.test(s) || ANCHOR_URL.test(s) || ANCHOR_SHA.test(s)

// W3 pattern — `<digits>% (done|complete|finished)`. Case-insensitive,
// global to surface every occurrence with its own line number. We match
// against the body (not frontmatter) because frontmatter is the structured
// channel that the outcome enum supersedes.
const PERCENTAGE_GRACE_RE = /(\d+)\s*%\s+(done|complete|finished|completed)\b/gi

/** Scan the frontmatter block for W1 (outcome-evidence-missing) and W2
 *  (outcome-evidence-shape). Returns 0..2 issues. Pure. */
const lintFrontmatter = (frontmatter: string): LintIssue[] => {
  const issues: LintIssue[] = []
  const outcome = readMetaKey(frontmatter, "outcome")
  const evidence = readMetaKey(frontmatter, "outcome_evidence")
  if (outcome !== null && evidence === null) {
    issues.push({
      rule: "outcome-evidence-missing",
      severity: "warning",
      message: `outcome '${outcome}' declared but outcome_evidence is missing (ADR-0131 §1)`,
      line: 0,
    })
  }
  if (evidence !== null && !isValidEvidenceAnchor(evidence)) {
    issues.push({
      rule: "outcome-evidence-shape",
      severity: "warning",
      message: `outcome_evidence '${evidence}' is not a file:line, URL, or commit SHA (ADR-0131 §1)`,
      line: 0,
    })
  }
  return issues
}

/** Scan the body for W3 (percentage-grace anti-pattern). Each line's matches
 *  are surfaced individually so authors can spot every occurrence. */
const lintBodyPercentageGrace = (body: string, bodyStartLine: number): LintIssue[] => {
  const issues: LintIssue[] = []
  if (body.length === 0) return issues
  const bodyLines = body.split("\n")
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    if (line === undefined) continue
    // Reset the global regex's lastIndex each line — reusing a `g` flag
    // across iterations would skip matches non-deterministically.
    PERCENTAGE_GRACE_RE.lastIndex = 0
    let m: RegExpExecArray | null = PERCENTAGE_GRACE_RE.exec(line)
    while (m !== null) {
      issues.push({
        rule: "percentage-grace",
        severity: "warning",
        message: `percentage-grace phrase '${m[0]}' detected — use outcome enum instead (ADR-0131 §Problem.1)`,
        line: bodyStartLine + i,
      })
      m = PERCENTAGE_GRACE_RE.exec(line)
    }
  }
  return issues
}

/**
 * Lint a memory file's text content.
 *
 * Always returns a {@link LintReport}; **never throws** (a malformed input
 * produces an empty report, by design — lint is advisory).
 *
 * Backward-compat: a memory file with no `outcome` frontmatter field gets
 * zero W1/W2 warnings. W3 fires regardless of frontmatter presence.
 */
export const lintMemoryFrontmatter = (content: string): LintReport => {
  if (typeof content !== "string" || content.length === 0) {
    return { warnings: [], errors: [] }
  }
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(content)
  const warnings: LintIssue[] = [
    ...(frontmatter !== null ? lintFrontmatter(frontmatter) : []),
    ...lintBodyPercentageGrace(body, bodyStartLine),
  ]
  return { warnings, errors: [] }
}
