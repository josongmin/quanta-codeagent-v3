/**
 * Entropy-based adapter (ADR-0164).
 *
 * Sliding-window tokenizer + Shannon entropy detector for `generic-high-entropy`
 * findings. Catches novel secret formats that don't match any signature in
 * `pattern-scanner.ts` (custom internal API tokens, vendor keys we haven't
 * catalogued yet).
 *
 * Trade-off: entropy alone is famously false-positive-prone — random hex
 * hashes (SHA-256), UUIDs, and dense base64 data blobs all clear 4.5 bits/char.
 * We attack this with two filters:
 *
 *   1. Structural skip — only UNAMBIGUOUS non-secret SHAPES (canonical
 *      8-4-4-4-12 UUIDs) are skipped before the entropy gate runs. Bare
 *      hex-hash-length strings are NO LONGER blanket-skipped (audit L8 M8):
 *      a 64-hex secret is byte-identical to a SHA256 digest, so skipping it
 *      would guarantee a carried-secret blind spot. See
 *      {@link isStructuralNonSecret}.
 *   2. Confidence band — every entropy hit fires `confidence: "medium"`, so
 *      a composite scan demotes them when a pattern-anchored finding covers
 *      the same span (see `composite-scanner.ts`).
 *
 * The 4.5 bits/char default mirrors the trufflehog "base64 detector" cut-off
 * — high enough to drop English prose (≈ 3.0 b/c) and most identifiers, low
 * enough to catch 40-char base64 secrets (theoretical max 6.0 b/c for true
 * uniform base64).
 */
import { readFile } from "node:fs/promises"
import {
  DEFAULT_ENTROPY_THRESHOLD_BITS_PER_CHAR,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MIN_SECRET_LENGTH,
  mask,
  type SecretFinding,
  type SecretScanner,
  type SecretScannerOpts,
} from "./port"

/**
 * Shannon entropy in bits per character. Empty string ⇒ 0. The histogram is
 * O(n); summation is O(distinctChars) which is bounded by 256 for ASCII or
 * by the alphabet for non-ASCII (still small).
 *
 * Implementation note: we use `Map` to support arbitrary code points (Unicode
 * paste-in tokens), but the hot path is ASCII. `Math.log2` is browser/Node
 * universal.
 */
export const shannonEntropyBits = (s: string): number => {
  if (s.length === 0) return 0
  const histogram = new Map<string, number>()
  for (const ch of s) {
    histogram.set(ch, (histogram.get(ch) ?? 0) + 1)
  }
  const n = s.length
  let bits = 0
  for (const count of histogram.values()) {
    const p = count / n
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * Structural-shape skip filter. Returns `true` for tokens that are
 * UNAMBIGUOUSLY non-secret SHAPES — i.e. shapes a raw credential cannot take.
 *
 * T08 — May-31 bugbash, audit L8 M8 (carried 64-hex hole)
 * ──────────────────────────────────────────────────────
 * The prior filter ALSO skipped any bare hex string of length 32/40/64/128 as
 * an "MD5/SHA1/SHA256/SHA512 digest". That is a GUARANTEED blind spot: a great
 * many vendors issue secrets as exactly-64-hex tokens (and 32-hex API keys),
 * which are byte-identical to a SHA256/MD5 digest. A *secret detector* that
 * resolves that ambiguity by always treating 64-hex as a digest will NEVER
 * flag a carried 64-hex credential — the exact hole the audit names.
 *
 * Entropy cannot distinguish a digest from a secret of the same shape, so we
 * stop pretending it can: we no longer blanket-skip bare hex-hash lengths.
 * Such a token now surfaces as a `confidence: "medium"` `generic-high-entropy`
 * finding — which is precisely what the confidence band exists for: a
 * composite scan (`composite-scanner.ts`) demotes it when a pattern-anchored
 * digest/non-secret context covers the same span, so the false-positive cost
 * is paid only where there is no anchoring context. Fail toward DETECTION, not
 * toward silence.
 *
 * What stays skipped: the canonical dashed UUID (8-4-4-4-12). A UUID's dashed
 * shape is one a raw credential token does not take, so skipping it does not
 * open a carried-secret hole — it only suppresses a well-known noise source.
 *
 * SCOPING — pure-hex secrets are NOT a supported detector class here.
 * Shannon entropy over a 16-symbol hex alphabet maxes at log2(16)=4.0
 * bits/char, BELOW the 4.5 b/c default cut-off. So a hex-encoded credential
 * (e.g. a bare 64-hex token) cannot clear the entropy gate REGARDLESS of this
 * structural filter — the entropy scanner structurally cannot detect hex-only
 * secrets. Catching those is the PATTERN scanner's job (a vendor-anchored
 * `^[0-9a-f]{64}$`-with-context regex in `pattern-scanner.ts`), not entropy's.
 * Removing the blanket hex skip above still matters for the catchable case:
 * mixed-alphabet 32/40/64/128-char tokens (base64 / base62 secrets) that DO
 * clear 4.5 b/c are no longer silently dropped just for hitting a digest
 * LENGTH.
 */
const isStructuralNonSecret = (token: string): boolean => {
  // UUID 8-4-4-4-12 — a fixed dashed shape, never a raw secret token.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return true
  }
  return false
}

