/**
 * Port for the Windsurf-style `{{ variable }}` template-literal expander
 * (ADR-0252). The interface is the smallest stable shape any future
 * library-backed expander (nunjucks / handlebars / mustache) can satisfy
 * without consumers changing call sites.
 *
 * The default in-tree implementation is in `./default-expander.ts`.
 */

import type { ExpandContext, ExpandResult } from "./types"

/**
 * A pure string-to-string expander with a typed error result. Implementations
 * MUST NOT throw on author error — return `ok: false` with an `ExpandError`
 * the host can render with position information.
 *
 * Coercion contract (Windsurf parity):
 *
 *   - `string`        → emitted verbatim
 *   - `number`        → `String(n)` (so `0` is `"0"`, not `""`)
 *   - `boolean`       → `"true"` / `"false"`
 *   - `null`          → `"null"` (treated as a value, not as missing)
 *   - nested object   → reached only via dotted-path `{{ a.b }}`. A bare
 *                       `{{ a }}` whose binding is an object MUST surface
 *                       `unknown-variable` (silent JSON.stringify is a
 *                       footgun a future ADR can opt into).
 *
 * Recursion contract:
 *
 *   - ONE PASS. The expansion text is NOT re-scanned for further `{{}}`
 *     references. This matches the ADR-0203 macro expander contract and
 *     avoids the recursion graph entirely. Authors who want composition
 *     inline at the call site.
 */
export interface TemplateExpander {
  readonly expand: (template: string, context: ExpandContext) => ExpandResult
}
