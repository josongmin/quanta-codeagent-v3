/**
 * Secret-detection barrel (ADR-0164 + ADR-0173). Public surface for callers (a
 * future `secret_scan` tool, a pre-commit hook, a CI gate). Nothing in the
 * dispatch or loop seam imports this — default-OFF until a caller opts in.
 *
 * Adapter choice:
 *   - {@link secretlintScanner} — recommended; backed by the canonical
 *     `secretlint` library (vendor-maintained rules for AWS/Anthropic/OpenAI/
 *     GCP/GitHub/Slack/Stripe/PEM + a dozen more). Async surface.
 *   - {@link patternScanner} / {@link entropyScanner} /
 *     {@link compositeSecretScanner} — zero-dep fallbacks that keep the same
 *     awaitable port shape with a narrower catalog.
 */
export { compositeSecretScanner } from "./composite-scanner"
export { entropyScanner, shannonEntropyBits } from "./entropy-scanner"
export { patternScanner } from "./pattern-scanner"
export {
  DEFAULT_SECRETLINT_CONFIG,
  secretlintScanner,
  type SecretlintScannerOpts,
} from "./secretlint-scanner"
export {
  DEFAULT_ENTROPY_THRESHOLD_BITS_PER_CHAR,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MIN_SECRET_LENGTH,
  mask,
  type SecretFinding,
  type SecretKind,
  type SecretScanTextOpts,
  type SecretScanner,
  type SecretScannerOpts,
} from "./port"
