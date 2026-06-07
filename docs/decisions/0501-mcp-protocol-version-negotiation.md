# ADR-0501: MCP protocol-version SSOT + newest-first negotiation

- **상태**: Accepted
- **날짜**: 2026-06-07
- **슬라이스**: `@/mcp` (a new shared `protocol-version.ts` SSOT consumed by the existing client / isolated-client / http-sse transport — no new slice)
- **티켓**: `docs/tickets/misc-jun-7/01-mcp-protocol-version.md`
- **게이트**: NOT the usual default-OFF case — see "Default posture / backward-compat". Optional operator pin: `QUANTA_MCP_PROTOCOL_MAX`.
- **관련**:
  - `src/mcp/protocol-version.ts` (new SSOT: `SUPPORTED_PROTOCOL_VERSIONS`, `LATEST_PROTOCOL_VERSION`, `PROTOCOL_DOWNGRADE_FLOOR`, `isSupportedProtocolVersion`, `resolveOfferedVersion`)
  - `src/mcp/client.ts` / `src/mcp/isolated-client.ts` / `src/mcp/transports/http-sse.ts` (the three deleted `const PROTOCOL_VERSION = "2025-06-18"` literals → import the SSOT)
  - Absorbs: Cursor 3.5.33 (`cursor-mcp/dist/main.js:9322` newest-first set), Codex 0.135 (`UNSUPPORTED_PROTOCOL`), Claude Code IDE spec §6.2.1 (negotiated set)

## Context

quanta pinned a **single fixed** MCP protocol version and never negotiated. The literal
`PROTOCOL_VERSION = "2025-06-18"` was **triplicated** with no shared source — one copy each in
`client.ts`, `isolated-client.ts`, and `transports/http-sse.ts` (the third only to stamp the
`mcp-protocol-version` HTTP header). Each copy was a fixed offer that was **never validated against the
server's reply**: `client.start()` read `initResult.capabilities` but discarded
`initResult.protocolVersion`. Whole-tree confirm (jun-07): `SUPPORTED_PROTOCOL` / `downgrade` /
`2025-11-25` grep 0 in `src/mcp/`.

Two concrete gaps followed: (1) against a newer-only server quanta is permanently stuck at the floor it
pins — it never *offers* `2025-11-25`, so it can never reach the newer protocol's surface; (2) the
handshake is one-directional — send a fixed value, never look at the answer, so a server replying with a
version quanta does not implement would be proceeded-on blindly. Every competitor (Cursor / Codex /
Claude Code CLI) carries a newest-first supported set and negotiates; quanta was the outlier.

## Decision

A single newest-first **SSOT** (`src/mcp/protocol-version.ts`, pure — no IO, no env) consumed by all three
clients/transports; the three independent `const PROTOCOL_VERSION` literals are deleted and replaced by an
import. Negotiation semantics:

1. **`SUPPORTED_PROTOCOL_VERSIONS`** — newest-first ordered tuple
   (`2025-11-25` › `2025-06-18` › `2025-03-26` › `2024-11-05` › `2024-10-07`), verbatim parity with
   Cursor + the IDE spec §6.2.1. Index 0 (`LATEST_PROTOCOL_VERSION`) is the offered default; the rest are
   downgrade-acceptable.
2. **Offer newest, accept the server's choice iff supported.** The client OFFERS `LATEST_PROTOCOL_VERSION`
   on `initialize.protocolVersion`. A spec-compliant server that does not support the offer replies with
   the highest version IT supports; the client ACCEPTS that reply **iff** it is a member of the SSOT
   (`isSupportedProtocolVersion`) and then pins it for the session — that pinned value is what the HTTP
   `mcp-protocol-version` header carries on every subsequent request.
3. **Fail-closed on an unsupported reply.** A server reply carrying a `protocolVersion` NOT in the set ⇒
   typed `McpError` (Codex `UNSUPPORTED_PROTOCOL` parity) — the client never proceeds on a version it does
   not implement. This is a *protocol* error (a throw), distinct from a `tools/call` returning
   `{isError:true}` (a result, `ok:false`, no throw) — the §3 contract must not regress.
4. **Legacy-tolerant absent field.** A server reply that omits `protocolVersion` (the shape quanta
   tolerates today) ⇒ pin to the offered value, no throw — no regression for existing servers.
5. **Bounded downgrade for a strict-old server.** A server that rejects the *unknown newer* offer with a
   JSON-RPC error (rather than negotiating down) is handled by a **single bounded re-offer** at
   `PROTOCOL_DOWNGRADE_FLOOR` (`2025-06-18`, the pre-ticket pinned value). The floor is a named constant —
   an explicit, auditable choice, not a magic index. A second failure propagates; no unbounded probe loop.
6. **`QUANTA_MCP_PROTOCOL_MAX` operator pin.** `resolveOfferedVersion(override)` resolves the offered value
   from the optional knob (carried by `runtimeConfig().mcpProtocolMax`): absent ⇒ offer the latest
   (competitor parity); a SUPPORTED override ⇒ offer it (pinning the ceiling back to `2025-06-18` restores
   byte-identical-to-pre-ticket behavior against a server known to choke on the bump and skips the §5
   probe); an UNSUPPORTED override (typo / unknown) ⇒ conservative fallback to the latest — we never put a
   version we cannot speak on the wire.
7. **SSOT single-source ratchet.** The offered-version literal must appear ONLY in `protocol-version.ts`;
   `client.ts` / `isolated-client.ts` / `http-sse.ts` carry no independent version constant. This is the
   permanent guard against the triplication re-forming.

## Default posture / backward-compat

This is NOT the usual default-OFF byte-identity case — the invariant is **"no regression for existing
servers."** The ONE observable change is the OFFERED value on the very first `initialize` (was
`2025-06-18`, now `2025-11-25`). From the post-`initialize` point everything is either pinned-to-server-
choice or unchanged. A server speaking only the old version negotiates down to `2025-06-18` and is
byte-identical from there; a strict-old server is caught by the §5 bounded re-offer; an operator who knows
a server chokes sets `QUANTA_MCP_PROTOCOL_MAX=2025-06-18` for byte-identical-to-today behavior with no
probe. Capabilities advertised are UNCHANGED — bumping the version string does NOT auto-enable
`listChanged` / `tasks` / `2025-11-25` elicitation; those stay capability- and knob-gated as today.

## Consequences

- Closes the outlier gap: quanta now negotiates like every competitor instead of pinning. Genuine wins —
  interop with current-gen servers that moved off `2025-06-18`, plus a *path* to the newer
  `tools/tasks/elicitation` capabilities (the version is the prerequisite, not the capability adoption).
- Honest scoping: this ADR buys **version parity + a downgrade-safe handshake**, NOT new capability
  behavior. Adopting each newer-version-only capability (`listChanged` re-fetch, richer tasks, the
  `2025-11-25` elicitation form) is its own separate, knob-gated follow-up that this bump unblocks.
- Residual cost: a fleet of known-old servers eats one extra `initialize` round-trip each on first connect
  (bounded, knob-skippable). No model/version default is silently widened.
- Risk surface: deleting three independent constants across three consumers (init body / init body / HTTP
  header). The §7 single-source ratchet exists precisely to prevent re-divergence.
