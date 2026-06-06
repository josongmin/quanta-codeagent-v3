/**
 * jun-7 TLS-MITM — config shape carried on {@link NetworkProxyConfig.mitm}.
 *
 * When present (operator-opt-in only, see `mitm-gate.ts`) AND a `CONNECT
 * host:443` is ALLOWED, the proxy TERMINATES TLS locally (presents a leaf minted
 * by the ephemeral {@link CertAuthority}), runs the EXISTING secret-egress scan
 * on the decrypted request, then re-originates an OWN upstream TLS connection to
 * the real host (validating the REAL server cert normally) and forwards.
 *
 * Absent ⇒ the CONNECT path stays a raw tunnel + `connect-tunnel-unscanned`
 * marker (byte-identical to the pre-slice path). This module is pure types +
 * the fail-closed policy enum; the I/O lives in `loopback-proxy.ts`.
 */

import type { CertAuthority } from "./mitm-cert"
import type { SecretEgressConfig } from "./secret-egress"

/**
 * What to do when TLS termination FAILS (handshake error, leaf-mint failure,
 * upstream-cert REJECTED, scan-path error). NEVER silently pass unscanned.
 *
 *   - `"deny"` (recommended): a handshake/scan failure on a host we MEANT to MITM
 *     becomes a hard 403 — fail closed. If we cannot scan it, we do not let it
 *     leave. (The agent's client sees a connection reset.)
 *   - `"opaque-tunnel"`: fall back to the raw CONNECT tunnel (the pre-MITM
 *     behavior) and record a `connect-tunnel-unscanned` marker — preserves
 *     availability for hosts that break under MITM (cert-pinned clients) at the
 *     cost of NOT scanning that one connection (but the gap stays VISIBLE in the
 *     log, never a silent claim of coverage).
 *
 * NOTE: an UPSTREAM cert that fails validation is ALWAYS a hard failure
 * regardless of this policy — we never forward to a server we could not
 * authenticate (the MITM does not weaken upstream verification).
 */
export type MitmFailMode = "deny" | "opaque-tunnel"

/** Injected MITM config (closed-port). */
export interface MitmConfig {
  /** The ephemeral per-session CA (mints leaves, supplies the CA the agent's
   *  MITM'd client trusts). Injected — randomness/clock live inside it. */
  readonly certAuthority: CertAuthority
  /** The SAME secret-egress config the plaintext path uses — reused, not rebuilt,
   *  so the decrypted HTTPS body/headers are scanned by the identical logic. */
  readonly secretEgress: SecretEgressConfig
  /** Fail-closed policy on a termination/scan error (default decided by the
   *  composition root; no magic default here). */
  readonly onFailure: MitmFailMode
  /**
   * FAIL-CLOSED WATCHDOG budget (ms). If the decrypted request does not parse
   * within this window — a stuck or incompatible handshake (notably: a runtime
   * that cannot drive server-side TLS on a CONNECT-upgraded socket) — the proxy
   * DENIES (or falls back per {@link onFailure}) rather than hanging, so a stuck
   * MITM never silently lets unscanned bytes leave. REQUIRED knob (no magic
   * default — no-heuristics rule; the composition root supplies a measured value).
   */
  readonly handshakeTimeoutMs: number
}
