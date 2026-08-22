/**
 * Frozen 39-entry nickname pool (ADR-0247).
 *
 * The order is the deterministic round-robin order. The literal-union narrowing
 * (`AgentNickname` in `./types`) is asserted at module load via `satisfies` —
 * a typo or a missing/extra entry surfaces as a tsc error, not at runtime.
 *
 * HELL-IP-08 locks the count (exactly 39). HELL-IP-09 locks that every entry
 * is in the `AgentNickname` union (the `satisfies` clause + the hellgate's
 * runtime cross-check together cover the foot-gun where someone reorders the
 * array but forgets to update the union).
 */

import type { AgentNickname } from "./types"

/** The 39 pool entries (excludes the `"__none__"` sentinel). Order = round-
 *  robin order. Frozen at module load so callers cannot mutate the table. */
export const NICKNAME_TABLE = Object.freeze([
  "Euler",
  "Gauss",
  "Turing",
  "Knuth",
  "Dijkstra",
  "Hopper",
  "Lovelace",
  "Church",
  "Curry",
  "Hoare",
  "Backus",
  "McCarthy",
  "Minsky",
  "Shannon",
  "Wirth",
  "Liskov",
  "Goldwasser",
  "Karp",
  "Cook",
  "Hamming",
  "Kleene",
  "Tarski",
  "Godel",
  "Cantor",
  "Riemann",
  "Noether",
  "Erdos",
  "Ramanujan",
  "Fermat",
  "Leibniz",
  "Newton",
  "Boole",
  "Babbage",
  "Pascal",
  "Fibonacci",
  "Diffie",
  "Hellman",
  "Rivest",
  "Shamir",
] as const satisfies readonly AgentNickname[])

/** Pool size — derived from the table so adding/removing an entry is a
 *  single-source change. The hellgate asserts this is exactly 39. */
export const POOL_SIZE: number = NICKNAME_TABLE.length

// Drift guard: `satisfies` proves table⊆union; this Assert proves the REVERSE
// for every REAL nickname — i.e. every AgentNickname EXCEPT the `"__none__"`
// sentinel (which is deliberately not a pool entry) must be in the table. The
// header's "hellgate asserts exactly 39" is unanchored (no test references
// NICKNAME_TABLE), so this is the real guard: add a nickname to the union,
// forget the table → build error; the sentinel stays correctly excluded.
type _AssertNick<T extends true> = T
export type _NicknameTableDriftGuard = _AssertNick<
  Exclude<AgentNickname, "__none__"> extends (typeof NICKNAME_TABLE)[number] ? true : false
>
