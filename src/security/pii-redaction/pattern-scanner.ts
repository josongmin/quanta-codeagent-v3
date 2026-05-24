/**
 * Pattern-based PII adapter (ADR-0171).
 *
 * Closed-set regex per {@link PiiKind}. Each entry pre-declares its
 * confidence tier — high for shapes with a deterministic structural signature
 * (email, phone, SSN, IPv4/IPv6), medium for shapes where the signature is
 * stable but FP-prone in prose (IBAN, US passport), low for shapes that vary
 * heavily by state/jurisdiction (US driver's license).
 *
 * Credit-card matches DO NOT carry a Luhn check here — the composite scanner
 * applies it. This split keeps the pattern scanner pure (regex-only) and lets
 * the composite slice substitute or strengthen the validator.
 *
 * The catalog is ORDERED. More-specific shapes come first so a single span
 * gets the most precise kind (e.g. `+1 415 555 1234` prefers
 * `phone-international` over `phone-us`).
 */
import { DEFAULT_REDACTION_TEMPLATES, type PiiFinding, type PiiKind } from "./port"

interface Pattern {
  readonly kind: PiiKind
  readonly regex: RegExp
  readonly confidence: "high" | "medium" | "low"
}

/**
 * Ordered pattern catalog. Notes on each regex:
 *
 *   - email: RFC-5322 *simplified* — local + `@` + domain with at least one
 *     dot and a 2+ letter TLD. Skips quoted-locals and IP-literal domains;
 *     that's the conventional trade-off for prose-friendly extraction.
 *   - phone-international: explicit `+<country>` then 7-14 digits with
 *     optional space/dash separators. Must come BEFORE phone-us so `+1 415…`
 *     is classified as international.
 *   - phone-us: classic NANP shapes — `(415) 555-1234`, `415-555-1234`,
 *     `415.555.1234`. Excludes the leading `+1` (handled by international).
 *   - ssn-us: `xxx-xx-xxxx`. The 9-bare-digits variant is intentionally NOT
 *     matched as SSN (would clash with US passport).
 *   - credit-card: 13-19 digits with optional spaces or dashes every 4
 *     digits. Composite layer applies Luhn.
 *   - ipv4: 4 octets 0-255 each. Word-boundary anchored.
 *   - ipv6: covers the full form, `::` compression, and embedded ipv4
 *     suffix. Not every degenerate corner — see `RFC-4291 §2.2`.
 *   - iban: 2 letters + 2 check digits + 10-30 alphanumerics. Length range
 *     covers the published country IBAN spec (Norway 15 → Malta 31).
 *   - passport-us: 9 bare digits at word boundary. MEDIUM confidence — a
 *     9-digit order number trips this too; that's why ssn-us uses dashes.
 *   - drivers-license-us: 6-14 alphanumeric chars on its own line/word
 *     boundary. LOW confidence — state formats vary widely.
 */
const PATTERNS: ReadonlyArray<Pattern> = [
  {
    kind: "email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: "high",
  },
  {
    kind: "phone-international",
    // +<1-3 country digits> then 7-14 more digits with optional space/dash.
    regex: /\+\d{1,3}[\s-]?(?:\d[\s-]?){6,13}\d/g,
    confidence: "high",
  },
  {
    kind: "phone-us",
    // (xxx) xxx-xxxx | xxx-xxx-xxxx | xxx.xxx.xxxx
    regex: /\b(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
    confidence: "high",
  },
  {
    kind: "ssn-us",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: "high",
  },
  {
    kind: "credit-card",
    // 13-19 total digits with optional dashes/spaces every 4 digits.
    // Composite applies Luhn afterwards.
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: "high",
  },
  {
    kind: "ipv4",
    // Each octet 0-255 with no leading zero on 2+ digit values (250 OK, 099 not OK).
    regex: /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
    confidence: "high",
  },
  {
    kind: "ipv6",
    // Full form + :: compression + ipv4-suffix. Pragmatic — won't catch every
    // corner of RFC-4291 but covers the canonical printable forms.
    regex:
      /(?:(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4})|(?:(?:[A-Fa-f0-9]{1,4}:){1,7}:)|(?:(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4})|(?:(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2})|(?:(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3})|(?:(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4})|(?:(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5})|(?:[A-Fa-f0-9]{1,4}:(?::[A-Fa-f0-9]{1,4}){1,6})|(?::(?:(?::[A-Fa-f0-9]{1,4}){1,7}|:))/g,
    confidence: "high",
  },
  {
    kind: "iban",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
    confidence: "medium",
  },
  {
    kind: "passport-us",
    // 9 bare digits — must not be embedded in a longer digit run.
    regex: /\b\d{9}\b/g,
    confidence: "medium",
  },
  {
    kind: "drivers-license-us",
    // 1-2 letters then 5-13 digits — a loose superset of common state formats
    // (CA = 1 letter + 7 digits, TX = 8 digits, NY = 9 digits etc.). Lower
    // confidence so a downstream filter can decide.
    regex: /\b[A-Z]{1,2}\d{5,13}\b/g,
    confidence: "low",
  },
]

/**
 * Build a {@link PiiFinding} with the right placeholder. The template map is
 * merged on top of {@link DEFAULT_REDACTION_TEMPLATES} — caller overrides win.
 */
const buildFinding = (
  pat: Pattern,
  raw: string,
  start: number,
  templateOverrides: Readonly<Partial<Record<PiiKind, string>>>,
): PiiFinding => {
  const redacted = templateOverrides[pat.kind] ?? DEFAULT_REDACTION_TEMPLATES[pat.kind]
  return {
    kind: pat.kind,
    start,
    end: start + raw.length,
    raw,
    redacted,
    confidence: pat.confidence,
  }
}

/**
 * Drain one pattern against `text`, pushing every match into `findings`.
 * Allowlist matches are dropped. No dedup or overlap resolution here — the
 * composite layer owns that.
 */
const drainPattern = (
  pat: Pattern,
  text: string,
  allow: ReadonlySet<string>,
  templateOverrides: Readonly<Partial<Record<PiiKind, string>>>,
  findings: PiiFinding[],
): void => {
  pat.regex.lastIndex = 0
  let match: RegExpExecArray | null = pat.regex.exec(text)
  while (match !== null) {
    const raw = match[0]
    if (!allow.has(raw)) {
      findings.push(buildFinding(pat, raw, match.index, templateOverrides))
    }
    // Prevent zero-width infinite-loop on a pathological regex match.
    if (match.index === pat.regex.lastIndex) {
      pat.regex.lastIndex++
    }
    match = pat.regex.exec(text)
  }
}

/**
 * Scan `text` with all (or a restricted set of) PII patterns. Returns
 * findings in catalog order (NOT sorted by start offset) — composite layer
 * sorts and dedups.
 *
 * @param text Input string.
 * @param kinds Restricted kind set. `undefined` means "all kinds".
 * @param allow Exact-match allowlist.
 * @param templateOverrides Per-kind placeholder overrides.
 */
export const runPatterns = (
  text: string,
  kinds: ReadonlySet<PiiKind> | undefined,
  allow: ReadonlySet<string>,
  templateOverrides: Readonly<Partial<Record<PiiKind, string>>>,
): PiiFinding[] => {
  const findings: PiiFinding[] = []
  for (const pat of PATTERNS) {
    if (kinds !== undefined && !kinds.has(pat.kind)) continue
    drainPattern(pat, text, allow, templateOverrides, findings)
  }
  return findings
}
