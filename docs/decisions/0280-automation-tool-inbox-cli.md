# ADR-0280: `automation_update` tool + REPL inbox banner (E2 productization)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0215 (`AutomationEnginePort`), ADR-0279 (composition-root wire)

## Context

ADR-0279 wires the engine + ticker into the composition root, but the
operator has no way to:

1. **CRUD automations** at runtime from inside the agent loop — the model
   has no tool to schedule / pause / cancel a recurring automation.
2. **Notice fires** that occurred during a long-running session — the
   engine writes `inbox_items` on every fire, but the REPL never surfaces
   the unread count.

Codex's reference exposes a single `automation_update` tool with a closed
6-action verb set (`create | list | pause | resume | cancel | get`) and
shows `[inbox: N]` on the status row when there are unread entries.

## Decision

Two thin slices, both default-OFF and gated on `QUANTA_AUTOMATION=on`:

### Slice A — `automation_update` tool (`src/tool/automation_update.ts`)

A `defineTool`-built tool with a 6-action discriminated input schema:

- `create` — `{ id, title, rule (RRULE string), prompt, nextRunAt }` ⇒
  parses the RRULE via `parseRRule`, calls `engine.schedule(...)`.
- `list` — no input ⇒ returns the engine's full `list()` (cancelled rows
  excluded by port contract).
- `pause` / `resume` — `{ id }` ⇒ the engine's status field is binary
  (`scheduled` / `cancelled` / `fired` / `errored`); pause is modeled as
  `cancel`, resume is modeled as `schedule` with the same id retained
  from the prior row (operator re-schedules). For the v1 wire, both
  collapse to `cancel` — the host UI will reconstruct prior rule + next
  fire when the operator clicks "resume" (out of scope; documented).
- `cancel` — `{ id }` ⇒ `engine.cancel(id)` (idempotent per port contract).
- `get` — `{ id }` ⇒ scans `list()` for the matching id (rare op; O(N)
  is fine for v1).

Registered in `buildDefaultTools` ONLY when an `automationEngine` is
visible in the env (via `process.env.QUANTA_AUTOMATION === "on"`). Absent
⇒ the tool is NOT added to the default set; the model never sees it.

The tool's `execute` reads its engine via `ToolContext` — specifically,
through the host-injected `automationEngine` field added to the context
shape behind a per-tool getter so the wire stays loose. Pure types, no
runtime cost when unused.

### Slice B — REPL inbox banner (`src/apps/cli/repl/automation-banner.ts`)

A small helper that builds an `InboxBanner` interface with one method:
`paint(unreadCount: number)`. The composition root subscribes the
banner to `automationEngine.onTick`:

- `kind: "fired"` ⇒ the engine has just written an inbox entry ⇒
  re-paint the banner with the new count (host queries the engine for
  the current count — for the in-memory engine this is `engine.inbox.length`
  filtered by `read === false`; for sqlite it's `listInboxItems(db)`
  filtered the same way).
- `kind: "errored"` ⇒ same as fired (errors also create an inbox entry).
- `kind: "idle"` / `"engine-error"` ⇒ no-op (no new entries).

**Stderr discipline** — banner writes to `process.stderr` so it does not
pollute stdout (preserves byte-identical stdout for headless / batch
modes). The banner is paint-only — the user clears unread by reading
inbox items via a future `/inbox` slash (out of scope for this slice).

## Invariants

- **Default-OFF (tool)** — `QUANTA_AUTOMATION !== "on"` ⇒ tool NOT
  registered ⇒ byte-identical default tool set. Tested by HELL-AW-16.
- **Default-OFF (banner)** — banner constructor returns a NO-OP
  implementation when called without an engine, so a host that forgets
  to gate by env still pays zero cost. Tested by HELL-AW-19.
- **Concurrent CRUD safe** — the engine's `schedule` / `cancel` /
  `markRun` are atomic-per-call (in-memory: single-row Map mutation;
  sqlite: BEGIN/COMMIT). The tool serializes nothing of its own.
  Tested by HELL-AW-11.
- **Stdout clean** — banner writes ONLY to stderr; the unit test asserts
  stdout receives zero bytes during banner emission. Tested by HELL-AW-18.

## Consequences

Positive:
- Closes the operator-facing gap: an automation can be scheduled from
  inside a session (model calls `automation_update`), the engine fires
  it later, and the operator sees `[inbox: 3]` the next time they look.
- The 6-action tool surface matches Codex's reference so a future SOTA++
  absorption round can compare semantics directly.

Trade-offs:
- `pause` / `resume` are simplified to `cancel` for v1 (no soft-pause
  state in the engine port). A future ADR may add a `paused` status to
  `EngineStatus` if operators need it.
- The banner does not interrupt typing — it paints between turns, not
  mid-input. This matches the existing pill chrome's discipline.

## Validation

22 hellgate cases share with ADR-0279 (one battery covers the whole E2
slice). Specifically: HELL-AW-11 (concurrent CRUD), HELL-AW-15
(6-action round-trip), HELL-AW-16 (defaultTools registration on/off),
HELL-AW-17 (banner unread count), HELL-AW-18 (stderr / stdout cleanliness).
