/**
 * ADR-0221 — Canonical one-line serializer.
 *
 * Wire format: `::git-<kind><canonical-json>`. Keys at every object level
 * are alpha-sorted so snapshot tests, UI regex, and parser round-trip stay
 * byte-identical across V8 versions. String escape is delegated to
 * `JSON.stringify` (handles `"`, `\`, `\n`, control chars), so a commit
 * message with embedded newlines still produces ONE framing-safe line.
 */

import type { GitDirective } from "./types"

/** Serialize a directive into a single newline-free line. */
export const serialize = (d: GitDirective): string => {
  const payload = canonicalPayload(d)
  const body = canonicalStringify(payload)
  return `::git-${d.kind}${body}`
}

/** Project the directive into a plain object keyed by every field except `kind`. */
const canonicalPayload = (d: GitDirective): Record<string, unknown> => {
  switch (d.kind) {
    case "create-branch":
      return { name: d.name }
    case "stage":
      return { files: [...d.files] }
    case "commit":
      return { message: d.message, sha: d.sha }
    case "push":
      return { force: d.force, ref: d.ref }
    case "create-pr":
      return { isDraft: d.isDraft, url: d.url }
  }
}

/**
 * `JSON.stringify` with deterministic alpha-sorted keys at every object
 * level. Arrays preserve order. Primitives + null pass through.
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
