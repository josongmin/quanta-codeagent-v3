/**
 * `tools/dev/repository-identity` — one spelling of "which repository is this".
 *
 * Its own module so the quarantine can key its slot by the SAME normalised
 * identity the lease gate uses, without `lease-quarantine.ts` importing
 * `test-shard-lease.ts`, which already imports it. A raw-keyed writer and a
 * normalising reader would otherwise meet at two different slots.
 */

/** Normalize SSH aliases and HTTPS remotes to the same owner/repository key. */
const normalizeOnce = (remote: string): string => {
  const value = remote.trim().replace(/\.git$/, "")
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(value)
  return match?.[1] ?? value
}

export const normalizeRepositoryIdentity = (remote: string): string => {
  // IDEMPOTENT, and an arm holds it to that: the quarantine writer normalises
  // once and the slot path normalises again, so `x.git.git` or a match with a
  // leading space was filed under a key its own slot did not hash to.
  //
  // The FIXED POINT of the original one-step transform, not a new transform. A
  // rewrite that also stripped trailing slashes moved the hashed port of every
  // identity that ended in one — two checkouts on the old and new code would have
  // run in parallel. Iterating changes only the inputs that were not already
  // stable, which are exactly the ones that were misfiled.
  let current = remote
  for (let step = 0; step < 8; step += 1) {
    const next = normalizeOnce(current)
    if (next === current) return current
    current = next
  }
  return current
}
