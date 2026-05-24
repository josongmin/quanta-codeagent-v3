/**
 * Strict knobs that tighten the Codex baseline profile. All default `false`.
 * When every knob is absent / `false`, the compiler output is byte-identical
 * to the pre-ADR-0199 baseline (locked by HELL-SB-05).
 *
 * Knobs only TIGHTEN — never widen. `denyNetworkAlways` overrides a profile
 * that says allow; there is no "force-allow" sibling.
 */
export interface StrictKnobs {
  /** Add `(deny process-fork)` after the baseline allow. Effective deny. */
  readonly denyForkAdditional?: boolean
  /** Force `(deny network*)` even when the profile / `allowNetwork` allows. */
  readonly denyNetworkAlways?: boolean
  /** Add `/private/tmp` to the write subpath list. */
  readonly allowTmpWrite?: boolean
  /** Suppress an absolute-`/` metadata read allow (forward-compat guard;
   *  the current baseline does not emit such a line, so this knob is a
   *  no-op until a future arm does). */
  readonly denyMetadataReadAbsolute?: boolean
}

/**
 * Returns true when every knob is absent or false — the "no strict
 * adjustment" case the byte-identical invariant locks.
 */
export const isDefaultStrict = (opts: StrictKnobs | undefined): boolean => {
  if (opts === undefined) return true
  if (opts.denyForkAdditional === true) return false
  if (opts.denyNetworkAlways === true) return false
  if (opts.allowTmpWrite === true) return false
  if (opts.denyMetadataReadAbsolute === true) return false
  return true
}

/**
 * Splice strict-knob lines into a baseline-compiled profile string.
 * Pure function. Input is the byte-identical baseline output; output
 * is the strict-adjusted profile.
 *
 * The splice is positional rather than text-rewrite: we operate on
 * the line array so the result is deterministic and trivially diff-able.
 */
export const applyStrictKnobs = (baseline: string, opts: StrictKnobs): string => {
  if (isDefaultStrict(opts)) return baseline
  const lines = baseline.split("\n")

  if (opts.denyForkAdditional === true) {
    insertAfter(lines, "(allow process-fork)", "(deny process-fork)")
  }

  if (opts.denyNetworkAlways === true) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "(allow network*)") lines[i] = "(deny network*)"
    }
  }

  if (opts.allowTmpWrite === true) {
    spliceTmpWrite(lines)
  }

  // denyMetadataReadAbsolute: baseline doesn't emit this; future-compat no-op.

  return lines.join("\n")
}

const insertAfter = (lines: string[], anchor: string, inserted: string): void => {
  const idx = lines.indexOf(anchor)
  if (idx < 0) return
  lines.splice(idx + 1, 0, inserted)
}

/**
 * Find the existing write line (or absence thereof) and add `/private/tmp`.
 * - If a `(allow file-write* (subpath …))` line exists, append the tmp subpath.
 * - If no write line exists (read-only profile + allowTmpWrite), insert a
 *   new write line before the network line. This is the only case where
 *   `allowTmpWrite` widens a read-only profile, by explicit caller intent.
 */
const spliceTmpWrite = (lines: string[]): void => {
  const writeIdx = lines.findIndex((l) => l.startsWith("(allow file-write* (subpath"))
  const tmpFrag = '(subpath "/private/tmp")'

  if (writeIdx >= 0) {
    const cur = lines[writeIdx]
    if (cur === undefined) return
    if (cur.includes(tmpFrag)) return
    lines[writeIdx] = cur.replace(/\)$/, ` ${tmpFrag})`)
    return
  }

  const netIdx = lines.findIndex((l) => l === "(deny network*)" || l === "(allow network*)")
  const writeLine = `(allow file-write* ${tmpFrag})`
  if (netIdx >= 0) {
    lines.splice(netIdx, 0, ";; strict: allowTmpWrite", writeLine)
  } else {
    lines.push(";; strict: allowTmpWrite", writeLine)
  }
}
