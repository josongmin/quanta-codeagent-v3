/**
 * ADR-0205 — Canonical one-line serializer.
 *
 * Wire format: `::git-<kind>{<canonical-json>}`.
 *
 * - `<kind>` is the discriminant value (kebab-case).
 * - `<canonical-json>` is a JSON object containing every field of the
 *   directive EXCEPT `kind`, with keys sorted alphabetically. Stable key
 *   ordering keeps snapshot tests, UI regex, and parser round-trips
 *   byte-identical across V8 versions.
 *
 * String escape is delegated to `JSON.stringify` so quotes, backslashes,
 * newlines, and control characters survive transport without breaking
 * line framing.
 */

import type { GitDirective } from "./types"

/** Serialize a directive into a single newline-free line. */
export const serialize = (d: GitDirective): string => {
  const payload = canonicalPayload(d)
  const body = canonicalStringify(payload)
  return `::git-${d.kind}${body}`
}

/** Project the directive into a plain object keyed by everything except `kind`. */
const canonicalPayload = (d: GitDirective): Record<string, unknown> => {
  switch (d.kind) {
    case "create-branch":
      return { name: d.name }
    case "stage":
      // Copy into a fresh array so the caller's `readonly` does not surface
      // a frozen reference into JSON.stringify (which is fine, but we want
      // the payload to be a vanilla object for downstream simplicity).
      return { paths: [...d.paths] }
    case "commit":
      return { message: d.message, sha: d.sha }
    case "push":
      return { branch: d.branch, remote: d.remote }
    case "create-pr":
      return { isDraft: d.isDraft, url: d.url }
  }
}

/**
 * `JSON.stringify` with a deterministic, alpha-sorted key order at every
 * object level. Arrays preserve order. Primitives + null pass through.
 *
 * Implementation notes:
 *   - We do not use the `replacer` arg because it cannot reorder keys
 *     (V8 walks the input object's own-key list directly).
 *   - The recursive walker handles only the value shapes the directive
 *     payloads produce (object / array / string / number / boolean / null).
 *     A directive payload that smuggles a `Date` or `Map` would be a
 *     programmer bug; we let `JSON.stringify` of the resulting object
 *     handle it the same way it would for unknown types.
 */
const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k]
    return `${JSON.stringify(k)}:${canonicalStringify(v)}`
  })
  return `{${parts.join(",")}}`
}
