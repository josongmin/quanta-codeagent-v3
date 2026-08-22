/**
 * File-path extraction from issue text.
 *
 * Verbatim-evidence policy (per user spec): the extension whitelist is the
 * sole filter — a bare module name like `models.py` IS accepted (previously
 * we required a slash, but that intentionally drops the most common form in
 * Python issue bodies: "the bug is in models.py").
 *
 * Two-pass design:
 *   1. **Primary** regex catches tokens matching `<name>.<ext>` where the
 *      base name is a valid identifier-ish token (letters / digits / `_` /
 *      `.` / `+` / `-`) and the extension is in the whitelist. Slashes
 *      between path segments accepted (but NOT required). Anchored at a
 *      non-path boundary so we don't accidentally consume the URL prefix of
 *      a markdown link.
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
const EXT_ALT = "yaml|yml|toml|json|tsx|ts|jsx|js|hpp|cpp|java|sql|rs|rb|sh|py|go|md|c|h|php"

/** Primary path: starts at a non-path boundary, optional `<segment>/`
 *  prefixes (zero or more — slash NO LONGER required), ends at a recognized
 *  extension. Base segment must start with an alpha-or-underscore so we don't
 *  accept `.py` from " .py" or numbers-only names. */
const PATH_RE = new RegExp(
  `(?<=^|[^\\w/.+-])((?:[\\w.+-]+\\/)*[A-Za-z_][\\w.+-]*\\.(?:${EXT_ALT}))(?::\\d+(?::\\d+)?)?\\b`,
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
  // Also defend against `__proto__.py` (no slash, still a pollution-shape).
  const base = head.split(".")[0] ?? ""
  if (RESERVED.has(base)) return
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
