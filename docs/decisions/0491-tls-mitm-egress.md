# ADR-0491: TLS-MITM egress — HTTPS body/header secret scanning (ephemeral-CA decrypt → reuse scan → re-encrypt)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - RFC `docs/plans/jun-6-tls-mitm-egress.md` (Status ✅ IMPLEMENTED jun-07).
  - ADR-0490 (secret-aware egress, plaintext-HTTP) — this is its Phase-2: it closes the `connect-tunnel-unscanned` HTTPS-opaque gap by reusing the SAME `decideEgressScan` core over decrypted bytes.
  - Absorbs Codex `network.mitm`.
- **참조**:
  - `src/runtime/network-proxy/mitm-cert.ts` — `MitmCertAuthority`: pure `node:crypto` X.509 v3 DER encoder + ECDSA-P256 sign (NO new dep; node:crypto parses certs but cannot generate, so the encoder is hand-rolled). Injected `keyPairSource`/`serialSource`/`now`/`validity` (deterministic).
  - `src/runtime/network-proxy/mitm.ts` — `mitmTerminate` (server-side TLS termination on the CONNECT-upgraded socket, leaf mint, `parseTlsRequest` one-shot HTTP parse), `mitmForwardUpstream` (`node:https`, `rejectUnauthorized:true`, SNI).
  - `src/runtime/network-proxy/mitm-gate.ts` — `tlsMitmAuthorized`: the DOUBLE gate.
  - `src/runtime/network-proxy/loopback-proxy.ts` — `onConnect` branches to `mitmTerminate` when ALLOWED + `config.mitm` present.
  - `src/runtime/network-proxy/secret-egress.ts` (reused scan core), `types.ts`, `index.ts`, `src/shared/runtime-config.ts` (`tlsMitm` / `tlsMitmOnFailure`).
  - Tests: `tests/unit/tls-mitm-cert.test.ts`, `tests/unit/tls-mitm-gate.test.ts`, `tests/unit/tls-mitm-scan-integration.test.ts`, `tests/integration/tls-mitm-egress-e2e.test.ts`.
  - Feature catalog: `tools/feature-catalog/features/03-permission-safety/jun7-tls-mitm-egress.yaml` (id `tls-mitm-egress`).

## Context

The shipped secret-egress rail (ADR-0490) scans only plaintext-HTTP; an HTTPS
request body behind `CONNECT host:443` is a raw TLS tunnel the proxy cannot read.
Most modern exfil sinks (webhook / file-share / paste / LLM-API) are HTTPS, and
the agent's own `web_fetch` / MCP-over-HTTPS bodies are invisible. Closing it
requires terminating TLS at the proxy.

## Decision

On an ALLOWED `CONNECT host:443` with MITM configured, terminate TLS locally
(present a host LEAF signed by an EPHEMERAL per-session CA) → decrypt → run the
EXISTING `decideEgressScan` core (SAME path as plaintext) → deny / redact / clean
→ re-originate upstream over the proxy's OWN TLS with full real-cert verification
→ re-encrypt. No new dependency (pure `node:crypto` cert-gen).

## Fail-closed / security invariants

- **CA blast-radius sealed.** The CA is EPHEMERAL: per-session, in-memory, NOT
  injected into any OS trust store, never persisted. Only quanta's own MITM'd
  outbound client socket trusts it — not NODE_EXTRA_CA_CERTS, not the system
  store, not another process.
- **Upstream verification is NEVER weakened.** `rejectUnauthorized:true` + default
  store + SNI; a forged upstream cert ⇒ 502, ALWAYS a hard fail — never
  blind-accept, regardless of `onFailure`.
- **Stronger-than-usual double gate.** `QUANTA_TLS_MITM=1` AND the verbatim ack
  `QUANTA_TLS_MITM_ACK=i-understand-mitm-mints-a-trust-anchor` — a stray `=1`
  cannot mint a trust anchor. Either missing ⇒ raw tunnel (byte-identical).
- **Fail-closed everywhere.** `tlsMitmOnFailure` is an enum mode-selector
  (`deny` | `opaque-tunnel`) defaulting to `deny` (the safe value): a
  handshake / mint / scan error ⇒ deny; a watchdog (`handshakeTimeoutMs`) turns a
  stuck handshake into a hard deny — unscanned bytes NEVER pass.

## Runtime honesty

Server-side TLS termination on a CONNECT-upgraded socket works on **node:tls**;
**Bun 1.3.x** cannot yet drive it (handshake stall). The fail-closed watchdog
turns that stall into a hard DENY, so safety holds on every runtime; the positive
(secret-caught + forward) proof runs under Node. Real MITM function is node:tls
only — on Bun the path is fail-closed.

## Default posture

OFF, byte-identical. Absent the double gate ⇒ CONNECT stays a raw tunnel with the
`connect-tunnel-unscanned` marker.

## ROI / tradeoff

HIGH for HTTPS exfil coverage (the realistic threat surface), but the highest
trust cost on the board (minting a trust anchor). The ephemeral, single-socket,
never-persisted CA + the double gate + node:tls-only runtime are the mitigations;
default-OFF + operator-explicit-opt-in make the cost deliberate.
