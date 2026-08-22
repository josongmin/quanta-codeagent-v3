/**
 * PMX-00 pinned-selector guards — "no fallback to `main`, `latest`, or an
 * unverified local file".
 *
 * These THROW rather than returning a default. The whole failure class this
 * ticket exists to prevent is a helpful default quietly resolving a moving ref
 * and producing an untracked hybrid, so "absent" must be loud at the call site.
 */

/** A pinned object name: exactly 40 hex characters (a full git/HF commit sha). */
const PINNED_COMMIT = /^[0-9a-f]{40}$/

export const isPinnedCommit = (raw: string | undefined): boolean =>
  raw !== undefined && PINNED_COMMIT.test(raw.trim().toLowerCase())

/**
 * Return the normalized pinned commit, or THROW naming `field`. Anything that
 * is not a full 40-hex sha is refused: branch names (`main`), tags (`v2`),
 * `HEAD`, `latest`, and abbreviated shas alike — an abbreviation is not an
 * immutable identifier.
 */
export const requirePinnedCommit = (raw: string | undefined, field: string): string => {
  const norm = (raw ?? "").trim().toLowerCase()
  if (norm === "") {
    throw new Error(
      `promax provenance: \`${field}\` is absent or blank. ` +
        "REFUSING to resolve a default — pin a full 40-hex commit sha.",
    )
  }
  if (!PINNED_COMMIT.test(norm)) {
    throw new Error(
      `promax provenance: \`${field}\` is "${raw}", which is not a pinned 40-hex commit. ` +
        "Moving refs (main/master/HEAD/latest), tags, and abbreviated shas are REFUSED — " +
        "they would let upstream change under a frozen campaign.",
    )
  }
  return norm
}

/**
 * Return an explicitly supplied bundle root, or THROW. There is deliberately no
 * search path, no `~/.quanta` default, and no "most recent bundle" — an
 * operator must name the frozen bundle they mean.
 */
export const requireExplicitBundleRoot = (raw: string | undefined): string => {
  const norm = (raw ?? "").trim()
  if (norm === "") {
    throw new Error(
      "promax provenance: no bundle root supplied. " +
        "REFUSING to search for or download a bundle — pass an explicit, already-verified bundle root.",
    )
  }
  return norm
}
