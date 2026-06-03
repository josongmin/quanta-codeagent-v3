/**
 * untrusted-source-envelope — pure wrap + defang (ADR-0471).
 *
 * WHAT: `wrapToolResult(text, source, opts?)` returns the result text enclosed
 *       in a `<untrusted-source name="...">…</untrusted-source>` envelope so the
 *       model reads external output as DATA, never instructions. Hostile content
 *       that tries to FORGE or CLOSE the envelope early is defanged first.
 * ADR: 0471 (untrusted-source-envelope)
 * SLICES IMPORTED: @/agent/untrusted-envelope/types (sibling, intra-slice);
 *                  @/shared (escapeBoundary — the canonical untrusted-boundary
 *                  defanger, reused not reinvented).
 * NO-THROW: every function is total over `string` input; never throws. When the
 *           gate is off OR the source is trusted, `wrapToolResult` is the
 *           IDENTITY on `text` (byte-identical to today).
 */

import { escapeBoundary } from "@/shared/untrusted"
import { isUntrusted, type UntrustedSource } from "./types"

/** The envelope tag name. Single source of truth for the open/close strings,
 *  the defang scanner, and the system-prompt RULE — so they can never drift. */
export const ENVELOPE_TAG = "untrusted-source"

/** Build the literal closing tag string once. */
const CLOSE_TAG = `</${ENVELOPE_TAG}>`

/**
 * Defang any genuine envelope boundary tokens (`<untrusted-source>` /
 * `</untrusted-source>`, case-insensitive, casing preserved) embedded in
 * untrusted content so a hostile page cannot terminate the real envelope early
 * nor forge a nested one.
 *
 * This DELEGATES to the codebase's canonical {@link escapeBoundary}
 * (`@/shared/untrusted`) — the SINGLE enforced path all untrusted fragments
 * funnel through (also used by the per-turn prompt assembler and the browser
 * tool's page-text guard). Reusing it rather than hand-rolling a parallel
 * scanner means: (1) the defang is byte-identical to the two legacy boundary
 * escapers it already replaced, (2) the BENIGN INVARIANT holds — content that
 * does NOT contain a genuine `<untrusted-source>`/`</untrusted-source>` token
 * is returned byte-identical (no escape introduced where none is needed),
 * (3) the always-defanged `system-reminder` boundary is also escaped, since the
 * wrapped result ultimately rides inside the harness reminder wrapper
 * downstream, and (4) the defang is idempotent and regex-metachar-safe.
 *
 * The defanged form inserts a single backslash after the leading `<`
 * (`</untrusted-source>` → `<\/untrusted-source>`), which the model's
 * pattern-matcher does not read as a genuine boundary yet stays human-readable.
 *
 * UNIQUE TO THIS ENVELOPE: unlike `system-reminder`/`ide-context` (always
 * emitted attribute-less), our GENUINE opener carries a `name="..."` attribute
 * (`<untrusted-source name="web_fetch">`). `escapeBoundary` defangs only the
 * bare `<tag>`/`</tag>` token, so a forged ATTRIBUTED opener
 * (`<untrusted-source name="internal">`) inside hostile content would survive
 * and could spoof a nested/trusted-looking envelope. We therefore layer a
 * second, targeted pass that defangs any `<untrusted-source` followed by an
 * attribute (whitespace then a non-`>` char) the same way (`<\untrusted-source`).
 * The bare-token cases are still owned by the canonical helper.
 *
 * Pure + total: returns the (possibly unchanged) string; never throws.
 */
export const defangEnvelopeTags = (text: string): string => {
  const tokenSafe = escapeBoundary(ENVELOPE_TAG, text)
  // Genuine attributed opener only: `<untrusted-source` + at least one space +
  // a non-`>` attribute char (so the canonical bare-`<untrusted-source>` pass,
  // already applied, is not re-touched — its `<\untrusted-source>` form no
  // longer starts with the genuine `<untrusted-source ` spelling). Insert a
  // single backslash after `<`, matching the canonical defang form.
  const attributedOpener = new RegExp(`<(${ENVELOPE_TAG}\\s+[^>])`, "gi")
  return tokenSafe.replace(attributedOpener, "<\\$1")
}

/** Options for {@link wrapToolResult}. `enabled` is the resolved gate verdict
 *  (the caller maps the env var to a boolean — this module stays env-agnostic so
 *  it is trivially unit-testable). Omitted ⇒ treated as `false` (OFF). */
export interface WrapOptions {
  /** Resolved gate. `false`/undefined ⇒ identity (byte-identical to today). */
  enabled?: boolean
}

/**
 * Wrap a tool result in the provenance envelope.
 *
 * Identity (returns `text` unchanged, byte-for-byte) when ANY of:
 *   - `opts.enabled !== true` (gate OFF — the default), or
 *   - the `source` is trusted (`internal`; see {@link TRUSTED_SOURCES}).
 *
 * Otherwise returns:
 *   `<untrusted-source name="<source>">\n<defanged text>\n</untrusted-source>`
 *
 * The body is defanged FIRST so a hostile page cannot smuggle a real
 * `</untrusted-source>` (or a forged opener) to escape the envelope. Empty
 * bodies are still wrapped (the wrapper itself carries the provenance signal);
 * huge bodies are handled in O(n) by the single regex pass with no allocation
 * beyond the result string.
 */
export const wrapToolResult = (
  text: string,
  source: UntrustedSource,
  opts?: WrapOptions,
): string => {
  if (opts?.enabled !== true) return text
  if (!isUntrusted(source)) return text
  const body = defangEnvelopeTags(text)
  return `<${ENVELOPE_TAG} name="${source}">\n${body}\n${CLOSE_TAG}`
}
