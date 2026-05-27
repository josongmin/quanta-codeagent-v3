# ADR-0355 — Cross-machine session-registry replication — Negative

Status: Accepted (negative decision — defer until concrete deployment trigger)
Date: 2026-05-27

## Context

ADR-0348 ships disk-persistent jsonl backend. ADR-0353 adds multi-process
flock (single-machine safety). ADR-0354 adds sqlite backend with WAL. A
natural extension is "two quanta processes on different machines sharing
session state via NFS / SMB / cluster-fs mount".

## Investigation

Surveyed: deployment patterns referenced in `quanta-v3-state` (single-
user CLI primary), web-daemon ADR-0315 (single-process Bun.serve),
scheduled-agent ADR-0161 (single-process), bench harness (single
process). All current quanta surfaces are single-machine. No memory entry
or recent commit references multi-machine deployment.

`grep -rn "NFS\|SMB\|cluster.*fs\|cross.machine\|distributed" docs/ src/`
returns 0 production references (only this ADR plus negative-decision
notes from ADR-0344).

## Decision

**Defer until a concrete trigger.** Do NOT implement cross-machine
replication. The infrastructure cost (file locking semantics across
NFS lease, lock-recovery on lease expiry, conflict resolution under
clock skew, schema replication when ADR-0354 sqlite ships) is large and
no current consumer needs it.

## Re-open triggers

Any ONE of the following warrants re-opening this ADR with a fresh
implementation ADR superseding it:

1. **Deployment model adds a second machine** — clustered web-daemon, or
   multi-machine bench fleet, or cross-host scheduled-agent farm.
2. **A real user requests session-resume across machines** — current
   session-registry semantics (event log, system-prompt cache) become
   user-visible when the user wants "switch from desktop to laptop and
   continue".
3. **Codex / Cursor / Claude Desktop ships a cross-machine pattern** —
   absorption mandate (`implementation-baseline-from-competitors` memory)
   pulls us in.

## Implementation sketch (for the future ADR)

If/when triggered:

- **Phase 1 — single-writer cross-machine.** ADR-0353 lockfile pattern
  extended with NFS-safe atomic O_EXCL (Linux NFS ≥v3, see
  `nfs-utils-strict-atime`). Lease expiry on the lockfile (re-create
  every ~5s while held) so a crashed remote machine does not stall
  others forever.
- **Phase 2 — multi-writer event replication.** Append-only event log
  (ADR-0348 jsonl is already append-only) gets a `machine_id` column.
  ADR-0354 sqlite version needs a CRDT layer (e.g. last-writer-wins on
  `last_touched`) — out of scope for the Phase-1 sketch.
- **Phase 3 — cache replication.** System-prompt cache (ADR-0326) is
  immutable per key, so cross-machine sharing is safe under content
  hash. Different `cacheKey` per machine (sessionId-derived) means each
  machine builds + caches independently — no replication needed at all
  for the cache layer.

## Non-goals

- This ADR ships NO code. The `storageDir` parameter on ADR-0348 already
  accepts a network mount path — operators can experiment with that
  configuration today but receive NO guarantees from quanta about
  multi-writer safety or lease semantics.
- This ADR does NOT supersede ADR-0353 (single-machine flock). Local
  multi-process safety remains in scope.

## References

- ADR-0344 (negative — provider wm-live) — same "defer without a trigger"
  pattern.
- ADR-0348, ADR-0353, ADR-0354 — single-machine persistence stack.
- memory `no-heuristics-only-validated` — drove the deferral.
- memory `codex-logs-retention-pattern` — Codex's sqlite is local-only.
