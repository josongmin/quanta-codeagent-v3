/**
 * Secret-detection port (ADR-0164).
 *
 * Hexagonal seam for "pre-commit" / "pre-write" secret scanning. Two adapters
 * implement this port:
 *
 *   - {@link patternScanner} — closed-set regex per {@link SecretKind}, fires
 *     `confidence: "high"`. Absorbs the AWS official `git-secrets` provider
 *     pattern catalog + trufflehog's signature subset.
 *   - {@link entropyScanner} — Shannon entropy over whitespace-delimited
 *     tokens; fires `kind: "generic-high-entropy"` with `confidence: "medium"`.
 *     Skips structural false-positives (SHA / UUID).
 *
 * {@link compositeSecretScanner} composes both adapters and dedups overlapping
 * findings — pattern wins over entropy on the same (file, line, column).
 *
 * Default-OFF: nothing in dispatch/loop/agent wires this today. The caller
 * (a `secret_scan` tool, a pre-commit hook, or a CI gate) opts in.
 *
 * Plane discipline: the slice imports ONLY `node:crypto` (Shannon entropy)
 * and node fs/path/os primitives (for `scanFile`). No other quanta slice is
 * touched — keeps the port re-usable in a Tauri sidecar or a worker thread.
 */

/**
 * Closed enum of detected secret formats. Adding a kind without wiring a
 * matcher is a TS error at compile time via the exhaustive switch in the
 * pattern adapter.
 */
export type SecretKind =
  | "aws-access-key"
  | "aws-secret-key"
  | "openai-api-key"
  | "anthropic-api-key"
  | "github-token"
  | "google-api-key"
  | "gcp-service-account"
  | "slack-token"
  | "stripe-key"
  | "private-key-block"
  | "generic-high-entropy"

/**
 * One detected secret. `file` is omitted (exactOptional) when the caller fed
 * `scanText` without a `{ file }` hint. `entropyBits` is omitted when the
 * adapter is the pattern scanner (the value is irrelevant for signature-
 * anchored matches).
 */
export interface SecretFinding {
  readonly kind: SecretKind
  readonly file?: string
  readonly line: number
  readonly column: number
  readonly preview: string
  readonly entropyBits?: number
  readonly confidence: "high" | "medium" | "low"
}

/**
 * Common option bag. All fields are optional with documented defaults; we
 * never read undefined into a "magic number" — defaults are spelled out in
 * the adapter implementations and asserted by the hellgate suite.
 */
export interface SecretScannerOpts {
  /** Maximum findings to return. Excess matches are truncated. Default 100. */
  readonly maxFindings?: number
  /** Shannon entropy threshold (bits/char). Default 4.5. Above this, an
   *  entropy adapter emits a `generic-high-entropy` finding. */
  readonly entropyThreshold?: number
  /** Skip tokens shorter than this. Default 20. */
  readonly minSecretLength?: number
  /** Allowlist — exact-string matches are dropped from results. Useful for
   *  fixture tokens and known-public examples. */
  readonly allowlist?: ReadonlyArray<string>
}

/**
 * Port. Two methods so callers can scan an in-memory blob (the diff hunk
 * a tool is about to apply) OR a real file (a pre-commit hook walking the
 * staged tree).
 */
export interface SecretScanner {
  scanText(text: string, opts?: { file?: string }): SecretFinding[]
  scanFile(path: string): Promise<SecretFinding[]>
}

/**
 * Resolved defaults — single SoT consumed by every adapter. Splitting the
 * defaults from the type lets the hellgate suite assert "override respected"
 * and "default honored" with one symbol per knob.
 */
export const DEFAULT_MAX_FINDINGS = 100
export const DEFAULT_ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.5
export const DEFAULT_MIN_SECRET_LENGTH = 20

/**
 * Mask a secret for safe display in logs and findings. Long secrets show
 * first-4 + `***` + last-4; short secrets (< 8 chars) become all stars to
 * avoid revealing the whole value when the prefix would already give it
 * away. Empty input returns empty.
 *
 * Pure / deterministic — same input ⇒ same output.
 */
export const mask = (secret: string): string => {
  if (secret.length === 0) return ""
  if (secret.length < 8) return "*".repeat(secret.length)
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`
}
