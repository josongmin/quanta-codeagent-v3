/**
 * Composite scanner (ADR-0164).
 *
 * Runs the pattern adapter THEN the entropy adapter; merges results so a
 * single (file, line, column) cell carries at most one finding — the pattern
 * one if both fire. The dedup ordering preserves the security guarantee that
 * a known-format secret (e.g. an AWS key) is never demoted to "generic high
 * entropy" just because the entropy adapter also catches it.
 *
 * Findings are returned sorted by (file, line, column) for stable downstream
 * rendering (CLI output, PR comment thread, JSON dump).
 */
import { readFile } from "node:fs/promises"
import { entropyScanner } from "./entropy-scanner"
import { patternScanner } from "./pattern-scanner"
import {
  DEFAULT_MAX_FINDINGS,
  type SecretFinding,
  type SecretScanner,
  type SecretScannerOpts,
  SecretScanReadError,
} from "./port"

/**
 * Stable key for the dedup map. Includes `file` so two findings at the same
 * line/column in different files do not collide.
 */
const dedupKey = (f: SecretFinding): string => `${f.file ?? ""}:${f.line}:${f.column}`

const compare = (a: SecretFinding, b: SecretFinding): number => {
  const fa = a.file ?? ""
  const fb = b.file ?? ""
  if (fa !== fb) return fa < fb ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  return a.column - b.column
}

const merge = (
  patternFindings: SecretFinding[],
  entropyFindings: SecretFinding[],
  max: number,
): SecretFinding[] => {
  const byKey = new Map<string, SecretFinding>()
  // Pattern findings populate first so the entropy pass below only inserts
  // when no pattern finding already occupies the cell.
  for (const f of patternFindings) {
    byKey.set(dedupKey(f), f)
  }
  for (const f of entropyFindings) {
    const k = dedupKey(f)
    if (!byKey.has(k)) byKey.set(k, f)
  }
  const merged = Array.from(byKey.values()).sort(compare)
  return merged.length > max ? merged.slice(0, max) : merged
}

export const compositeSecretScanner = (opts: SecretScannerOpts = {}): SecretScanner => {
  const pattern = patternScanner(opts)
  const entropy = entropyScanner(opts)
  const max = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  return {
    async scanText(text, scanOpts) {
      const [pf, ef] = await Promise.all([
        pattern.scanText(text, scanOpts),
        entropy.scanText(text, scanOpts),
      ])
      return merge(pf, ef, max)
    },
    async scanFile(path) {
      // Read once; feed both adapters via scanText. Avoids two disk reads
      // and guarantees both adapters see identical bytes (decode arms align).
      let text: string
      try {
        text = await readFile(path, "utf8")
      } catch (e) {
        // SECURITY (jun-10 finding #12): an unreadable file must NOT scan as
        // "clean" — `[]` is byte-identical to a genuinely clean file. Throw a
        // typed failure naming the path; `check_secrets` surfaces it as
        // ok:false. Binary tolerance is unaffected ("utf8" never throws on
        // weird bytes — it decodes with replacement chars).
        throw new SecretScanReadError(path, { cause: e })
      }
      const [pf, ef] = await Promise.all([
        pattern.scanText(text, { file: path }),
        entropy.scanText(text, { file: path }),
      ])
      return merge(pf, ef, max)
    },
  }
}
