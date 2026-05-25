# ADR-0247: Codex agent nickname pool (39) + agent_role enum

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0030 (mid-turn steering, Codex SOTA foundation),
  ADR-0140 (background-subagent caller wire),
  Codex `core/src/config/agent_roles.rs` (nickname_candidates + agent_role),
  Memory note `codex-subagent-tools` (39 nickname pool + role enum),
  Memory note `codex-session-corpus-calibration` (subagent depth=1, fork=32%)

> **Note**: Renumbered from initial ADR-0246 once a parallel sibling
> landed at 0246. Catalog YAML and hellgate references all point to 0247.

## Context

Codex ships a closed `agent_role` enum (`explorer | worker | none`) and a
fixed 39-entry `nickname_candidates` pool that subagents are minted from
at `spawn_agent` time. The (nickname, role) pair becomes:

- the TUI label rendered next to the subagent's transcript chunk,
- the SQLite `threads.agent_nickname` / `threads.agent_role` columns
  (durable across compaction + fork), and
- a routing hint for the parent (the parent agent reads the role to decide
  what shape of result to wait for — `explorer` returns text, `worker`
  returns a typed artifact).

Production frequency (6,386 archived sessions, memory note
`codex-subagent-tools`):

| role       | share | typical use                         |
|------------|------:|-------------------------------------|
| `explorer` | 42%   | side-conversation, read-only probe |
| `none`     | 28%   | inline tool-call (no subagent)     |
| `worker`   | 16%   | mutating subagent, returns artifact|
| `reviewer` |  ~3%  | 3-tier reviewer (ADR-0029)         |

quanta currently spawns subagents (ADR-0140 background helper, ADR-0030
mid-turn steering, fork-session slice) WITHOUT a stable identity —
transcripts label them by raw thread-id (`thr_a3f8…`), which:

1. obscures the role/intent in audit transcripts ("which thread was the
   read-only probe vs the mutating worker?"),
2. prevents the parent from carrying a typed `agent_role` hint into the
   policy layer (currently the role check has to be re-derived from the
   spawn args every time), and
3. forces ad-hoc nickname generators in tests (each test invents its own
   string, which then collides under parallel runs).

A closed 39-entry pool with collision-free minting + release-on-done is a
small, plane-clean primitive that unlocks all three.

## Decision

Introduce a new slice `src/agent/identity-pool/` (sibling to the
ADR-0198 `identity/` slice — they are intentionally separate: `identity`
is per-MODE 1-line system-prompt content, `identity-pool` is
per-SUBAGENT-INSTANCE name + role tag):

```
src/agent/identity-pool/
  types.ts             — AgentRole 4-arm + AgentNickname literal union 39
  port.ts              — IdentityMinter port + MintError + ReleaseError
  nickname-table.ts    — frozen 39-entry array (mathematicians/CS pioneers)
  default-minter.ts    — round-robin + collision-free + release-on-done
  index.ts             — slice barrel
```

### `AgentRole` (4-arm closed enum)

```ts
export type AgentRole = "explorer" | "worker" | "reviewer" | "none"
```

`reviewer` is added beyond Codex's 3-arm (which only has explorer/worker/
none) because quanta has a first-class 3-tier reviewer (ADR-0029) that
spawns its own subagent in tier-3 mode.

### `AgentNickname` literal union (39 entries)

The pool is a frozen `readonly [N1, N2, …, N39]` of computer-science +
mathematics pioneers. Source rationale (memory note
`codex-subagent-tools` referenced a `nickname_candidates` field but the
upstream Codex binary did not ship the strings inline — falling back to
the 39 documented in the memory note's "거장 39명" alternative). The
pool order is the deterministic round-robin order; tests pin the order.

### `IdentityMinter` port (closed surface)

```ts
interface IdentityMinter {
  mint(role: AgentRole): MintedIdentity      // throws MintError on exhaust
  release(nickname: AgentNickname): void     // throws ReleaseError on unknown
  inUse(): ReadonlySet<AgentNickname>
}

interface MintedIdentity {
  readonly nickname: AgentNickname
  readonly role: AgentRole
}
```

- `mint("none")` returns `{ nickname: "__none__" , role: "none" }` and
  does NOT consume a pool slot — `none` is the "inline tool-call, no
  subagent identity" sentinel that mirrors Codex's 28% production share.
- `mint("explorer" | "worker" | "reviewer")` advances a round-robin
  cursor across the 39-entry pool, skipping entries currently `inUse()`.
- `release(nickname)` is REQUIRED for the slot to return to the pool —
  no GC, no soft-release. `release("__none__")` is a no-op.
- Pool exhaustion (39 concurrent in-use slots) throws `MintError`. The
  scheduler is expected to bound concurrent subagents far below 39; the
  hellgate locks the explicit-throw contract so callers cannot silently
  re-use a name.

### `default-minter.ts`

Round-robin starts at index 0 and probes forward, wrapping once. The
cursor is internal state — a fresh `createDefaultIdentityMinter()` always
starts at index 0, so test runs are deterministic.

## Consequences

- **Default-OFF byte-identical**: no caller is required to migrate. The
  ADR-0140 background-subagent helper, ADR-0030 mid-turn steering, and
  fork-session slice continue to thread raw thread-ids until a follow-up
  ADR wires the minter into the spawn path. The hellgate locks the
  no-side-effect contract: importing the barrel does NOT mint anything.
- **No persistence**: the minter is process-local. A new process starts
  with a fresh pool. This matches Codex's pattern — the durable name
  lives in the `threads.agent_nickname` SQLite column (out-of-scope for
  this ADR), the minter is the source-of-truth only for THIS process's
  collision-avoidance.
- **No filesystem / no clock / no IO**: pure data structure. Tests pass
  no fixtures.
- **Role-routing seam ready**: once a follow-up ADR wires
  `MintedIdentity` into `BackgroundSubagentScheduler` (ADR-0140) and the
  fork-session port, the parent's policy layer can branch on
  `mintedIdentity.role` without re-parsing spawn args.

## Negative invariants (locked by hellgate)

- HELL-IP-01: `mint(role)` returns `{nickname, role}` shape
- HELL-IP-02: two consecutive `mint("explorer")` calls return DISTINCT nicknames
- HELL-IP-03: `release(nickname)` returns the slot — next `mint()` may pick it up again
- HELL-IP-04: 40 mints (or 39 mints + 1 more, accounting for "__none__") throws `MintError`
- HELL-IP-05: `release(<never-minted>)` throws `ReleaseError`
- HELL-IP-06: `inUse()` set reflects exactly the currently held nicknames
- HELL-IP-07: `AgentRole` 4-arm exhaustive (compile-time switch lock)
- HELL-IP-08: pool has exactly 39 unique entries
- HELL-IP-09: every pool entry is narrowable to the `AgentNickname` literal union
- HELL-IP-10: round-robin is deterministic from a fresh minter
- HELL-IP-11: 39 sequential mints (single minter) all return distinct nicknames
- HELL-IP-12: barrel import has no side effects (no mint, no shared state)
- HELL-IP-13: `mint("none")` returns the `"__none__"` sentinel WITHOUT consuming a pool slot
- HELL-IP-14: 1000 mint→release cycles do not leak (`inUse()` stays bounded)
- HELL-IP-15: `release("__none__")` is a no-op (does not throw, does not affect pool)
