/**
 * `tools/dev/repository-identity` — one spelling of "which repository is this".
 *
 * Its own module so the quarantine can key its slot by the SAME normalised
 * identity the lease gate uses, without `lease-quarantine.ts` importing
 * `test-shard-lease.ts`, which already imports it. A raw-keyed writer and a
 * normalising reader would otherwise meet at two different slots.
 */

/** Normalize SSH aliases and HTTPS remotes to the same owner/repository key. */
export const normalizeRepositoryIdentity = (remote: string): string => {
  const value = remote.trim().replace(/\.git$/, "")
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(value)
  return match?.[1] ?? value
}
