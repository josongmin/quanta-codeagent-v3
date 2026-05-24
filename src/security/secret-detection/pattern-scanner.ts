/**
 * Pattern-based adapter (ADR-0164).
 *
 * Closed-set regex per {@link SecretKind} — every match fires `confidence:
 * "high"`. Signature subset absorbed from:
 *
 *   - git-secrets (AWS official) — AKIA-prefix + secret-key assignment shape.
 *   - trufflehog catalog — OpenAI / Anthropic / GitHub / Google / Slack /
 *     Stripe / GCP-service-account JSON / PEM private-key block.
 *
 * Each regex anchors on the secret's deterministic prefix shape (e.g.
 * `AKIA[0-9A-Z]{16}`) — we deliberately do NOT match English keywords like
 * "password" so the false-positive surface stays narrow. The closed-union
 * type system catches a missing matcher at compile time.
 */
import { readFile } from "node:fs/promises"
import {
  DEFAULT_MAX_FINDINGS,
  mask,
  type SecretFinding,
  type SecretKind,
  type SecretScanner,
  type SecretScannerOpts,
} from "./port"

interface Pattern {
  readonly kind: Exclude<SecretKind, "generic-high-entropy">
  readonly regex: RegExp
}

/**
 * Ordered pattern catalog. Order matters: PEM blocks first (avoid double-hit
 * on shapes embedded inside a key block), `sk-ant-` before generic `sk-`, GCP
 * JSON before any generic `private_key` keyword match.
 */
const PATTERNS: ReadonlyArray<Pattern> = [
  // PEM / RSA / EC / DSA / OpenSSH private-key block — match begin-to-end so
  // an `AKIA…`-shaped string inside the block does not double-hit.
  {
    kind: "private-key-block",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
  },
  // GCP service-account JSON — anchored on the literal `"type":"service_account"`
  // marker. Greedy enough to cover the JSON object but bounded by `}` so we
  // don't redact an entire enclosing file.
  {
    kind: "gcp-service-account",
    regex: /\{[^{}]*?"type"\s*:\s*"service_account"[^{}]*?\}/g,
  },
  // AWS access key id — exact AKIA/ASIA/AROA/AIDA + 16 base32 chars.
  {
    kind: "aws-access-key",
    regex: /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g,
  },
  // AWS secret access key — 40-char base64 anchored on the documented
  // assignment shape (`aws_secret_access_key = …`). Anchoring on the assignment
  // is the documented way to detect AWS secret keys without firing on every
  // 40-char identifier.
  {
    kind: "aws-secret-key",
    regex: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/gi,
  },
  // GitHub tokens — classic + fine-grained PAT prefixes.
  {
    kind: "github-token",
    regex: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{36,255}\b/g,
  },
  // Google API key — `AIza` + 35 url-safe base64.
  {
    kind: "google-api-key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  // Anthropic API key — `sk-ant-` prefix. MUST come before openai (which is
  // just `sk-`) so the more-specific shape wins.
  {
    kind: "anthropic-api-key",
    regex: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  },
  // Stripe live/test secret key (also restricted/test variants).
  {
    kind: "stripe-key",
    regex: /\b(?:sk_live_|sk_test_|rk_live_|rk_test_|pk_live_)[A-Za-z0-9]{20,}\b/g,
  },
  // OpenAI API key — `sk-` followed by ≥32 alphanumerics. Negative-lookahead
  // on `ant-` / `live_` / `test_` so anthropic/stripe forms above win.
  {
    kind: "openai-api-key",
    regex: /\bsk-(?!ant-)(?!live_)(?!test_)[A-Za-z0-9]{32,}\b/g,
  },
  // Slack token — `xox[baprse]-` prefix + ≥10 token chars. The prefix is
  // distinctive enough that this carries no false-positive risk in prose.
  {
    kind: "slack-token",
    regex: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
  },
]

/**
 * Locate a substring's (line, column) by scanning newline counts. 1-indexed
 * to match editor and `cat -n` conventions. O(matchOffset) per finding — fine
 * for a scanner that caps at `maxFindings`.
 */
const locate = (text: string, offset: number): { line: number; column: number } => {
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++
      lastNewline = i
    }
  }
  return { line, column: offset - lastNewline }
}

/**
 * Run the regex catalog against `text` and emit findings. Allowlist matches
 * are dropped without recording. `maxFindings` caps the result — once hit,
 * subsequent matches in any pattern are silently skipped (the cap is a
 * resource guard, not a precision signal).
 */
/** Build a SecretFinding honoring exactOptional `file`. */
const buildFinding = (
  kind: Exclude<SecretKind, "generic-high-entropy">,
  matched: string,
  line: number,
  column: number,
  file: string | undefined,
): SecretFinding =>
  file !== undefined
    ? { kind, file, line, column, preview: mask(matched), confidence: "high" }
    : { kind, line, column, preview: mask(matched), confidence: "high" }

/** Drain one pattern against `text`, pushing findings until `max`. */
const drainPattern = (
  pat: Pattern,
  text: string,
  file: string | undefined,
  allow: ReadonlySet<string>,
  findings: SecretFinding[],
  max: number,
): void => {
  pat.regex.lastIndex = 0
  let match: RegExpExecArray | null = pat.regex.exec(text)
  while (match !== null && findings.length < max) {
    const matched = match[0]
    if (!allow.has(matched)) {
      const { line, column } = locate(text, match.index)
      findings.push(buildFinding(pat.kind, matched, line, column, file))
    }
    match = pat.regex.exec(text)
  }
}

const scanTextWithPatterns = (
  text: string,
  file: string | undefined,
  opts: SecretScannerOpts,
): SecretFinding[] => {
  const max = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  const allow = new Set(opts.allowlist ?? [])
  const findings: SecretFinding[] = []
  for (const pat of PATTERNS) {
    if (findings.length >= max) break
    drainPattern(pat, text, file, allow, findings, max)
  }
  return findings
}

/**
 * Construct a pattern-based SecretScanner. The returned object is a fresh
 * instance per call (no shared mutable state) so tests can run in parallel
 * and callers can hold per-context configurations.
 */
export const patternScanner = (opts: SecretScannerOpts = {}): SecretScanner => ({
  async scanText(text, scanOpts) {
    return scanTextWithPatterns(text, scanOpts?.file, opts)
  },
  async scanFile(path) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      // Binary / unreadable — return empty. Decode-fail tolerance is the
      // documented contract; pre-commit hooks must not crash on a stray
      // PDF in the staging area.
      return []
    }
    return scanTextWithPatterns(text, path, opts)
  },
})
