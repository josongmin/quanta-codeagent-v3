# Ticket 02 — wire `thin-client-dispatch` + `control-request` to the session protocol

> **REVISED v2 (jun-09 deep audit) — MOVED TO PHASE 2.** This WS-channel wire is for **mutations / live steering** (`set_model` / `set_permission_mode` / `set_thinking` / `interrupt`), which genuinely belong on the lease-guarded turn channel. **READOUTS do NOT use this** — they are out-of-band HTTP (index §2.5, ticket 05), because the single-writer lease throws mid-turn. Drop the `get_*` `ControlRequest` extension below (readouts aren't control-requests). Also note: `control-request`'s poll is mid-turn only, so an **idle** mutation needs a direct-apply path (or the existing identity/profile session verbs).
>
> _(v1 note, superseded for readouts:)_ the original draft invented a `slash.run` verb; this ticket instead wires the existing ADR-0493/0496 mechanism (non-duplicating, SOTA-aligned, IDE-spec build-order #2).

**Phase**: ~~0~~ **2** · **Depends**: 01 (for the `local` route only) · **Risk**: medium (core session kernel)

## What already exists (do NOT re-implement)
| Slice | What it gives | File | Wired? |
|---|---|---|---|
| ADR-0493 thin-client-dispatch | `ThinClientRoute = local\|post-text\|control-request` + `resolveThinClientRoute(surface, descriptor, env)` + `SlashCommand.thinClientDispatch` field | [src/agent/thin-client-dispatch/types.ts](../../../src/agent/thin-client-dispatch/types.ts), [src/shared/thin-client-route.ts](../../../src/shared/thin-client-route.ts), [slash-contract.ts:240](../../../src/apps/cli/slash-contract.ts#L240) | ❌ 0 callers |
| ADR-0496 control-request | `ControlRequest` union + `planControlRequest(req, ctx)` (pure, fail-closed) + `ControlEffect` + `ControlRequestPort` | [src/agent/control-request/types.ts:30](../../../src/agent/control-request/types.ts#L30), [apply.ts:101](../../../src/agent/control-request/apply.ts#L101) | ❌ planner-only |
| SOTA reference | Claude Code 2.1.167 control-request subtype table (~30) | [docs/plans/jun-7-draft-ide-integration-spec-claude.md §2](../../../docs/plans/jun-7-draft-ide-integration-spec-claude.md) | — |

## New protocol surface (the missing wire)
### Command (client → daemon)
[src/protocol/session/commands.ts](../../../src/protocol/session/commands.ts) — add to the union ([:39](../../../src/protocol/session/commands.ts#L39)) + `SESSION_COMMAND_TYPES`:
```ts
export interface ControlRequestCommand extends SessionCommandEnvelope<"control.request"> {
  // EITHER a typed control-request (structured route) …
  readonly request: ControlRequest                 // reuse @/agent/control-request type
}
// (the `local` / `post-text` routes are resolved server-side from the command's
//  thinClientDispatch tag — see ticket 03. A thin client just names the command:)
export interface ThinCommandCommand extends SessionCommandEnvelope<"thin.command"> {
  readonly name: string                            // slash name, e.g. "state"
  readonly args?: readonly string[]
}
```
> Codec needs **no change** (generic `payload` pass-through, [codec.ts:149-163](../../../src/protocol/session/codec.ts#L149)). Two verbs because the two routes carry different payloads; if a single verb is cleaner, carry a discriminated `{ route, … }` — decide in implementation, but **reuse `ControlRequest` verbatim** for the typed path.

### Event (daemon → client)
[src/protocol/session/events.ts](../../../src/protocol/session/events.ts) — add + register in `SessionEvent` union ([:151](../../../src/protocol/session/events.ts#L151)) + `SESSION_EVENT_TYPES` ([:168](../../../src/protocol/session/events.ts#L168)):
```ts
export interface ControlResponseEvent extends SessionEventEnvelope<"control.response"> {
  readonly forName?: string                        // echoes the request
  readonly effect: ControlEffect                   // reuse @/agent/control-request ControlEffect (structured!)
}
export interface ThinResultEvent extends SessionEventEnvelope<"thin.result"> {
  readonly name: string
  readonly output: string                          // ANSI-stripped (local route)
  readonly isError: boolean
}
```
The **structured** `ControlEffect` (`model-set` / `usage{snapshot}` / `rejected{reason}` / new `get_*` payloads) is what Phase 3 native panels render directly — the SOTA win over text capture.

## Extend `ControlRequest` with the missing `get_*` readout subtypes
[src/agent/control-request/types.ts](../../../src/agent/control-request/types.ts) — add (mirroring the pure/fail-closed pattern + `ALL_CONTROL_REQUEST_KINDS` + `planControlRequest` cases at [apply.ts:113+](../../../src/agent/control-request/apply.ts#L113)):
- `get_working_state` → `{ kind:"working-state", state }` (drives `/state`)
- `get_plan` → `{ kind:"plan", plan }` (drives `/plan`)
- `get_agents` → `{ kind:"agents", fleet }` (drives `/agents`)
- `get_cost` → `{ kind:"cost", … }` (drives `/cost`)
- (`get_context_usage` already exists → `/context`)

Each is read-only, allowlist-free, fail-closed (absent snapshot ⇒ `rejected`), and additive to `ALL_CONTROL_REQUEST_KINDS`. Align names to the Claude Code table where one exists.

## Kernel wiring
- **Reducer** [reducer.ts:76](../../../src/kernel/session/reducer.ts#L76): `case "control.request"` / `case "thin.command"` → `hostAction: { kind:"thin_dispatch", … }`, state unchanged for read-only (mutations echo `session.state.updated`). Mirror the `approval.respond` case ([:174](../../../src/kernel/session/reducer.ts#L174)).
- **Scheduler** [scheduler.ts:827](../../../src/kernel/session/scheduler.ts#L827): `case` → `const r = await ctx.host.dispatchThinClient?.(...)` → emit `control.response` / `thin.result`.
- **SessionHost port** [ports.ts:144](../../../src/kernel/session/ports.ts#L144): add `dispatchThinClient?(args)` (optional ⇒ byte-identical for a host that doesn't implement it). Ticket 03 implements it (route → planControlRequest / local slash / post-text).

## SDK + frontend mirror + drift guard
- SDK builder [session.ts:204](../../../src/sdk/runtime/session.ts#L204) pattern: `session.control.request(req, …)` / `session.thin.command(name, args, …)`.
- Frontend protocol mirror [apps/web-frontend/src/types/protocol.ts](../../../apps/web-frontend/src/types/protocol.ts) + drift contract [tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts](../../../tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts) — member parity.

## Gate
Reuse `QUANTA_THIN_CLIENT_DISPATCH` + `QUANTA_CONTROL_REQUEST` (both already SSOT'd). Gate-off ⇒ verbs rejected, byte-identical. **No new knob.**

## Definition of Done (TDD, red-first)
- Codec round-trips the new command/event; `isSessionCommandType`/`isSessionEventType` updated; drift contract green.
- `planControlRequest` new `get_*` cases: happy-path effect + fail-closed (absent snapshot ⇒ rejected) + NO-THROW — extend [tests/unit/control-request-hellgate.test.ts](../../../tests/unit/control-request-hellgate.test.ts).
- Kernel: `control.request{get_context_usage}` → `control.response{effect:usage}`; `thin.command{state}` → host dispatch.
- Gate-off path: rejected, no host call.

## Risks
- Two-verb vs one-discriminated-verb is a real design choice — keep `ControlRequest` reuse non-negotiable; the envelope shape is flexible.
- `@/kernel/session` / `@/protocol/session` are disjoint from the concurrent ADR-0529 work; the `SessionHost` port addition (ports.ts) is the one shared file — additive-optional, low collision.
