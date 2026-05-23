/** Deterministic workspace-hash derivation for shadow ODB layout.
 *
 *  We hash the absolute workspace path with SHA-256 and take the first 16
 *  hex characters. 16 hex = 64 bits ⇒ ~1 in 2^32 collisions across ~4.3
 *  billion workspaces (the birthday bound). That is *vastly* over-budget
 *  for a single user's machine and keeps the on-disk directory name short
 *  enough to read at a glance:
 *
 *      ~/.quanta/snapshots/3a7f9c1b2e8d4a6b/
 *
 *  Determinism invariant: same absolute path ⇒ same hash. Different paths
 *  ⇒ different hashes (HELL-2/HELL-3 enforce this).
 *
 *  We use Node's `crypto.createHash` rather than `crypto.subtle.digest`
 *  because the latter is async + returns ArrayBuffer (an unnecessary
 *  await + hex-encoding dance for what is conceptually a pure function).
 *  The shadow-odb caller is already async, but using a sync hash makes
 *  the deterministic-from-path invariant trivial to assert in tests. */

import { createHash } from "node:crypto"

/** Length of the hex prefix used as the directory name. 16 hex = 64 bits. */
const HASH_PREFIX_LEN = 16

/** Hash a *normalized absolute* workspace path. Callers must hand us an
 *  already-resolved absolute path; we do not realpath here because the
 *  symlink-rejection invariant (HELL-8) needs to fire *before* the hash. */
export const workspaceHash = (absPath: string): string => {
  if (absPath.length === 0) {
    throw new Error("workspaceHash: empty path")
  }
  // Normalize trailing slash so `/foo` and `/foo/` collide deterministically.
  const canonical = absPath.endsWith("/") && absPath.length > 1 ? absPath.slice(0, -1) : absPath
  const h = createHash("sha256")
  h.update(canonical, "utf8")
  return h.digest("hex").slice(0, HASH_PREFIX_LEN)
}
