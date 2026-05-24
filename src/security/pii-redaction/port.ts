/**
 * PII-redaction port (ADR-0171).
 *
 * Sibling slice to ADR-0164 secret-detection — closes the OTHER half of
 * agent-edited-content safety. The secret slice catches "machine credentials"
 * (AWS keys, GitHub PATs, PEM blocks); this slice catches "human identifiers"
 * (email / phone / SSN / credit-card / IP / IBAN / passport / driver's
 * license) before they reach a log, transcript, or telemetry export.
 *
 * Two adapters back this port:
 *
 *   - {@link patternPiiScanner} — closed-set regex per {@link PiiKind}. Each
 *     kind ships with a fixed confidence tier (high/medium/low).
 *   - {@link compositePiiScanner} — runs the pattern scanner and applies the
 *     Luhn checksum filter to credit-card matches; dedups overlapping ranges
 *     (longest-range wins; tie → lower index); offers `redactText` that
 *     splices placeholders in start-DESC order so offsets don't shift.
 *
 * Default-OFF: nothing in the dispatch/loop seam imports this today. The
 * caller (jsonl recorder, telemetry sink, prompt logger) opts in.
 *
 * Plane discipline: imports nothing outside its own directory — no `@/shared`,
 * no `@/permission`, no other quanta slice. Keeps the scanner portable to a
 * Tauri sidecar, worker thread, or standalone redaction binary.
 */

/**
 * Closed enum of detected PII formats. Adding a kind without wiring a matcher
 * and a default template is a TS error at compile time (exhaustive checks in
 * the pattern adapter + DEFAULT_REDACTION_TEMPLATES table).
 */
export type PiiKind =
  | "email"
  | "phone-us"
  | "phone-international"
  | "ssn-us"
  | "credit-card"
  | "ipv4"
  | "ipv6"
  | "iban"
  | "passport-us"
  | "drivers-license-us"

/**
 * One detected PII span. Char-offset based (NOT line/column) — the redactText
 * pipeline needs absolute offsets to splice replacements in start-DESC order.
 *
 * `raw` is the original matched text (for diagnostics / allowlist round-trip).
 * `redacted` is the substitution that will replace `raw` in `redactText`.
 */
export interface PiiFinding {
  readonly kind: PiiKind
  readonly start: number
  readonly end: number
  readonly raw: string
  readonly redacted: string
  readonly confidence: "high" | "medium" | "low"
}

/**
 * Port — both methods on the same interface so a caller can choose to
 * inspect findings (e.g. emit a counter) OR get the redacted string in one
 * call. Implementations are pure / deterministic / no IO.
 */
export interface PiiScanner {
  scanText(text: string): PiiFinding[]
  redactText(text: string): string
}

/**
 * Common option bag. All fields are optional with documented defaults.
 *
 * - `kinds` restricts the scan to a subset. Default = all known kinds.
 * - `redactionTemplate` overrides the placeholder string per kind. Merges
 *   on top of {@link DEFAULT_REDACTION_TEMPLATES}.
 * - `allowlist` skips findings whose `raw` text exactly matches any entry.
 *   Mirrors the secret-detection sibling's approach — exact-string, not hash.
 */
export interface PiiScannerOpts {
  readonly kinds?: ReadonlySet<PiiKind>
  readonly redactionTemplate?: Readonly<Partial<Record<PiiKind, string>>>
  readonly allowlist?: ReadonlyArray<string>
}

/**
 * Default replacement strings per kind. Bracketed UPPERCASE so a redacted
 * substring stands out in human-readable logs and is greppable.
 *
 * Centralised as a closed `Record<PiiKind, string>` so an unwired kind is a
 * TS error at compile time. Override via `PiiScannerOpts.redactionTemplate`.
 */
export const DEFAULT_REDACTION_TEMPLATES: Readonly<Record<PiiKind, string>> = {
  email: "[EMAIL]",
  "phone-us": "[PHONE]",
  "phone-international": "[PHONE]",
  "ssn-us": "[SSN]",
  "credit-card": "[CC]",
  ipv4: "[IPV4]",
  ipv6: "[IPV6]",
  iban: "[IBAN]",
  "passport-us": "[PASSPORT]",
  "drivers-license-us": "[DL]",
}

/**
 * Closed set of all known kinds. Source of truth for "default = all" when
 * `opts.kinds` is omitted. Mirrors `Object.keys(DEFAULT_REDACTION_TEMPLATES)`
 * but typed as the closed `PiiKind` union, not `string`.
 */
export const ALL_PII_KINDS: ReadonlySet<PiiKind> = new Set<PiiKind>([
  "email",
  "phone-us",
  "phone-international",
  "ssn-us",
  "credit-card",
  "ipv4",
  "ipv6",
  "iban",
  "passport-us",
  "drivers-license-us",
])
