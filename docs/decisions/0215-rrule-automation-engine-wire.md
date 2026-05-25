# ADR-0215: RRULE automation engine wire (Codex 3-table schema)

- Status: Accepted
- Date: 2026-05-25
- Renumbered: from initially-drafted ADR-0203 (collision with
  `0203-typed-error-enum-16-routing.md` /
  `0203-subagent-mode-typed-delegation.md` /
  `0203-user-authored-playbook-frontmatter.md` — all landed by parallel
  agents). Per the user-deference renumber policy
  ([[adr-collision-policy-2026-05-25]]) ours moves to next-free 0215.
- Related: ADR-0161 (Scheduled Agent Phase A — RRULE parser + JSONL store +
  runtime), ADR-0132 (reactor `manual_resume` seam — same agent-loop port).

## Context

R1 verify reported ADR-0161 "Phase A complete" but only the parser +
JSONL store + runtime existed; there was no engine seam encapsulating
the `(schedule, list, cancel, next, markRun)` 5-verb surface, and no
`inbox_items` notification table. The host could load JSONL automations
and call `tickOnce()` but had no Codex-parity persistence story for
`automation_runs` (per-fire audit) or `inbox_items` (host-facing inbox
UI surface).

Codex's production reference (`~/.codex/sqlite/codex-dev.db`, observed
in `docs/reviews-codex-agent/thread-management/storage-and-db-audit.md`):

- `automations` (id PK, name, prompt, status, next_run_at, last_run_at,
  rrule, model, model_fallbacks, last_error, created_at, fire_count)
- `automation_runs` (id PK, automation_id, fired_at, outcome,
  error_message)
- `inbox_items` (id PK, automation_id, title, summary, created_at,
  read, archived_*)

This is the missing engine seam for our scheduler. The Phase A JSONL
store is fine for a single-workspace dev path (append-only, simple),
but the inbox + per-fire audit live in SQLite to support host-UI
queries (`unread inbox count`, `runs in the last 24 h per automation`).

## Decision

Introduce `AutomationEnginePort` — a 5-verb closed seam — in the
`@/scheduler/automation-engine` sub-slice with two adapters:

- **`inMemoryAutomationEngine()`** — zero-dep reference (tests / hosts
  that opt out of persistence). Inspectable `runs` + `inbox` arrays
  for hellgate verification.
- **`sqliteAutomationEngine(db)`** — wraps an open `bun:sqlite`
  `Database` and migrates the 3 tables idempotently
  (`ensureAutomationEngineSchema`). `markRun` writes all 3 tables in a
  single SQLite transaction so an inbox row never lands without a
  matching automation update.

A pure `tickScheduler({ engine, now, handler, inbox? })` function is
the testable atomic — one fire per call, NO-THROW (handler exceptions
become `kind:"errored"` outcomes; the row records `lastError`). The
sibling `runtime.ts` (Phase E) keeps its `setInterval`-driven loop;
this ADR adds the engine seam under it (Phase E remains free to use
either the existing JSONL store OR an `AutomationEnginePort`-backed
adapter once the host wires it).

### Schema

```sql
CREATE TABLE automations (
  id TEXT PK, title TEXT, rule_json TEXT, prompt TEXT,
  next_run_at INTEGER, last_run_at INTEGER, status TEXT,
  last_error TEXT, created_at INTEGER, fire_count INTEGER
);
CREATE TABLE automation_runs (
  id TEXT PK, automation_id TEXT, fired_at INTEGER,
  outcome TEXT, error_message TEXT
);
CREATE TABLE inbox_items (
  id TEXT PK, automation_id TEXT, title TEXT, summary TEXT,
  created_at INTEGER, read INTEGER
);
```

Default DB path (when the host opts in): `~/.quanta/sqlite/automations.db`.
The adapter does NOT open the file — the host supplies the `Database`
handle, so tests pass `:memory:` and prod resolves the path itself.

### Invariants

- **NO-THROW public surface** — every port method returns
  `EngineResult<T>` (closed discriminated union). Callers branch on
  `ok:false` rather than catch.
- **exactOptionalPropertyTypes** — `lastRunAt`, `lastError`,
  `errorMessage` keys are OMITTED when absent (never `field:
  undefined`); test [14] enforces.
- **Default-OFF** — importing `@/scheduler/automation-engine` opens
  zero connections / creates zero tables. The host wires explicitly.
- **Atomicity** — `markRun` is a 3-table transaction on the SQLite
  adapter (rollback on failure). Tested by [13].
- **Cancel is idempotent** — re-cancelling an already-cancelled row
  AND cancelling a missing id both return `{ok:true}`. Tested by [3].
- **`markRun` on missing/cancelled id → `not-found`** — loud divergence
  signal (ticker should never reach a cancelled row). Tested by [6].

## Consequences

Positive:
- Closes the R1 false-positive: ADR-0161 is now genuinely wireable
  end-to-end (the host swaps in the engine adapter and the existing
  runtime composes against it).
- Inbox surface unblocks a future host-UI "what fired while I was
  away?" view without re-running the rule evaluator.
- Per-fire audit trail (`automation_runs`) enables debug runbooks like
  "this automation has fired 47 times in the last day — why?".

Trade-offs:
- The existing `defaultJsonlAutomationStore` and the new
  `sqliteAutomationEngine` coexist — they're different ports. Hosts
  must pick one or the other; the runtime (Phase E) currently uses
  the JSONL port. A follow-up will let the runtime accept either port
  via adapter (one-line change in `processAutomation`).
- 3-table SQLite migration adds disk write surface — but the path is
  default-OFF, so legacy callers see zero impact.

Negative invariants (NOT violating):
- We don't touch `runtime.ts` / `next-fire.ts` / `automation.ts` /
  `store-jsonl.ts` (Phase A code) — the engine slice is purely
  additive.
- We don't introduce a new RRULE evaluator — `tickScheduler`
  reuses `computeNextFire` from the existing `next-fire.ts`.

## Validation

- 15 hellgate cases in `tests/unit/automation-engine-hellgate.test.ts`
  covering: schedule/list/cancel/next/markRun semantics, sqlite parity,
  3-table atomicity, ticker idle/fired/errored arms, exactOptional
  omission, cancelled-row exclusion.
- All 15 pass; tsc 0 / biome 0 in the new slice.
