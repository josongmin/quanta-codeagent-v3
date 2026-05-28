# ADR-0395 — Run Ledger: unified long-running-work state model

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/run-ledger/` (new: `types.ts` + `store.ts` + `index.ts`) + hellgate
**Default-OFF:** Yes — pure new slice, imported by nobody. Importing the barrel
touches no process state and pulls in zero peer slices. This wave is
**MODEL-ONLY**; wave 2 adapts bash/subagent/mcp to report INTO this ledger.

## Context

quanta models long-running work in **three disjoint ways**, none of which a UI
can read uniformly:

1. **Shell-detached** — `{ shellId, status: "running" }`, resumed via
   `bash_await` / `bash_kill`.
2. **Subagent background** — `TaskRegistry` with
   `TaskStatus = running|completed|failed|stopped`, resumed via `task_output` /
   `task_stop`.
3. **MCP tasks** — a poller over MCP task ids.

Each lives in its own slice with its own status vocabulary, its own id scheme,
and its own resume verb. A surface (CLI status bar, web/Tauri panel) that wants
to answer *"what is in flight, what is waiting on me, what just finished?"* has
to reach into three slices and reconcile three incompatible shapes. That
fragmentation is the UX gap this ADR closes.

## Decision

Introduce **one** unified state model + a closed port + an in-memory store so a
single surface can render **Running / Waiting / Completed** across all
long-running work, regardless of origin.

### State model

- `RunKind = "shell" | "subagent" | "mcp_task" | "exec"` — the four flavours
  quanta can spawn (`exec` = detached one-shot processes that are neither an
  interactive shell session nor a subagent).
- `RunStatus = "running" | "waiting" | "completed" | "failed" | "stopped"`.
  `running` and `waiting` are the two **ACTIVE** states; the three terminal
  states are **SETTLED**.
- `WaitingOn = "user" | "tool" | "network" | "child_agent"` — drives the
  "needs you" badge.
- `RunArtifact = { kind: "log"|"stdout"|"summary"|"file"; ref: string }` — a
  produced output a UI can offer to open (`ref` is a path or `inline:<…>`).
- `RunEntry` carries `id` (caller-supplied — correlates to
  `shellId`/`task_id`/MCP task id), `kind`, `owner` (threadId/agent id),
  `title`, `status`, `startedAt`, `lastEventAt`, optional `waitingOn`,
  optional `resumeAction` (e.g. `"bash_await <shellId>"`), `artifacts`, and
  optional `error`. All fields readonly.

### Closed port (`RunLedgerPort`)

`start` / `touch` / `settle` / `get` / `list` / `running` / `waiting` /
`toSnapshot` / `fromSnapshot`. **Every method is NO-THROW.** Unknown id ⇒
`null` on `get`/`touch`/`settle`. A `now` clock seam is injected via
`createRunLedger({ now })` for deterministic tests.

### Pinned invariants

- `start` sets `status="running"` and `lastEventAt === startedAt`.
- `touch` bumps `lastEventAt` to `now()` and applies the status / `waitingOn`
  patch; artifacts append cumulatively. A `touch` on an already-settled entry
  is a **no-op** returning the settled entry (no resurrection,
  `lastEventAt` not bumped).
- `settle` is **idempotent**: settling an already-settled entry returns the
  entry unchanged.
- `running()` / `waiting()` filter by status; `list()` filters compose
  (`status ∧ kind ∧ owner`).
- **Bounded retention**: SETTLED entries are LRU-evicted by oldest
  `lastEventAt` once their count exceeds `maxRetained` (default **256**).
  ACTIVE entries (running/waiting) **never count toward the cap and are never
  evicted** — mirrors `TaskRegistry`'s policy so the active set a UI must
  render is always intact.
- Snapshot round-trip restores entries; returns are frozen so a reader cannot
  corrupt ledger state through a held reference.

### Slice fence

The slice imports **nothing** from `@/agent` core, `@/apps`, `@/subagent`,
`@/tool`, or `@/mcp`. It is a self-contained pure model: it does **not** call
into those slices — wave 2 will adapt *them* to report into this ledger. IDs
are caller-supplied precisely so the ledger never needs to know any source
slice's id scheme. The `agent`-slice boundary suite confirms the new files
introduce no peer imports.

## Consequences

- **+** A single surface contract: one shape, one status vocabulary, one
  resume hint, across shell / subagent / mcp_task / exec.
- **+** Default-OFF & byte-identical: nothing wires the ledger yet, so this
  wave cannot regress any existing behaviour.
- **+** Memory-bounded: settled-LRU prevents unbounded growth on long sessions
  without ever dropping an active run from the UI.
- **−** Wiring is deferred. Until wave 2 plumbs `bash_*` / `task_*` / the MCP
  poller into `start`/`touch`/`settle`, the ledger is an empty model. That is
  intentional — this ADR is the contract the adapters will target.

## Alternatives considered

- **Extend `TaskRegistry` to cover shells + MCP.** Rejected: `TaskRegistry`
  carries subagent-specific capability tokens (`TaskOwnerToken`), abort
  controllers, and settle-promise plumbing that are meaningless for a shell or
  an MCP task. Overloading it would couple three concerns and break the
  subagent slice's fence.
- **A UI-side aggregator that reads all three slices.** Rejected: pushes the
  reconciliation (and three slice dependencies) into every surface; the model
  belongs in the core, not duplicated per surface.
