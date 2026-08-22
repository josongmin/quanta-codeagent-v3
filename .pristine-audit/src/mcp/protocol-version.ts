/** MCP protocol-version SSOT + negotiation helpers (ticket misc-jun-7/01).
 *
 *  ONE newest-first ordered list of the MCP protocol revisions this client
 *  speaks. Before this module the version was a literal `"2025-06-18"` string
 *  triplicated across `client.ts`, `isolated-client.ts`, and
 *  `transports/http-sse.ts`, each one a fixed offer that was never validated
 *  against the server's reply. This module is the single source consumed by all
 *  three; the §7 ratchet test forbids any of them re-introducing an independent
 *  version literal.
 *
 *  Negotiation semantics (mirrors Cursor `cursor-mcp/dist/main.js:9322` +
 *  Claude Code IDE spec §6.2.1):
 *   - The client OFFERS the newest version it supports ({@link LATEST_PROTOCOL_VERSION})
 *     on the `initialize` request, unless an operator pins a lower ceiling via
 *     `QUANTA_MCP_PROTOCOL_MAX`.
 *   - A spec-compliant server that does not support the offer replies with the
 *     highest version IT supports; the client ACCEPTS that reply iff it is a
 *     member of {@link SUPPORTED_PROTOCOL_VERSIONS} (then pins it for the
 *     session — this is what the HTTP `mcp-protocol-version` header carries).
 *   - A server reply carrying a version NOT in the set fails closed (the
 *     client never proceeds on a version it does not implement — Codex's
 *     `UNSUPPORTED_PROTOCOL` parity).
 *
 *  Pure: no IO, no env reads. The `QUANTA_MCP_PROTOCOL_MAX` knob is read by the
 *  client/transport via `runtimeConfig()`, then resolved through
 *  {@link resolveOfferedVersion} here. */

/** Newest-first. Index 0 is the offered default; the rest are downgrade-
 *  acceptable. Verbatim parity with Cursor's set + Claude Code IDE spec §6.2.1. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const

/** A protocol version string known to this client. */
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]

/** The newest version this client speaks — the default offered value. */
export const LATEST_PROTOCOL_VERSION: SupportedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0]

/** The conservative downgrade floor — the version quanta pinned BEFORE this
 *  ticket. The §4.c single bounded re-offer falls back to exactly this, so a
 *  strict-old server's worst case is one extra round-trip then byte-identical
 *  behavior. Held as a named constant (not a magic index) so the floor is an
 *  explicit, auditable choice. */
export const PROTOCOL_DOWNGRADE_FLOOR: SupportedProtocolVersion = "2025-06-18"

/** Type guard: is `v` a version this client implements? Accepts only a string
 *  that is an exact member of the SSOT — a non-string, or a string outside the
 *  set, is rejected (fail-closed). */
export const isSupportedProtocolVersion = (v: unknown): v is SupportedProtocolVersion =>
  typeof v === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v)

/** Resolve the version to OFFER on `initialize`, given the operator override
 *  (`QUANTA_MCP_PROTOCOL_MAX`, carried by `runtimeConfig().mcpProtocolMax`).
 *
 *  - `override` absent ⇒ offer {@link LATEST_PROTOCOL_VERSION} (competitor parity).
 *  - `override` a SUPPORTED version ⇒ offer it (pins the ceiling, e.g. back to
 *    `2025-06-18` for byte-identical-to-pre-ticket behavior against a server
 *    known to choke on the bump).
 *  - `override` present but UNSUPPORTED (typo, unknown version) ⇒ CONSERVATIVE
 *    fallback to {@link LATEST_PROTOCOL_VERSION}, never to an arbitrary string we
 *    don't implement. We never put a version we cannot speak on the wire. */
export const resolveOfferedVersion = (override: string | undefined): SupportedProtocolVersion =>
  override !== undefined && isSupportedProtocolVersion(override)
    ? override
    : LATEST_PROTOCOL_VERSION
