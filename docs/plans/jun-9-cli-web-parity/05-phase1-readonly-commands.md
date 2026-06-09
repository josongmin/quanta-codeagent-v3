# Ticket 05 — Phase 1: the 12 read-only observability readouts

> **REVISED (jun-09 audit)**: each command is assigned a **route** (ADR-0493 `thinClientDispatch` tag). The north-star readouts that benefit from structured panels use the **`control-request` `get_*`** route (typed effect, ticket 02); the niche text-only ones use `local`. This is the per-command tagging the codebase has 0 of today.

**Phase**: 1 · **Depends**: 0 (01-04) · **Risk**: low-medium (slot-binding + per-command route tagging)

## Goal
Make the 12 read-only commands render real data on the web via their assigned route. After Phase 0 the *transport* + both route mechanisms work; this ticket (a) tags each command's `thinClientDispatch`, (b) for `control-request` readouts adds the `get_*` subtype + binds its ctx snapshot, (c) for `local` readouts binds the daemon **ctx slot**.

## Route assignment (the missing tags)
| Command | Route | Backing |
|---|---|---|
| `/context` | `control-request` | `get_context_usage` (exists) |
| `/state` | `control-request` | new `get_working_state` (ticket 02) |
| `/plan` | `control-request` | new `get_plan` |
| `/agents` | `control-request` | new `get_agents` |
| `/cost` | `control-request` | new `get_cost` |
| `/skills` `/capabilities` `/mcp` `/knobs` `/branches` `/why` `/memory` | `local` (text) initially | hoisted slash + ctx slot; promote to `get_*` in Phase 3 if a panel wants structure |

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
