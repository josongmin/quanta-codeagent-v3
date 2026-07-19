/**
 * Network-egress proxy — shared types (ADR-0428).
 *
 * Socket-level egress enforcement. Today (jun-01) quanta gates egress only at
 * the TOOL-ARG layer (`src/agent/dispatch-guard/network-guard.ts` extracts a
 * host from a tool call). A subprocess that opens its OWN socket bypasses that
 * gate entirely. This slice closes the hole with a REAL loopback HTTP proxy
 * (Node `http`/`net`): child processes get `HTTP_PROXY`/`HTTPS_PROXY` pointed
 * at the proxy, so every outbound connection is funneled through the same
 * `isHostAllowed` decision used by the dispatch guard.
 *
 * Plane-clean: this file is pure types — no imports beyond the runtime stdlib
 * shape it mirrors. The allow decision is delegated to
 * `@/runtime/network-allowlist#isHostAllowed` (reused, not re-implemented).
 */

/** The three terminal decisions the proxy can reach for one connection. */
export type ProxyDecisionKind = "allow" | "deny" | "amended-allow"

/** Per-connection decision log entry. Append-only; the proxy never mutates a
 *  prior entry. `host` is the bare hostname the client asked for (CONNECT
 *  authority or the request URL host), lowercased. */
export interface DecisionLogEntry {
  readonly host: string
  readonly decision: ProxyDecisionKind
  /** Human-readable reason (denial cause / which rule allowed it). */
  readonly reason: string
  /** Wall-clock ms when the decision was reached (injected clock in tests). */
  readonly at: number
  /**
   * jun-6 exfil-rail (B) — outbound content-scan disposition for THIS
   * connection. Absent ⇒ no secret-egress scan ran (host-only, the default).
   * `scanned-clean` / `denied` / `redacted` describe a plaintext-HTTP scan;
   * `connect-tunnel-unscanned` makes the HONEST HTTPS gap VISIBLE — the CONNECT
   * tunnel carries opaque TLS bytes the proxy cannot read (needs MITM, deferred
   * Phase-2 RFC), so its body was NOT scanned; `body-cap-unscanned` marks a body
   * past the buffered-byte cap forwarded UNSCANNED (DoS guard, never blocked-
   * by-truncation). These are advisory telemetry — they never change the host
   * allow/deny verdict in `decision`.
   */
  readonly secretScan?:
    | "scanned-clean"
    | "denied"
    | "redacted"
    | "connect-tunnel-unscanned"
    | "body-cap-unscanned"
}

/**
 * Static configuration for the loopback proxy. The proxy is DEFAULT-OFF: a
 * composition root only constructs it when `enabled` is true. Absent config ⇒
 * no proxy, no env injection (byte-identical to the pre-slice path).
 */
export interface NetworkProxyConfig {
  /** Master switch. When false/absent the slice contributes nothing. */
  readonly enabled: boolean
  /** Base allow-set (exact host or `*.suffix`, reusing `isHostAllowed`
   *  semantics). Amendments are layered ON TOP of this at runtime. */
  readonly allowlist: readonly string[]
  /** Loopback bind host. Defaults to `127.0.0.1`. Never bind a routable
   *  interface — the proxy is for THIS host's children only. */
  readonly bindHost?: string
  /** Bind port. `0` (default) ⇒ an ephemeral port chosen by the OS; read the
   *  actual port back via {@link NetworkProxyPort.address} after `listen`. */
  readonly port?: number
  /** Hosts that bypass the proxy entirely (`NO_PROXY`). Defaults to
   *  `localhost,127.0.0.1` so loopback dev servers are reachable WITHOUT being
   *  routed through (and SSRF-blocked by) the proxy. */
  readonly noProxy?: readonly string[]
  /**
   * jun-6 exfil-rail (B) — secret-aware egress (RFC §4.4). Absent ⇒ the egress
   * decision is HOST-ONLY (no body/header scan), byte-identical. When present,
   * the PLAINTEXT-HTTP path (`pipeHttp`) buffers the outbound body + scans body
   * and header values for a declared/detected secret and denies/redacts on a
   * hit.
   *
   * ⚠️ HTTPS IS OPAQUE: the `CONNECT host:443` tunnel carries raw TLS bytes the
   * proxy cannot read, so a CONNECT request is NEVER content-scanned — instead a
   * dedicated `connect-tunnel-unscanned` decision-log entry makes the gap
   * VISIBLE (RFC §3.4 caveat; full coverage needs TLS MITM, a deferred Phase-2
   * RFC). See `./secret-egress` + `loopback-proxy.ts`.
   */
  readonly secretEgress?: import("./secret-egress").SecretEgressConfig
  /**
   * jun-6 exfil-rail (C) — advisory denied-host fan-out threshold.  Present only
   * when both the strict scouting gate and its positive operator-supplied K are
   * configured.  The proxy evaluates its append-only decision log after each
   * verdict; a signal is diagnostic only and never changes allow/deny policy.
   */
  readonly exfilScoutingThreshold?: number
  /**
   * jun-7 TLS-MITM (Phase-2 of exfil-rail (B)) — closes the HTTPS-opaque gap.
   * Absent ⇒ a `CONNECT host:443` stays a RAW tunnel + `connect-tunnel-unscanned`
   * marker (byte-identical to the pre-slice path). When present (operator-opt-in
   * ONLY, see `./mitm-gate`), an ALLOWED CONNECT is TERMINATED at the proxy
   * (presenting a leaf minted by the ephemeral CA), the decrypted request body +
   * headers run through the SAME secret-egress scan as the plaintext path, then
   * the proxy re-originates its OWN upstream TLS connection to the real host
   * (validating the REAL server cert) and forwards.
   *
   * ⚠️ SECURITY: the MITM CA is a powerful trust anchor — ephemeral / in-memory /
   * trusted only by quanta's OWN MITM'd client, never the OS. See `./mitm` +
   * `./mitm-cert` for the blast-radius threat model.
   */
  readonly mitm?: import("./mitm").MitmConfig
}

/** Address the proxy is bound to after `listen()` resolves. */
export interface ProxyAddress {
  readonly host: string
  readonly port: number
}
