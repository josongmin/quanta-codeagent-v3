/**
 * jun-6 exfil-rail (B) — secret-aware EGRESS decision (RFC §4.4).
 *
 * WHAT: the proxy decides on HOST only (`decideEgress`). This module adds a
 *       CONTENT-level pass over the OUTBOUND payload — the request BODY + HEADER
 *       values — and decides whether a declared/detected secret is leaving over
 *       the wire. It is the pure policy core; the I/O (buffering the body,
 *       returning a 403, masking the forwarded bytes) lives in
 *       `loopback-proxy.ts`.
 *
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.4 + §7 (B) (false-positive disc.).
 * SLICES IMPORTED: `@/security/secret-detection` (the EXISTING composite scanner
 *       port — reused, not rebuilt) only.
 *
 * ⚠️ CRITICAL HONESTY — HTTPS IS OPAQUE (RFC §3.4 caveat). The proxy's HTTPS
 * path is `CONNECT host:443` → a raw TLS tunnel; the proxy CANNOT read the
 * encrypted bytes. So this content scan covers ONLY plaintext-HTTP egress. Full
 * HTTPS body/header coverage needs TLS MITM (`network.mitm`) which is DEFERRED
 * to a separate Phase-2 RFC (CA-trust blast radius). The CONNECT path logs a
 * dedicated "not scanned" decision-log entry so the gap is VISIBLE, never a
 * silent claim of coverage. See `loopback-proxy.ts onConnect`.
 *
 * FALSE-POSITIVE DISCIPLINE (RFC §7 (B) — load-bearing):
 *   - `declared` secrets (Codex `secret_env_var` / `secret_file` parity) are an
 *     EXACT-MATCH path: a declared value appearing in the payload is a
 *     ZERO-false-positive hit (the operator told us this literal is a secret).
 *     This is the recommended primary signal.
 *   - The composite scanner (pattern + entropy) is the secondary signal; its
 *     existing `allowlist` opt drops known-public/fixture tokens — the entropy
 *     false-positive lever.
 *   - `mode:"redact"` (mask the span, forward the rest) is the recommended
 *     default over `mode:"deny"` for legit-but-leaky payloads.
 */

import type { SecretFinding, SecretScanner } from "@/security/secret-detection"
import type { HeaderRule } from "./header-rules"

/** The two egress verbs. `deny` blocks the whole request (403); `redact` masks
 *  the matched secret spans and forwards the rest. */
export type SecretEgressMode = "deny" | "redact"

/**
 * Injected secret-egress config — the closed-port shape carried on
 * `NetworkProxyConfig.secretEgress`. Absent ⇒ no body/header scan (host-only
 * decision, byte-identical).
 */
export interface SecretEgressConfig {
  /** The EXISTING composite scanner (`compositeSecretScanner()`), injected. */
  readonly scanner: SecretScanner
  /** `deny` the request OR `redact` the matched spans before forwarding. */
  readonly mode: SecretEgressMode
  /** Codex-style declared secret literals (`secret_env_var` values). A declared
   *  value appearing in the payload is an EXACT-MATCH, zero-FP hit denied/
   *  redacted regardless of entropy. Empty/absent ⇒ scanner-only. */
  readonly declared?: ReadonlyArray<string>
  /** Max bytes of body to BUFFER + scan (DoS guard). A body past this cap is
   *  forwarded UNSCANNED with a logged warning — never blocked-by-truncation.
   *  REQUIRED knob (no hardcoded default — no-heuristics rule). */
  readonly maxBodyBytes: number
  /**
   * ticket-13 (§12.2) — operator-authored OUTBOUND header-rewrite rules for the
   * PLAINTEXT-HTTP path, applied AFTER this slice's redaction (so a redacted/
   * dropped header can never be revived by a rule). Absent/empty ⇒ the forwarded
   * headers are byte-identical to today. See `./header-rules`.
   */
  readonly headerRules?: readonly HeaderRule[]
  /**
   * ticket-13 (§12.2) — cross-origin redirect hygiene flag (carried for shape
   * parity with {@link import("./mitm").MitmConfig}). See `./header-rules`
   * `shouldStripOnRedirect`. Absent/false ⇒ byte-identical.
   */
  readonly crossOriginStrip?: boolean
}

/** One declared-secret exact-match hit (the zero-FP path). */
export interface DeclaredHit {
  readonly value: string
  /** First byte offset of the match in the scanned text (for redaction). */
  readonly index: number
}

/** The pure verdict over a single scanned text (a body, or one header value). */
export interface SecretEgressVerdict {
  /** True IFF at least one declared or scanner finding fired. */
  readonly hit: boolean
  /** Declared exact-match hits (zero-FP). */
  readonly declared: readonly DeclaredHit[]
  /** Scanner (pattern/entropy) findings. */
  readonly findings: readonly SecretFinding[]
}

/** A non-empty, deduped, sorted list of declared values present in `text`,
 *  with their FIRST index (used by the redactor). Empty values are ignored. */
