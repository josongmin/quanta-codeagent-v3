/**
 * PR / issue ref normalization — shared across all gh tools.
 *
 * SECURITY: a PR/issue identifier is a bare POSITIONAL argument to `gh`
 * (`gh pr view <id>`). A `-`-leading value (`--web`, `-R/owner/evil`,
 * `--repo=…`) would be parsed by `gh` as a FLAG rather than a number/URL
 * — arg-injection. `gh` accepts a numeric issue/PR number OR a full
 * `https://…` URL; both are validated here. A malformed identifier is
 * rejected before it reaches argv, surfaced as a deterministic `ok:false`
 * (never thrown to the loop).
 *
 * Accepted: a positive integer (`42`, `#42`) or an `http(s)://…` URL.
 * Anything beginning with `-`, or any other shape, is rejected.
 */

export const normalizeRef = (raw: string | number): string | undefined => {
  const s = String(raw).trim()
  if (s.length === 0) return undefined
  // Plain number, optionally with a leading `#` (a common human shorthand).
  const num = s.startsWith("#") ? s.slice(1) : s
  if (/^[0-9]+$/.test(num)) return num
  // Full URL form — must be http(s) so it can never be a `-`-leading flag.
  if (/^https?:\/\//i.test(s)) return s
  return undefined
}

/** Deterministic rejection envelope returned by every gh tool when the
 *  ref is malformed (raised + caught at the tool's `execute` boundary). */
export const refRejected = (kind: "PR" | "issue", raw: string | number): string =>
  `invalid ${kind} identifier '${String(raw)}': expected a positive number or an ` +
  "http(s) URL (a leading-dash value would be parsed as a gh flag)"
