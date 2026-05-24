/**
 * Composite PII scanner (ADR-0171).
 *
 * Owns the policy decisions the pattern scanner deliberately delegates:
 *
 *   - **Credit-card Luhn validation.** A 16-digit run can be an order ID, a
 *     hash prefix, or a phone-number concatenation. We pre-filter every
 *     credit-card pattern match with the Luhn checksum; only valid matches
 *     become findings. Invalid → dropped (high FP suppression).
 *   - **Overlapping range resolution.** Two patterns can match overlapping
 *     spans (an IBAN-like prefix inside a longer alphanumeric run, an
 *     ipv4-shaped substring inside a longer digit-dot sequence). We resolve
 *     longest-range-wins; on equal length, lower-start-index wins. This is
 *     the documented contract from the slice spec.
 *   - **`redactText` splicing.** Replacements happen in start-DESC order so a
 *     placeholder of different length never shifts the offsets of remaining
 *     findings. Equivalent to a single immutable `String.replaceAll` over
 *     all findings, but offset-stable for callers that want to feed the
 *     output back into another offset-aware tool.
 */
import { isLuhnValid } from "./luhn-validator"
import { runPatterns } from "./pattern-scanner"
import { ALL_PII_KINDS, type PiiFinding, type PiiScanner, type PiiScannerOpts } from "./port"

/**
 * Strip every non-digit from a candidate string. Used for Luhn — the regex
 * permits `4111-1111-1111-1111` and `4111 1111 1111 1111`; Luhn needs the
 * digit-only form.
 */
const digitsOnly = (s: string): string => s.replace(/\D+/g, "")

/**
 * Drop invalid credit-card findings via Luhn. Other kinds pass through.
 */
const luhnFilter = (findings: PiiFinding[]): PiiFinding[] => {
  const kept: PiiFinding[] = []
  for (const f of findings) {
    if (f.kind === "credit-card") {
      const digits = digitsOnly(f.raw)
      if (digits.length < 13 || digits.length > 19) continue
      if (!isLuhnValid(digits)) continue
    }
    kept.push(f)
  }
  return kept
}

/**
 * Resolve overlapping ranges. For any pair of findings whose spans intersect,
 * the longer one wins; ties broken by lower `start`. Implementation is
 * O(n log n) sort + O(n) sweep: once kept findings are start-sorted and
 * non-overlapping, a new candidate can only overlap the current kept tail.
 * Exact-span ties preserve original pattern discovery order.
 *
 * Returns findings in start-ASC order (stable for downstream consumers /
 * tests). `redactText` re-sorts to start-DESC for splicing.
 */
const dedupOverlaps = (findings: PiiFinding[]): PiiFinding[] => {
  const sorted = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      if (a.finding.start !== b.finding.start) {
        return a.finding.start - b.finding.start
      }
      const la = a.finding.end - a.finding.start
      const lb = b.finding.end - b.finding.start
      if (la !== lb) return lb - la
      return a.index - b.index
    })
  const kept: PiiFinding[] = []
  let current: PiiFinding | undefined
  for (const { finding } of sorted) {
    if (current === undefined) {
      current = finding
      continue
    }
    if (finding.start >= current.end) {
      kept.push(current)
      current = finding
      continue
    }
    const flen = finding.end - finding.start
    const clen = current.end - current.start
    if (flen > clen) {
      current = finding
    }
  }
  if (current !== undefined) {
    kept.push(current)
  }
  return kept
}

/**
 * Splice findings into `text`, replacing each `raw` span with its `redacted`
 * placeholder. Start-DESC order so offsets stay valid for the next splice.
 *
 * Pre-conditions:
 *   - findings are non-overlapping (caller ran {@link dedupOverlaps}).
 *   - 0 ≤ start ≤ end ≤ text.length for every finding.
 */
const spliceRedactions = (text: string, findings: PiiFinding[]): string => {
  if (findings.length === 0) return text
  const desc = [...findings].sort((a, b) => b.start - a.start)
  let out = text
  for (const f of desc) {
    out = out.slice(0, f.start) + f.redacted + out.slice(f.end)
  }
  return out
}

/**
 * Construct a composite PII scanner. Returned object is a fresh instance per
 * call — no shared mutable state across calls — so callers can hold multiple
 * configurations in parallel.
 */
export const compositePiiScanner = (opts: PiiScannerOpts = {}): PiiScanner => {
  const kinds = opts.kinds ?? ALL_PII_KINDS
  const allow = new Set(opts.allowlist ?? [])
  const templateOverrides = opts.redactionTemplate ?? {}

  const scan = (text: string): PiiFinding[] => {
    const raw = runPatterns(text, kinds, allow, templateOverrides)
    const luhn = luhnFilter(raw)
    return dedupOverlaps(luhn)
  }

  return {
    scanText(text) {
      return scan(text)
    },
    redactText(text) {
      return spliceRedactions(text, scan(text))
    },
  }
}