const findDeclared = (text: string, declared: ReadonlyArray<string>): DeclaredHit[] => {
  const hits: DeclaredHit[] = []
  const seen = new Set<string>()
  for (const value of declared) {
    if (value.length === 0 || seen.has(value)) continue
    const index = text.indexOf(value)
    if (index !== -1) {
      seen.add(value)
      hits.push({ value, index })
    }
  }
  // Deterministic order: by first index, then value.
  return hits.sort((a, b) => (a.index !== b.index ? a.index - b.index : a.value < b.value ? -1 : 1))
}

/**
 * Scan one outbound text blob (a request body, or a single header value) for a
 * leaving secret. Runs the EXACT-MATCH declared pass (zero-FP) AND the injected
 * composite scanner (pattern + entropy). Pure aside from the scanner's own
 * async surface.
 */
export const scanEgressText = async (
  text: string,
  cfg: SecretEgressConfig,
): Promise<SecretEgressVerdict> => {
  const declared = cfg.declared && cfg.declared.length > 0 ? findDeclared(text, cfg.declared) : []
  const findings = await cfg.scanner.scanText(text)
  return {
    hit: declared.length > 0 || findings.length > 0,
    declared,
    findings,
  }
}

/** Mask token — a fixed sentinel that NEVER reveals the secret. */
export const EGRESS_REDACTION_MASK = "[REDACTED:secret-egress]"

/**
 * Redact the declared exact-match spans out of `text`, replacing each with
 * {@link EGRESS_REDACTION_MASK}. Only declared values are redacted in-place
 * (their byte span is known exactly, zero-FP); scanner pattern/entropy findings
 * carry only a preview, so when the mode is `redact` and ONLY scanner findings
 * fire (no declared), the caller falls back to `deny` (a partial redact of an
 * approximate span could leak). Pure / deterministic.
 */
export const redactDeclared = (text: string, declared: readonly DeclaredHit[]): string => {
  if (declared.length === 0) return text
  // Replace every occurrence of each declared value (not just the first) so a
  // repeated literal cannot survive in a later position.
  let out = text
  for (const { value } of declared) {
    out = out.split(value).join(EGRESS_REDACTION_MASK)
  }
  return out
}

/** A verdict is fully redactable IFF every hit is a DECLARED exact-match (its
 *  span is known exactly). A scanner pattern/entropy finding carries only a
 *  preview, so an in-place redact of an approximate span could leak — those fall
 *  back to deny. Hoisted here (was a private proxy method) so BOTH the
 *  plaintext-HTTP path and the TLS-MITM path share one definition. */
export const fullyRedactable = (body: SecretEgressVerdict, header: SecretEgressVerdict): boolean =>
  body.findings.length === 0 && header.findings.length === 0

/** The terminal disposition of a body+header secret-egress scan, shared by the
 *  plaintext-HTTP and the TLS-MITM transports. Pure — no I/O. */
export type EgressScanDisposition =
  | { readonly kind: "clean" }
  | { readonly kind: "deny"; readonly reason: string }
  | {
      readonly kind: "redact"
      readonly reason: string
      readonly redactedBody: string
      readonly dropHeaderValues: readonly string[]
    }

/**
 * Run the EXACT scan+verdict logic both transports share over an
 * already-buffered body + a header-value blob. Returns the disposition; the
 * caller does the transport-specific I/O (403 vs TLS reset; forward redacted
 * body over HTTP vs HTTPS). This is the SINGLE policy core — the MITM path does
 * NOT rebuild it.
 */
export const decideEgressScan = async (
  body: string,
  headerText: string,
  cfg: SecretEgressConfig,
): Promise<EgressScanDisposition> => {
  const [bodyVerdict, headerVerdict] = await Promise.all([
    scanEgressText(body, cfg),
    scanEgressText(headerText, cfg),
  ])
  if (!(bodyVerdict.hit || headerVerdict.hit)) return { kind: "clean" }
  const reason = bodyVerdict.hit ? egressDenyReason(bodyVerdict) : egressDenyReason(headerVerdict)
  if (cfg.mode === "deny" || !fullyRedactable(bodyVerdict, headerVerdict)) {
    return { kind: "deny", reason }
  }
  return {
    kind: "redact",
    reason: `${reason} (redacted)`,
    redactedBody: redactDeclared(body, bodyVerdict.declared),
    dropHeaderValues: headerVerdict.declared.map((h) => h.value),
  }
}

/** A short, secret-free reason line for the 403 / decision-log. Names only the
 *  finding KINDS + a declared-hit count — never the secret bytes. */
export const egressDenyReason = (verdict: SecretEgressVerdict): string => {
  const parts: string[] = []
  if (verdict.declared.length > 0) parts.push(`${verdict.declared.length} declared-secret`)
  const kinds = Array.from(new Set(verdict.findings.map((f) => f.kind))).sort()
  if (kinds.length > 0) parts.push(kinds.join(","))
  return `egress denied: outbound secret detected (${parts.join("; ")})`
}
