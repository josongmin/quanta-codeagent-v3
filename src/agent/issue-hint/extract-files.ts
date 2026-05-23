/**
 * File-path extraction from issue text.
 *
 * Conservative posture (no heuristics): we only accept a path when its shape
 * is unambiguously a path — at least one slash AND a recognized extension. The
 * "models.py alone" case is intentionally rejected here because it's too
 * ambiguous (could be any module name on any project); traceback parsing in
 * `extract-code.ts` picks those up via its own stricter context.
 *
 * Two-pass design:
 *   1. **Primary** regex catches plain paths like `requests/models.py` or
 *      `src/_pytest/pathlib.py:42` — anchored at a non-path boundary so we
 *      don't accidentally consume the URL prefix of a markdown link.
 *   2. **URL** regex picks up paths embedded inside GitHub-style permalinks
 *      `…/blob/<sha>/<path>…#L<line>` (very common in issue bodies). Anchored
 *      with a leading slash so plain `src/agent/foo.ts` text is NOT
 *      mis-classified as a URL fragment.
 *
 * Defensive normalization:
 *   - ANSI escape codes (`\x1b[…m`) are stripped before scanning so terminal
 *     output dumps in issue bodies don't break the lookbehind.
 *
 * Hardening:
 *   - prototype-pollution keys (`__proto__`, `constructor`, `prototype`) never
 *     appear in extracted paths
 *   - per-path length cap (200 chars)
 *   - line:col suffixes stripped (`a/b.py:42` → `a/b.py`)
 *   - longest-extension-first alternation order to avoid `.json`→`.js` clipping
 *   - everything sorted-unique for byte-stable test output
 */
import { stripAnsi } from "./normalize"

/** Extension alternation — longer alternatives placed FIRST so `.json` is not
 *  partially captured as `.js`. Order matters in JS regex alternation. */
const EXT_ALT = "yaml|yml|toml|json|tsx|ts|jsx|js|hpp|cpp|java|sql|rs|rb|sh|py|go|md|c|h"

/** Primary path: starts at a non-path boundary, contains ≥1 slash, ends at a
 *  recognized extension. */
const PATH_RE = new RegExp(
  `(?<=^|[^\\w/.+-])([A-Za-z_][\\w.+-]*(?:\\/[\\w.+-]+)+\\.(?:${EXT_ALT}))(?::\\d+(?::\\d+)?)?\\b`,
  "g",
)

/** GitHub-style permalink: `…/blob/<sha>/<path>` (also `tree`, `src`, `raw`).
 *  Leading slash REQUIRED — plain prose like `touch src/agent/x.ts` is left
 *  to the primary regex. SHA slot accepts `.` so writers using ellipsis
 *  placeholders (`/blob/.../path/x.py`) still match. */
const URL_PATH_RE = new RegExp(
  `\\/(?:blob|tree|src|raw)\\/[A-Za-z0-9.]+\\/([\\w.+\\-/]+\\.(?:${EXT_ALT}))(?:#L?\\d+(?::\\d+)?)?\\b`,
  "g",
)

/** Reserved JS/Object prototype keys — never emit a path that starts with one. */
const RESERVED = new Set(["__proto__", "constructor", "prototype"])

const MAX_LEN = 200

const acceptPath = (raw: string | undefined, found: Set<string>): void => {
  if (typeof raw !== "string") return
  if (raw.length === 0 || raw.length > MAX_LEN) return
  const head = raw.split("/")[0] ?? ""
  if (RESERVED.has(head)) return
  found.add(raw)
}

export const extractFiles = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  PATH_RE.lastIndex = 0
  for (const m of cleaned.matchAll(PATH_RE)) acceptPath(m[1], found)
  URL_PATH_RE.lastIndex = 0
  for (const m of cleaned.matchAll(URL_PATH_RE)) acceptPath(m[1], found)
  return Array.from(found).sort()
}
