/**
 * Thin-client dispatch route — the leaf vocabulary (ADR-0493).
 *
 * Lives in `@/shared` (a true leaf) so the THREE consumers can share ONE type
 * without a layering inversion:
 *   - `@/skill` (Skill descriptor + frontmatter),
 *   - `@/apps/cli` (SlashCommand descriptor),
 *   - `@/agent/thin-client-dispatch` (the gate-aware resolver).
 *
 * The gate-aware `resolveThinClientRoute` lives in `@/agent/thin-client-dispatch`
 * (it needs the surface model); this file is only the closed token set + a
 * NO-THROW parser, both pure and dependency-free.
 */

/** The closed set of routes a thin host may take for a command/skill. */
export type ThinClientRoute = "local" | "post-text" | "control-request"

/** Canonical ordered list — the SSOT for the route vocabulary. */
export const THIN_CLIENT_ROUTES: readonly ThinClientRoute[] = [
  "local",
  "post-text",
  "control-request",
]

/** The opt-in gate name (single SSOT), read via the `@/shared` gate helpers. */
export const THIN_CLIENT_DISPATCH_FLAG = "QUANTA_THIN_CLIENT_DISPATCH"

const ROUTE_SET: ReadonlySet<string> = new Set<string>(THIN_CLIENT_ROUTES)

/**
 * NO-THROW route parser for frontmatter / descriptor ingestion. Returns the
 * route iff `raw` is EXACTLY one of the canonical tokens (route tags are
 * machine-authored — no trim, no casing), else `undefined`.
 */
export const parseThinClientRoute = (raw: string | undefined): ThinClientRoute | undefined =>
  typeof raw === "string" && ROUTE_SET.has(raw) ? (raw as ThinClientRoute) : undefined
