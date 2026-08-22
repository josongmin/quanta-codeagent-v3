/**
 * jun-7 TLS-MITM — OPERATOR-OPT-IN gate (pure, default-OFF).
 *
 * WHAT: maps an INJECTED env bag to `true` (MITM permitted) IFF the operator has
 *       made TWO explicit, deliberate signals. MITM-ing your own egress mints a
 *       trust anchor your client accepts — a STRONGER security tradeoff than the
 *       other egress knobs — so a single `=1` is NOT enough. The gate requires:
 *
 *         QUANTA_TLS_MITM=1   AND   QUANTA_TLS_MITM_ACK=<the exact ack phrase>
 *
 *       The ack phrase is a fixed, self-documenting string the operator must type
 *       VERBATIM, so MITM cannot be turned on by a stray `=1` copied from another
 *       knob or a templated CI matrix. Default-OFF: either signal missing / any
 *       other value ⇒ `false` ⇒ the proxy NEVER terminates TLS and the
 *       `CONNECT host:443` path stays a raw tunnel + `connect-tunnel-unscanned`
 *       marker (byte-identical to the pre-slice path).
 *
 * NO-THROW: total over the input record. Reads injected env only (memory rule).
 */

import { gateOnStrict } from "@/shared"

/** Master switch (must be exactly "1"). */
export const TLS_MITM_ENV = "QUANTA_TLS_MITM"
/** Explicit acknowledgement var — must equal {@link TLS_MITM_ACK_PHRASE}. */
export const TLS_MITM_ACK_ENV = "QUANTA_TLS_MITM_ACK"

/**
 * The verbatim acknowledgement phrase. It spells out the tradeoff so an operator
 * cannot enable MITM without reading what it does. Changing this string is a
 * BREAKING posture change (operators must re-ack).
 */
export const TLS_MITM_ACK_PHRASE = "i-understand-mitm-mints-a-trust-anchor"

/**
 * Resolve whether TLS-MITM is OPERATOR-AUTHORIZED from an injected env bag.
 * Returns `true` ONLY when both the master switch is exactly `"1"` AND the ack
 * var equals the verbatim phrase. Every other shape ⇒ `false` (OFF). Never
 * throws.
 */
export const tlsMitmAuthorized = (env: Readonly<Record<string, string | undefined>>): boolean =>
  gateOnStrict(env, TLS_MITM_ENV) && env[TLS_MITM_ACK_ENV] === TLS_MITM_ACK_PHRASE
