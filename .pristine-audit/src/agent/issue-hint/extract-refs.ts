/**
 * PR / issue reference extraction.
 *
 * Two patterns:
 *   - `#1234`        — GitHub / GitLab / Gitea convention; digits REQUIRED
 *                      (so `#abc` does not match). 1..7 digits (covers GitHub's
 *                      largest known IDs as of 2026).
 *   - `PROJ-456`     — JIRA / Linear style; 1..10 uppercase letters + `-` +
 *                      1..7 digits. Single-letter prefixes accepted (`A-1`).
 *
 * Why a closed pattern: refs are a high-signal localization cue ("PR #774
 * fixed something here") but a permissive regex would catch `#FF0000` (CSS
 * color) and `M-1` (org charts). Both forms are anchored at word boundaries
 * and length-bounded to keep precision high.
 *
 * Hardening:
 *   - ANSI strip (paste safety)
 *   - dedup + sort for byte-stable output
 *   - per-ref length cap implicit in the regex (7 + 1 + 7 = 15 max for JIRA)
 */
import { stripAnsi } from "./normalize"

/** `#N`  — N is 1..7 digits.  Lookbehind requires a non-word char (or BOS).
 *  This is critical: `0#1` would otherwise match, as would `arg=value#5`. */
const HASH_REF_RE = /(?<![A-Za-z0-9_])(#\d{1,7})\b/g

/** `PROJ-N` — 1..10 uppercase letters, dash, 1..7 digits. Word-boundary
 *  anchored on both ends so `prefixPROJ-1` doesn't match. */
const JIRA_REF_RE = /\b([A-Z]{1,10}-\d{1,7})\b/g

export const extractRefs = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  HASH_REF_RE.lastIndex = 0
  for (const m of cleaned.matchAll(HASH_REF_RE)) {
    const raw = m[1]
    if (typeof raw === "string" && raw.length > 0) found.add(raw)
  }
  JIRA_REF_RE.lastIndex = 0
  for (const m of cleaned.matchAll(JIRA_REF_RE)) {
    const raw = m[1]
    if (typeof raw === "string" && raw.length > 0) found.add(raw)
  }
  return Array.from(found).sort()
}
