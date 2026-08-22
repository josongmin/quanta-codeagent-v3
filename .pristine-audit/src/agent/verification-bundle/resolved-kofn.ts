import type { ResolvedKofNSignal } from "./types"

export const isValidResolvedKofN = (resolved: ResolvedKofNSignal): boolean =>
  Number.isInteger(resolved.votes) &&
  Number.isInteger(resolved.k) &&
  resolved.votes >= 0 &&
  resolved.k > 0

export const resolvedKofNPositive = (resolved: ResolvedKofNSignal | null): boolean =>
  resolved !== null && isValidResolvedKofN(resolved) && resolved.votes >= resolved.k

export const resolvedKofNVoterQuorum = (resolved: ResolvedKofNSignal | null): number | null =>
  resolved !== null && isValidResolvedKofN(resolved) ? resolved.votes / resolved.k : null