/**
 * Tokenize on whitespace + common delimiters (quotes, commas, semicolons,
 * angle brackets, parens, equals). Returns each token with its absolute byte
 * offset so the locator can emit accurate line/column. We do NOT split on `.`
 * / `-` / `_` / `/` / `+` / `=` because base64 and url-safe-base64 secrets
 * legitimately contain those chars.
 */
const DELIM_RE = /[\s"',;<>()[\]{}]+/g

interface Token {
  readonly text: string
  readonly offset: number
}

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = []
  let cursor = 0
  DELIM_RE.lastIndex = 0
  let delim: RegExpExecArray | null = DELIM_RE.exec(text)
  while (delim !== null) {
    if (delim.index > cursor) {
      tokens.push({ text: text.slice(cursor, delim.index), offset: cursor })
    }
    cursor = delim.index + delim[0].length
    delim = DELIM_RE.exec(text)
  }
  if (cursor < text.length) {
    tokens.push({ text: text.slice(cursor), offset: cursor })
  }
  return tokens
}

/** 1-indexed line/column locator — same algorithm as pattern-scanner. */
const locate = (text: string, offset: number): { line: number; column: number } => {
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lastNewline = i
    }
  }
  return { line, column: offset - lastNewline }
}

/** Build a `generic-high-entropy` finding honoring exactOptional `file`. */
const buildEntropyFinding = (
  tokenText: string,
  bits: number,
  line: number,
  column: number,
  file: string | undefined,
): SecretFinding =>
  file !== undefined
    ? {
        kind: "generic-high-entropy",
        file,
        line,
        column,
        preview: mask(tokenText),
        entropyBits: bits,
        confidence: "medium",
      }
    : {
        kind: "generic-high-entropy",
        line,
        column,
        preview: mask(tokenText),
        entropyBits: bits,
        confidence: "medium",
      }

interface EntropyEval {
  readonly minLen: number
  readonly threshold: number
  readonly allow: ReadonlySet<string>
}

/** Decide if a token should be reported (single point for all filters). */
const acceptToken = (tokenText: string, ev: EntropyEval): number | null => {
  if (tokenText.length < ev.minLen) return null
  if (ev.allow.has(tokenText)) return null
  if (isStructuralNonSecret(tokenText)) return null
  const bits = shannonEntropyBits(tokenText)
  return bits < ev.threshold ? null : bits
}

const scanTextForEntropy = (
  text: string,
  file: string | undefined,
  opts: SecretScannerOpts,
): SecretFinding[] => {
  const max = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  const ev: EntropyEval = {
    minLen: opts.minSecretLength ?? DEFAULT_MIN_SECRET_LENGTH,
    threshold: opts.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD_BITS_PER_CHAR,
    allow: new Set(opts.allowlist ?? []),
  }
  const findings: SecretFinding[] = []
  for (const tok of tokenize(text)) {
    if (findings.length >= max) break
    const bits = acceptToken(tok.text, ev)
    if (bits === null) continue
    const { line, column } = locate(text, tok.offset)
    findings.push(buildEntropyFinding(tok.text, bits, line, column, file))
  }
  return findings
}

export const entropyScanner = (opts: SecretScannerOpts = {}): SecretScanner => ({
  async scanText(text, scanOpts) {
    return scanTextForEntropy(text, scanOpts?.file, opts)
  },
  async scanFile(path) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      return []
    }
    return scanTextForEntropy(text, path, opts)
  },
})
