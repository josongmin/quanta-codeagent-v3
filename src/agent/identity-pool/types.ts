/**
 * Identity-pool primitive types (ADR-0247).
 *
 * Closed enums for the per-subagent-instance identity:
 *
 *   - `AgentRole` — 4-arm routing hint (explorer | worker | reviewer | none).
 *   - `AgentNickname` — literal union over the frozen 39-entry pool plus the
 *     `"__none__"` sentinel (returned by `mint("none")` without consuming a
 *     pool slot).
 *
 * The literal union is intentionally NOT derived from the runtime array via
 * `typeof NICKNAME_TABLE[number]` because that would couple `types.ts` to
 * `nickname-table.ts` and make a stale typo in the table silently widen the
 * union. The union below is the source-of-truth; the table is asserted to
 * match it at construction time (HELL-IP-09).
 */

/** Subagent routing role. 4-arm closed enum (HELL-IP-07 locks exhaustiveness).
 *
 *   - `"explorer"` — read-only probe / side-conversation (42% production share).
 *   - `"worker"`   — mutating subagent, returns a typed artifact (16% share).
 *   - `"reviewer"` — 3-tier reviewer (ADR-0029, ~3% share).
 *   - `"none"`     — inline tool-call, no subagent identity (28% share).
 */
export type AgentRole = "explorer" | "worker" | "reviewer" | "none"

/** Frozen 39-entry nickname pool, plus the `"__none__"` sentinel for
 *  `mint("none")`. The order is the deterministic round-robin order (tests
 *  pin it). Pool entries are mathematicians / CS pioneers — Codex's upstream
 *  binary did not ship its `nickname_candidates` strings inline; this is
 *  the documented fallback from memory note `codex-subagent-tools`. */
export type AgentNickname =
  | "__none__"
  | "Euler"
  | "Gauss"
  | "Turing"
  | "Knuth"
  | "Dijkstra"
  | "Hopper"
  | "Lovelace"
  | "Church"
  | "Curry"
  | "Hoare"
  | "Backus"
  | "McCarthy"
  | "Minsky"
  | "Shannon"
  | "Wirth"
  | "Liskov"
  | "Goldwasser"
  | "Karp"
  | "Cook"
  | "Hamming"
  | "Kleene"
  | "Tarski"
  | "Godel"
  | "Cantor"
  | "Riemann"
  | "Noether"
  | "Erdos"
  | "Ramanujan"
  | "Fermat"
  | "Leibniz"
  | "Newton"
  | "Boole"
  | "Babbage"
  | "Pascal"
  | "Fibonacci"
  | "Diffie"
  | "Hellman"
  | "Rivest"
  | "Shamir"

/** Result of a successful `mint()` call. */
export interface MintedIdentity {
  readonly nickname: AgentNickname
  readonly role: AgentRole
}

/** The `"__none__"` sentinel returned by `mint("none")`. Exported so tests
 *  and downstream callers can reference it without re-typing the literal. */
export const NONE_NICKNAME = "__none__" as const satisfies AgentNickname
