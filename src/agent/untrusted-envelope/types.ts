/**
 * untrusted-source-envelope — provenance types (ADR-0471).
 *
 * WHAT: closed enum of tool-result provenance classes + the gate/wrap config
 *       shape. Pure types, no runtime logic.
 * ADR: 0471 (untrusted-source-envelope)
 * SLICES IMPORTED: none (leaf — type-only; the runtime module imports @/shared).
 * NO-THROW: types only; no executable surface.
 *
 * Provenance is a DIFFERENT axis from `SensitivityClass`
 * (`@/security/sensitivity-classifier`, public|internal|secret). That axis asks
 * "does this OUTPUT contain a secret we must redact?". THIS axis asks "did this
 * output ORIGINATE from a party the model should treat as untrusted DATA rather
 * than as instructions?". A `web_fetch` result is `public` on the sensitivity
 * axis yet `web_fetch` (untrusted) on the provenance axis. The two are
 * orthogonal and composed in sequence at the dispatch seam (redact first, then
 * wrap the redacted text).
 */

/**
 * Closed provenance enum. Every tool result maps to exactly one member.
 *
 *  - `mcp`        — output from a Model-Context-Protocol server tool. The server
 *                   is third-party code; its text is adversary-controllable.
 *  - `web_fetch`  — fetched web page / search-result body. Fully attacker-
 *                   controllable (a hostile page can embed injection text).
 *  - `file`       — file contents read from disk whose provenance is NOT the
 *                   agent's own prior write (e.g. a checked-out dependency, a
 *                   downloaded artifact). Reserved for integrations that can
 *                   distinguish foreign files from agent-authored ones.
 *  - `plugin`     — output produced by a loaded plugin/extension tool.
 *  - `bash`       — output of a shell command. A command can `cat` a hostile
 *                   file or `curl` a hostile URL, so its stdout is untrusted.
 *  - `internal`   — the agent's OWN trusted output: `read`/`edit`/`write`
 *                   round-trips of agent-authored content, harness-generated
 *                   summaries, etc. NEVER wrapped — wrapping these would change
 *                   bytes the model already trusts and add noise.
 */
export type UntrustedSource = "mcp" | "web_fetch" | "file" | "plugin" | "bash" | "internal"

/** The closed set, frozen, for membership checks and exhaustiveness tests. */
export const UNTRUSTED_SOURCES: readonly UntrustedSource[] = Object.freeze([
  "mcp",
  "web_fetch",
  "file",
  "plugin",
  "bash",
  "internal",
] as const)

/** Sources whose results are TRUSTED and therefore never wrapped. The OFF-by-
 *  default contract plus this set together guarantee `internal` output is
 *  byte-identical regardless of the gate. Kept as a set so adding a future
 *  trusted source is a one-line change with a single source of truth. */
export const TRUSTED_SOURCES: ReadonlySet<UntrustedSource> = new Set<UntrustedSource>(["internal"])

/** True ⇒ `source` denotes an untrusted party and (gate permitting) its result
 *  is wrapped in a `<untrusted-source>` envelope. */
export const isUntrusted = (source: UntrustedSource): boolean => !TRUSTED_SOURCES.has(source)
