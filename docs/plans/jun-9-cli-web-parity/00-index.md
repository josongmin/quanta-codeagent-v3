# CLI → Web feature parity — plan index (Phase 0+1)

- **Status**: Draft (jun-09). Scope per user decision: **Phase 0 (keystone) + Phase 1 (read-only observability readouts)**. Phase 2 (mutations) / 3 (native panels) / 4 (non-goals) sketched here, ticketed later.
- **Companion**: [docs/runner/SURFACE_INTEGRATION.md](../../runner/SURFACE_INTEGRATION.md) (the thin-surface contract this plan finally cashes in), jun-09 surface-integration audit (`fc surface_integration` axis).
- **North star** (memory `agent-state-observability-northstar`): agent-state visibility — *what is it doing / why stopped / what's next* — NOT feature-count. Phase 1 is chosen for exactly this: the read-only readouts are the observability surface.

---

## 1. Root-cause diagnosis (why the web is ~15-20% of the CLI)

It is **not** that web features are unbuilt. It is that the web has **no transport to invoke the features that already exist**:

- The web frontend sends only **4 of 7** session verbs: `input.append` / `turn.run` / `turn.cancel` / `approval.respond` ([apps/web-frontend/src/types/protocol.ts](../../../apps/web-frontend/src/types/protocol.ts), confirmed by App.tsx emit sites).
- The web "slash palette" shows ~33 commands but **23 are prefill stubs** — `prefill(slug)` just drops `/<cmd> ` into the draft ([apps/web-frontend/src/components/SlashPalette.tsx:246](../../../apps/web-frontend/src/components/SlashPalette.tsx#L246), and the `action: prefill("state"|"branches"|…)` rows at :404+). The command **never executes**; the text reaches the LLM as meaningless input.
- The CLI's ~43 slash commands run real handlers over a **`SlashContext` port** ([src/apps/cli/slash-contract.ts:9](../../../src/apps/cli/slash-contract.ts#L9)) whose `out`/`err` are injected sinks `(s: string) => void` — the CLI binds them to `process.stdout`; nothing forces a terminal.

**The leverage**: because `SlashContext` is already a port and the handlers are surface-agnostic, web parity is a **transport + ctx-binding** problem, not a re-implementation problem.

> ### ⚠️ AUDIT REVISION (jun-09) — the transport is already DESIGNED; do NOT invent a new one
> A first draft of this plan proposed a brand-new `slash.run` session verb that captures terminal text. **That is a duplicate invention.** The mechanism for thin-surface (web/ide) command parity already exists, built-but-unwired, across three pieces:
> - **ADR-0493 `thin-client-dispatch`** — a gate-aware resolver that routes each command, for THIN surfaces (web/ide), per a `thinClientDispatch` tag: `local` (host runs it) / `post-text` (post text into stream) / `control-request` (structured control). Route vocab in [src/shared/thin-client-route.ts](../../../src/shared/thin-client-route.ts), resolver in [src/agent/thin-client-dispatch/types.ts](../../../src/agent/thin-client-dispatch/types.ts), and **`SlashCommand.thinClientDispatch` already exists** ([slash-contract.ts:240-245](../../../src/apps/cli/slash-contract.ts#L240)). Gate `QUANTA_THIN_CLIENT_DISPATCH`. Wired callers today: **0** (pure-only).
> - **ADR-0496 `control-request`** — a typed, pure, fail-closed `ControlRequest` channel ([src/agent/control-request/types.ts:30](../../../src/agent/control-request/types.ts#L30)): `set_model` / `set_permission_mode` / `set_thinking` / `get_context_usage` today, absorbed verbatim from **Claude Code 2.1.167's control-request protocol** (the SOTA reference). Gate `QUANTA_CONTROL_REQUEST`. Host/kernel/protocol wiring today: **0** (planner-only).
> - **IDE spec [§2](../jun-8-ide-plugin/../../plans/jun-7-draft-ide-integration-spec-claude.md) / §21** — the verified Claude Code control-request subtype table (~30 subtypes) + the explicit **build-order: #2 = "control-request + thinClientDispatch vocab [unlocks the `ide` preset host contract]"**.
>
> So the keystone is **wiring the existing thin-client-dispatch + control-request to the session protocol**, not a new `slash.run`. This is also the SOTA-aligned move (typed/structured requests, per Claude Code) and the *shared* web+ide mechanism (so it isn't re-done for the IDE later).

This is the payoff the [SURFACE_INTEGRATION blueprint](../../runner/SURFACE_INTEGRATION.md) promised ("assembled in hours, not weeks") — cashed in via the already-designed routing, not a parallel verb.

---

## 2. Keystone architecture (Phase 0) — wire the EXISTING routing, don't invent

```
 web SlashPalette ──control.request{ ThinClientCommand }──▶ kernel reducer ──hostAction:thin_dispatch──▶ scheduler
   (each command tagged                                                                       │
    thinClientDispatch)                                                       host.dispatchThinClient(cmd, surface:"web")
                                                                                               │
                                       resolveThinClientRoute(surface, descriptor, env)  ◀── ADR-0493 (pure, exists)
                                                          │
                       ┌──────────────────────────────────┼───────────────────────────────────┐
                  "control-request"                    "local"                            "post-text"
                       │                                   │                                    │
            planControlRequest(req)              dispatchSlash(REGISTRY, name,             post text into the
            ◀── ADR-0496 (pure, exists)          ctx) over a capture SlashContext          turn stream
            → structured ControlEffect           (hoisted handlers, ticket 01)             (server-side prefill)
                       │                                   │                                    │
 web ◀──control.response{ effect | text }── scheduler emits ◀───────────────────────────────────┘
       (structured ⇒ native panel; text ⇒ SlashResultBlock)
```

**Two pure slices already exist; the keystone is the WIRE between them and the session protocol:**
- `resolveThinClientRoute(surface, descriptor, env)` — ADR-0493, [src/agent/thin-client-dispatch/types.ts](../../../src/agent/thin-client-dispatch/types.ts). Pure. Unwired.
- `planControlRequest(req, ctx)` — ADR-0496, [src/agent/control-request/apply.ts:101](../../../src/agent/control-request/apply.ts#L101). Pure, fail-closed. Unwired.

**Fence constraint (still applies to the `local` route)**: a biome rule **forbids any library/daemon slice from importing `src/apps/cli`** ([biome.json:81-82](../../../biome.json#L81)). The slash registry + `SlashContext` live in `apps/cli` ([registry-surface.ts:836](../../../src/apps/cli/slash/registry-surface.ts#L836)). The `local` route needs the daemon to run those handlers ⇒ ticket [01](01-slash-registry-hoist.md) still hoists them into `@/runner`. (The `control-request` route does NOT need the hoist — it goes through the typed planner.)

**Preference order per command (SOTA-aligned)**: a command is tagged `control-request` when it maps to a typed `ControlRequest` subtype (structured ⇒ best for native panels + matches Claude Code); `local` only for the long-tail renderers with no typed equivalent; `post-text` for the rare "just inject this prose".

## 2.5 ⚠️⚠️ DEEP AUDIT v2 (jun-09) — READOUTS are out-of-band; do NOT put them on the WS turn channel

A second, deeper pass found a **fatal flaw** in the revision above (which routed readouts through `control.request` on the WS session channel):

- **The single-writer lease throws.** An in-flight `turn.run` holds the session single-writer lease for its **entire duration** ([scheduler.ts:739](../../../src/kernel/session/scheduler.ts#L739)); any other command going through `lease.runWith` ([scheduler.ts:759](../../../src/kernel/session/scheduler.ts#L759)) **throws `single_writer_lease_held`** ([lease.ts:25](../../../src/kernel/session/lease.ts#L25)). Only `turn.cancel` has a lease-bypass fast-path. **⇒ a `/state` / `/agents` readout fired while the agent is working would be REJECTED** — exactly when you want to look.
- **control-request is a mid-turn STEERING poll, not a readout request/response.** Its port is polled at the turn-iteration chokepoint ([turn-iteration.ts:54](../../../src/agent/loop/turn-iteration.ts#L54)). When idle (no turn) there is no poll. So typing readouts as `get_*` `ControlRequest` kinds is a **misfit** (it also can't answer when idle). `get_context_usage` in ADR-0496 is itself arguably misplaced for this reason.
- **The daemon already serves a readout OUT-OF-BAND.** Knobs go over an HTTP route ([knob-catalog-wire.ts](../../../src/apps/web-daemon/knob-catalog-wire.ts)), composed from registries, with no lease contention — works any time. The session-registry already holds the **live `RuntimeSession`** per connection ([session-registry.ts:17](../../../src/apps/web-daemon/session-registry.ts#L17)), and server.ts already routes `/threads` / `/config` / `/auth/*` HTTP behind a shared bearer-auth gate ([server.ts:825](../../../src/apps/web-daemon/server.ts#L825)).

**Corrected split:**
- **Readouts (Phase 1)** = **out-of-band query** — an HTTP route (like knobs) that reads the live session/host state accessors and responds. No session verb, no kernel/reducer change, no control-request, no lease. Works idle AND mid-turn; per-client request/response (no WS broadcast leak); reuses the existing HTTP-route + session-registry + auth machinery. This is also far **less** to build than the WS-command path.
- **Mutations / live steering (Phase 2)** = `control-request` on the WS turn channel (where the mid-turn poll genuinely belongs). Note `control-request` also can't apply an **idle** mutation (no poll) — Phase 2 must add a direct-apply path or reuse the existing identity/profile session verbs for idle.

**Net effect on this plan**: tickets 02-04 (new WS verbs + kernel wiring) are **NOT needed for Phase 1**. Phase 1 becomes: HTTP readout routes + host read-accessors + web render. The thin-client-dispatch/control-request wire (tickets 02-03) moves to **Phase 2** (mutations), where it fits. The registry-hoist (ticket 01) is needed only if the daemon reuses the CLI's text renderers — otherwise the web renders native and the hoist is optional. **See the per-ticket REVISED v2 banners.**

---

## 2.7 ✅ VERIFIED IMPLEMENTATION STATUS (jun-09 round 3) — most readouts are ALREADY BUILT + RENDERED, just gated OFF

The deep audit's "build HTTP readouts" framing was *still_ partly wrong: a verification of the actual code shows the daemon **already pushes** most readout data to the web over three live channels, and the frontend **already renders** them — they are simply behind three default-OFF gates. This is the ground truth the remaining-work plan must start from.

### Tier A — built end-to-end, gated OFF (work = flip the gate + verify, ~no new code)
| Readout | Channel (daemon push) | Renders in | Gate (default off) |
|---|---|---|---|
| `/plan` | agent-state `plan_created/updated/snapshot` ([messages.ts:88-94](../../../src/protocol/agent-state/messages.ts#L88)) | `PlanPanel` | `QUANTA_WEB_AGENT_STATE` |
| mode + tool-progress ("what's it doing now") | agent-state `mode_changed`/`tool_progress` | `AgentStatePanel` | `QUANTA_WEB_AGENT_STATE` |
| compaction / ratelimit | agent-state `context_compacted`/`ratelimit_snapshot` | `AgentStatePanel` | `QUANTA_WEB_AGENT_STATE` |
| runs (running/waiting/done) + pending approvals | observability `snapshot`/`delta` (ObjectivePort/RunLedgerPort/ApprovalStateMachinePort) | `ObservabilityPane` | `QUANTA_OBSERVABILITY` |
| `/context` usage | canvas `context.usage` | `UsageBar` / `ObservabilityPane` | `QUANTA_WEB_CANVAS` |
| tool diffs | canvas `tool.diff` | `DiffPanel` | `QUANTA_WEB_CANVAS` |
| cumulative cost/tokens | `turn.completed.tokenUsage` | `TokenCounter` | (always on) |

App.tsx already wires `useAgentState` / `useObservabilityState` / `useContextUsage` / `useToolDiffs`. **So Tier A is a flip + the clean auto-hide UX (already added this session), not new wiring.** (Note: the user previously found the observability pane noisy → the gate-off is partly deliberate; Tier A must ship with the auto-hide / a toggle, not a wall of panels.)

### Tier B — genuinely NOT on any channel (real new wiring)
`/agents` (subagent **fleet roster** — `TaskRegistry` is not pushed; agent-state only has per-tool progress) · `/state` (rich **working-state**: posture / blockers / next-steps / owners — not pushed) · `/branches` · `/skills` · `/capabilities` · `/mcp` · `/memory` · `/why`. Split: fleet + working-state → **extend the agent-state push** (live, structured → native panel); skills/caps/mcp/memory/branches/why → **HTTP pull** out-of-band (like knobs, lease-free).

### Tier C — mutations: MOSTLY ALREADY DONE (corrected — round 4)
The "fully unwired" claim was wrong. What actually works on the web **today**:
| Mutation | Path | Status |
|---|---|---|
| `/effort`, `/model` | web `buildLlmConfigSlashCommands` ([slash-llm-config.ts](../../../apps/web-frontend/src/components/slash-llm-config.ts)) → `POST /config` → env → next turn. Spliced live ([App.tsx:575](../../../apps/web-frontend/src/App.tsx#L575)); allowlist `QUANTA_MODEL`/`QUANTA_REASONING_EFFORT` ([slash-knobs.ts:60](../../../apps/web-frontend/src/components/slash-knobs.ts#L60)) | ✅ DONE |
| knobs read + write | `KnobsPanel` ← `GET /api/knobs` + `POST /config` (closed allowlist, bearer auth, [server.ts:429](../../../src/apps/web-daemon/server.ts#L429)) | ✅ DONE |
| `/interrupt` | `turn.cancel` (`useSendCancel`, App.tsx) | ✅ DONE |
| approval respond | `EscalationCard` (ADR-0512 P3) | ✅ DONE |
| login / logout | web `slash-auth` → `/auth/*` routes ([server.ts:967](../../../src/apps/web-daemon/server.ts#L967)) | ✅ DONE |
| identity / tool-profile / permission switch | The session verbs are wired in the **kernel** (reducer [:99/:120](../../../src/kernel/session/reducer.ts#L99) → scheduler [:841-846](../../../src/kernel/session/scheduler.ts#L841) → host `setIdentityMode`/`setToolProfile`), BUT on the **web daemon they NO-OP**: `createRuntimeFromAgentConfigBase` ([context.ts:289](../../../src/sdk/runtime/context.ts#L289)) does NOT thread `boot` to the facade (unlike `createRuntimeFromBootstrap` [:330](../../../src/sdk/runtime/context.ts#L330)), so `host.set*` has no `boot.identityModeState`/`toolProfileState`/`permissionModeState` to mutate. The web daemon **bakes identity/profile/permission into the AgentConfig at session creation** — there is no per-turn mode-state to switch. A ModeBadge switcher would update the state echo but the engine would IGNORE it → **a lying control. NOT shipped.** | 🔴 kernel-wired but **web daemon does NOT honor** — needs the runtime reworked to bootstrap-style mode-states (a deeper task, NOT "drop a dropdown") |
| `/debug` `/inbound` `/snooze` `/sticky-model` `/focus-chain` `/brief` | none | ❌ niche, unwired |

> **⚠️ Lesson (jun-09): wire-verified ≠ behavior-verified.** A first cut shipped ModeBadge identity/profile/permission dropdowns ("backend wired, just add UI"). The command→reducer→state-echo wire was real, but the daemon's `host.set*` no-ops, so the levers were a lying UI. Caught + reverted before commit. Mode switching on the web is a **runtime-rework** item, parked.

**⇒ control-request / the new WS wire (tickets 02-04) is NOT needed for the common mutations.** They already ride `/config` (LLM knobs) or the wired session verbs (identity/profile) or `turn.cancel` (interrupt). A new typed control channel is only justified for the ❌ niche set — and even those could extend the `/config` allowlist or add a session verb more cheaply. **Re-scope tickets 02-04 to "only if the niche set proves worth a typed channel".**

## 3. Phase / ticket map

### Phase 1 — read-only readouts, OUT-OF-BAND (this plan — the real first slice)
| Ticket | What | Value |
|---|---|---|
| [05 — read-only readouts (HTTP)](05-phase1-readonly-commands.md) | **REVISED v2**: out-of-band HTTP routes (like knobs) that read live session/host state + respond. No session verb / kernel / control-request / lease. The 12: `/state` `/agents` `/plan` `/context` `/cost` `/skills` `/knobs` `/mcp` `/capabilities` `/why` `/memory` `/branches` | see the agent's live state while it works — lease-free, works mid-turn |
| [01 — slash-registry hoist](01-slash-registry-hoist.md) | **OPTIONAL** — only if Phase 1 reuses the CLI's text renderers server-side (fence blocks the daemon from `apps/cli`). If the web renders native, skip until Phase 2's `local` route needs it. | reuse CLI render, else N/A |
| [06 — tracking + fc](06-tracking-and-fc.md) | Flip the Phase-1 features `web:missing→full`; ratchet to guard regression; per-phase DoD (`fc surface` already runs clean) | keeps parity from rotting |

### Phase 2 — mutations / live steering (WS turn channel — moved here by the deep audit)
| Ticket | What | Note |
|---|---|---|
| [02 — control-request + thin-client wire](02-slash-run-protocol.md) | Wire the EXISTING `resolveThinClientRoute` (ADR-0493) + `planControlRequest` (ADR-0496) to the session protocol for **mutations**: `set_model`/`set_permission_mode`/`set_thinking`/`interrupt` (Claude-Code-aligned). NOT readouts. | belongs on the lease-guarded turn channel |
| [03 — daemon thin-client adapter](03-daemon-slash-adapter.md) | Daemon `host.dispatchThinClient`: route → `planControlRequest` (mutate) / `local` slash (mutating long tail only) | reconcile with the "ghost" identity/profile verbs; add idle-apply path |
| [04 — web send + render](04-web-slash-run-render.md) | Mutating SlashPalette rows send the control verb; render the structured effect | — |

### Later (sketched, not yet ticketed — Phase 2/3/4)
- **Phase 2 (mutations)**: `/effort` `/identity` `/profile` `/debug` `/inbound` `/snooze`+`/resume` `/summarize-now` `/resume-turn` `/sticky-model` `/focus-chain` `/brief`. **Most map directly to `control-request` subtypes** — `/effort`→`set_thinking`, `/identity`/mode-cycle→`set_permission_mode`, `/model`→`set_model` (all already typed in ADR-0496), plus new `set_*` subtypes for the rest, aligned to the Claude Code table (IDE spec §2: `interrupt`/`rewind_files`/`set_max_thinking_tokens`/…). The 3 "ghost" session verbs (`session.identity.set` / `session.tool_profile.set`, [commands.ts:39-46](../../../src/protocol/session/commands.ts#L39)) become **redundant** with `set_permission_mode`/`set_model` control-requests — Phase 2 reconciles them (consolidate, don't run both channels). This is the "fold interrupt/cancel/set_mode/set_brief under the umbrella" follow-up ADR-0496 already names.
- **Phase 3 (native panels)**: upgrade Phase-1 text results into structured React panels (BranchesPanel, full WorkingStatePanel, AgentsFleetPanel, CostTimeline) reusing the existing agent-state / observability frames.
- **Phase 4 (deliberate non-goals)**: `/navigate` (web has no single cwd), `/color` (web settings instead), `/voice-live` (web mic API — separate track), `/login`+`/logout` (web OAuth UX — separate), `/rewind*` (storage mutation — needs careful web UX). Documented as *won't port as-is*, with the why.

---

## 4. Reconciliation, sequencing & collision notes

- **Reconcile with the jun-8-ide-plugin plan (sibling thin surface)**: that plan's [00-index:71-72](../jun-8-ide-plugin/00-index.md) explicitly marks "**서버 slash 프로토콜 out-of-scope**" and parks the web/ide SlashPalette mirror as its ticket 08. **This plan owns that deferred server-slash/control wire.** Because web AND ide are both THIN surfaces sharing `resolveThinClientRoute`/`control-request`, the keystone (tickets 01-03) is the *shared* host↔agent control contract the IDE preset also consumes — build it once here; jun-8 ticket 08 then only adds ide-specific *rendering*. Do not duplicate the wire in both plans.
- **One concurrent in-flight stream**: ADR-0529 shell/runtime refactor is touching `src/runtime/**`, `src/host/runtime/agent-config-assembler.ts`, `src/shared/runtime-config.ts`, `src/side-agent/**` (uncommitted ` M`). Phase 0 touches `@/runner`, `@/protocol/session`, `@/kernel/session`, `@/host/runtime`, `@/agent/thin-client-dispatch`, `@/agent/control-request`, `apps/web-daemon`, `apps/web-frontend`, `apps/cli/slash` — **mostly disjoint** except the shared `@/host/runtime` chokepoint. Coordinate the host-port addition so it doesn't collide with their assembler rewrite. Do **not** `git add -A` / blanket-commit (memory `sweep-and-macos-sed`).
- **Ticket order is strict**: 01 (hoist) → 02 (wire) → 03 (daemon) ‖ 04 (web) → 05 (commands) → 06 (tracking). 03 and 04 can run in parallel once 02 lands the shared types.
- **Default-OFF (reuse existing gates)**: the whole Phase ships byte-identical behind the **already-defined** gates `QUANTA_THIN_CLIENT_DISPATCH` (ADR-0493) + `QUANTA_CONTROL_REQUEST` (ADR-0496). Do **not** mint a new `QUANTA_WEB_SLASH` — that would be a third parallel knob for one concern (memory `knob-config-systems-inventory`: grep before inventing a knob).

## 5. Risks / open questions
- **R1 — ctx-slot availability**: some Phase-1 commands need a runtime slot the daemon host does not yet expose (e.g. `branchSearch`, `agents` fleet, `cost`). Ticket 05 enumerates works-now (`/state` has `workingState` at [context-binding.ts:107](../../../src/host/runtime/internal/context-binding.ts#L107) + `skillScope` already added) vs needs-slot. A missing slot returns the CLI's own "not wired in this surface" line — **graceful, never a crash**.
- **R2 — output shape**: Phase 0 streams the command's *terminal text* (ANSI-stripped). Good enough to be functional; Phase 3 upgrades the structured ones to panels. Decide per-command whether `slash.result` also carries a structured payload (additive field) now or later.
- **R3 — mutation safety**: read-only commands are safe to expose first (Phase 1). Mutating commands (Phase 2) must respect the same permission/identity gates the CLI does — do not let a web `slash.run` bypass approval.
- **R4 — fc matrix** (resolved): `bun tools/feature-catalog/cli.ts surface` now runs clean (the earlier `wired` enum blocker was fixed). Authoritative gap: **web full 107 / partial 59 / missing 213 / na 579** of cli full 834. Ticket 06 uses this as the tracked denominator.
