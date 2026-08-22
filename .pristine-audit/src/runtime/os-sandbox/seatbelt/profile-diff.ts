/**
 * Per-line diff between two SBPL profile strings. Pure — used by hellgate
 * to make parity failures actionable and as a debug helper.
 */
export interface ProfileDiffEntry {
  readonly kind: "added" | "removed" | "changed"
  /** 1-based line number in `actual`. For `removed` entries this is the
   *  line number it would have occupied. */
  readonly line: number
  readonly expected?: string
  readonly actual?: string
}

export interface ProfileDiffResult {
  readonly equal: boolean
  readonly entries: ReadonlyArray<ProfileDiffEntry>
}

/**
 * Compute a line-aligned diff. The algorithm is positional (line N vs line N)
 * rather than LCS — the inputs are compiler outputs that share a fixed
 * skeleton, so reporting "line 12 changed" is more useful than a minimal
 * edit script. Trailing-newline difference counts as an added/removed
 * empty line.
 */
export const diffProfiles = (expected: string, actual: string): ProfileDiffResult => {
  if (expected === actual) return { equal: true, entries: [] }
  const exp = expected.split("\n")
  const act = actual.split("\n")
  const max = Math.max(exp.length, act.length)
  const entries: ProfileDiffEntry[] = []
  for (let i = 0; i < max; i++) {
    const e = exp[i]
    const a = act[i]
    if (e === a) continue
    if (e === undefined) {
      entries.push({ kind: "added", line: i + 1, actual: a as string })
      continue
    }
    if (a === undefined) {
      entries.push({ kind: "removed", line: i + 1, expected: e })
      continue
    }
    entries.push({ kind: "changed", line: i + 1, expected: e, actual: a })
  }
  return { equal: entries.length === 0, entries }
}

/** Human-readable formatter for diff entries (used in test failure messages). */
export const formatDiff = (result: ProfileDiffResult): string => {
  if (result.equal) return "(profiles equal)"
  return result.entries.map(formatEntry).join("\n")
}

const formatEntry = (e: ProfileDiffEntry): string => {
  if (e.kind === "added") return `+ L${e.line}: ${e.actual ?? ""}`
  if (e.kind === "removed") return `- L${e.line}: ${e.expected ?? ""}`
  return `~ L${e.line}: -${e.expected ?? ""} | +${e.actual ?? ""}`
}
