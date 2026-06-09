# Ticket 05 — Phase 1: the 12 read-only readouts (OUT-OF-BAND)

> **REVISED v2 (jun-09 deep audit)**: readouts are **out-of-band HTTP queries**, NOT WS session verbs / control-requests. The WS turn channel throws `single_writer_lease_held` mid-turn ([scheduler.ts:759](../../../src/kernel/session/scheduler.ts#L759) → [lease.ts:25](../../../src/kernel/session/lease.ts#L25)), so a readout fired while the agent works would be rejected. The daemon already serves knobs this way ([knob-catalog-wire.ts](../../../src/apps/web-daemon/knob-catalog-wire.ts)). **Phase 1 does NOT depend on tickets 02-04** (those move to Phase 2 / mutations). See index §2.5.

**Phase**: 1 · **Depends**: (optionally 01 if reusing CLI renderers) · **Risk**: low (HTTP route + host read-accessor + render)

## Goal
Serve the 12 read-only readouts as **out-of-band HTTP routes** on the daemon, each reading the live session/host state and responding (request/response, per-client, lease-free, works idle + mid-turn).

## Mechanism
- A `GET /state` / `GET /agents` / … route family (or one `GET /readout/:name`) added next to the existing `/threads` / `/config` / knobs routes in [server.ts](../../../src/apps/web-daemon/server.ts), behind the shared bearer-auth gate ([server.ts:825](../../../src/apps/web-daemon/server.ts#L825)).
- Each handler reaches the live `RuntimeSession` via the session-registry ([session-registry.ts:17](../../../src/apps/web-daemon/session-registry.ts#L17)) and calls a **synchronous read accessor** on its host (no `await` that interleaves with a running turn ⇒ no torn read; JS single-thread makes a sync read between the turn's await-points safe).
- The web fetches it (the `KnobsPanel` HTTP-fetch pattern is the template) and renders. Phase-3 upgrades the render to a native panel; Phase 1 can render the host's own text first.

## Per-command matrix (slot needed · status after Phase 0 · work)
| Command | `SlashContext` slot(s) | Status | Work |
|---|---|---|---|
| `/state` | `workingState`, `skillScope` | ✅ works now | both already on the host ([context-binding.ts:107](../../../src/host/runtime/internal/context-binding.ts#L107) + P3 skillScope) — verify render |
| `/plan` | `planSnapshot` | ⚠️ | expose a plan-store read accessor on the host |
| `/context` | `contextUsage` | ⚠️ | reuse the canvas usage computation ([canvas-usage-source.ts](../../../src/apps/web-daemon/canvas-usage-source.ts)) |
| `/cost` | `cost` | ⚠️ | bind a `() => string` cost renderer off the token meter |
| `/skills` | `skills` | ⚠️ | expose the boot-time skills registry as `() => Promise<SkillRow[]>` |
| `/capabilities` (`/caps`) | (reads capability manifest) | ⚠️ | the host already builds a `CapabilityManifest` ([context-binding.ts buildCapabilityManifest](../../../src/host/runtime/internal/context-binding.ts)) — bind it |
| `/agents` | `agents`, `now` | ❌ | expose the runtime `TaskRegistry` as a read accessor (fleet snapshot) |
| `/branches` | `branchSearch` | ❌ | expose branch-search state (only present when the branch-search loop ran) |
| `/knobs` | (knob registry) | ⚠️ | a daemon HTTP `/api/knobs` already exists ([KnobsPanel.tsx](../../../apps/web-frontend/src/components/KnobsPanel.tsx)); either bind the read here or keep the panel and skip the slash form |
| `/mcp` | `mcp` | ⚠️ | bind MCP server status off the runtime MCP clients |
| `/memory` | (memory store read) | ⚠️ (env-gated) | bind a read accessor off `@/memory` store; respect `QUANTA_MEMORY_SLASH` |
| `/why` | `why` (recorded tool calls) | ⚠️ | bind the recorder's last-tool-call query |

Legend: ✅ works after Phase 0 · ⚠️ small host read-accessor · ❌ new host introspection accessor.

## Ordering (north-star ROI)
1. **`/state`** (works now) — prove the whole pipe end-to-end on the highest-value command first.
2. **`/agents`, `/plan`** — "what is it doing / what's next" (the literal north-star). Worth the ❌/⚠️ accessor.
3. **`/context`, `/cost`** — budget visibility.
4. **`/skills`, `/capabilities`, `/mcp`, `/knobs`** — config visibility.
5. **`/branches`, `/why`, `/memory`** — deeper diagnostics.

## Definition of Done
- Each command: a daemon test that the route handler (`get_*` plan for control-request commands, `runLocalSlash` for local) returns the expected rendered text given a stub slot; a "slot absent ⇒ graceful 'not wired'" test.
- Web manual pass: each of the 12 typed in the palette renders real output (not a prefill, not "not wired" unless deliberately deferred).
- The "needs-slot" accessors are **read-only** — no mutation, no permission bypass (R3 in the index).
- `/state` and `/agents` verified against a live `:4096` session that is mid-turn (real working-state + a real subagent in the fleet).

## Explicitly deferred to Phase 2/3 (not this ticket)
- Any **mutation** form (`/effort 3`, `/profile set …`, `/identity …`) — Phase 2.
- Upgrading the text dump to a **structured React panel** (BranchesPanel, AgentsFleetPanel, full WorkingStatePanel, CostTimeline) — Phase 3. Phase 1 ships the text result; it is *functional*, just not yet pretty.

## Risk
- `/agents` + `/branches` accessors touch runtime internals the concurrent ADR-0529 work may also be moving — land them after that settles, or coordinate the accessor location.
