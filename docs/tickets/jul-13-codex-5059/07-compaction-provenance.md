# C5059-07 — Versioned compaction provenance over canonical session history

- **Priority:** Backlog
- **Class:** CONDITIONAL GAP
- **Effort:** M/L
- **Status:** NEED NOT PROVEN
- **Dependencies:** cross-restart/resume sessions plus observed stale-summary failure

## Problem

Quanta has proactive, reactive, manual, micro, background, salvage, breaker, and recent-summary archive behavior. The missing SOTA property is not another trigger. It is the ability to prove which canonical events produced a summary, under which authority/compactor contract, and to rebuild it after drift.

`ConversationSummaryArchive` is a bounded session-local recent window, not the event log of record. A `comp_hash` field alone can detect drift but cannot repair it after source events are gone.

## Reopen triggers

- resumed sessions use summaries produced under changed AGENTS/repo/system authority;
- compactor/model upgrades cause behavioral drift;
- a stale summary causes a wrong action or lost constraint;
- managed sessions must survive context resets or worker replacement.

## Design if reopened

Treat compacted context as a materialized projection of canonical session events. Each projection record carries:

```text
source_event_range
source_digest
compactor_contract_version
static_authority_digest
model_id
summary_digest
created_at
```

- `static_authority_digest` excludes dynamic date/time and other per-turn noise.
- Source events remain recoverable until the projection's retention contract expires.
- Mismatch produces a typed `stale` result and recompacts from canonical events.
- If source events are unavailable, fail closed to explicit degraded/resume-required state; do not silently trust the summary.
- Preserve tool-use/tool-result pairing and existing compaction breaker semantics.

## Acceptance if reopened

- Same source + contract produces deterministic digest/projection metadata.
- Authority or compactor version mutation marks the projection stale.
- Dynamic date/time changes do not cause false drift.
- A stale projection is rebuilt from canonical events and preserves active constraints.
- Missing canonical source cannot masquerade as a fresh projection.
- Existing compaction triggers and default-OFF behavior remain unchanged.

## Kill rule

If sessions remain finite and no compacted state crosses a restart/authority change, keep `comp_hash` as record-only backlog. Do not add an unrecoverable hash field for appearance of safety.

