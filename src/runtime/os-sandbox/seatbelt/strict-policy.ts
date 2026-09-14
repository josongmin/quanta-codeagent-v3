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
  /** OC-4 / S7 — narrow file-CONTENT reads to the workspace (+ extra read paths
   *  + a system allowlist), while keeping METADATA reads global so dyld/libsystem
   *  path probes still resolve (the reason the baseline reads globally). Without
   *  this the sandbox lets a command read `~/.ssh`, `~/.aws`, a sibling repo's
   *  `.env`, etc. Mirrors Cursor's WORKSPACE read boundary. DEFAULT-OFF.
   *
   *  NOTE (honesty): the emitted SBPL is runtime-UNVERIFIED here (no `sandbox-exec`
   *  in this environment); the shape uses documented seatbelt primitives
   *  (`file-read-metadata`, `file-read* (subpath …)`) and is asserted structurally.
   *  Opt-in operators should validate the system allowlist for their toolchain. */
  readonly readWorkspaceOnly?: boolean
}

/** System path prefixes whose CONTENT stays readable under `readWorkspaceOnly`
 *  (interpreters, shared libs, dyld cache, device nodes). Deliberately excludes
 *  `$HOME` so user secrets outside the workspace are not content-readable. */
export const READ_BOUNDARY_SYSTEM_SUBPATHS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/private/var/db/dyld",
  "/opt/homebrew",
  "/dev",
  "/etc",
]

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
  if (opts.readWorkspaceOnly === true) return false
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
