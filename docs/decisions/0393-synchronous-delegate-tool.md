# ADR-0393 — Synchronous `delegate` tool (in-band mode-typed boomerang)

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0218 (mode-typed `DelegationPort`), ADR-0140
(background-subagent tool trio wire), ADR-0130 (background scheduler),
ADR-0236 (composition-root mega-wire `AgentConfig.delegation`)
**Slice:** `src/tool/delegate/` (new tool slice, 3 files) + `src/agent/tier1/delegate.ts`
(new composition-root builder) + 3 surgical wire edits.
**Default-OFF:** Yes — `config.delegation` absent ⇒ builder returns `[]`, the
`delegate` tool is not registered, the ToolRegistry stays byte-identical.

## Context

quanta already has TWO subagent surfaces:

1. **Background scheduler trio** (ADR-0130 / ADR-0140) — `subagent_fork` /
   `subagent_poll` / `subagent_await`. The parent forks a child into the
   background, keeps working, and harvests the result LATER. Asynchronous.
2. **The 6-tool Codex surface** (`spawn_agent` / `wait_agent` / …).

Both are ASYNCHRONOUS — the parent never blocks at the call site. What was
missing is the SYNCHRONOUS boomerang: hand a self-contained subtask to a child
under a named MODE and BLOCK until it finishes, receiving the typed result
in-band. This is the Roo "Boomerang" / Devin sub-task ergonomic where the
parent's reasoning naturally continues from the child's answer.

The plumbing already exists. ADR-0218 defined the mode-typed `DelegationPort`
(`delegate` / `listModes` / `describeMode`), and `session-execution-plane.ts`'s
`adaptDelegation()` already constructs a concrete `DelegationPort` and places it
on `AgentConfig.delegation = { delegator, modes }` (ADR-0236). What was absent
was an **LLM-facing tool** that lets the model invoke that port. The port had
no tool consumer — it was helper-only.

NOTE on the port shape: `DelegationPort` has NO `explore` method. `explore` is
a MODE VALUE (a member of the closed `AgentMode` union), not a port method. A
child runs under explore posture purely by passing `mode:"explore"` to
`delegate`. The tool therefore exposes mode as a closed-enum input field and
never needs a separate method.

## Decision

Add ONE synchronous tool, wired through the same default-OFF Tier-1 seam as the
background trio.

1. **New tool slice `src/tool/delegate/`** (slice-fence clean — imports only
   `../types` + `zod`, NEVER `@/agent`):
   - `port.ts` — a DUCK-TYPED mirror of the producer `DelegationPort`
     (`@/agent/subagent-typed`). Mirrors the tool-consumed subset (`delegate` +
     `listModes`) plus the `AgentMode` / `BoomerangResult` / `DelegationRequest`
     shapes. `DELEGATE_MODES` mirrors `AGENT_MODES`; a hellgate cross-checks the
     two are identical sets so the mirror can't silently drift.
   - `delegate.ts` — the `delegate` tool. Closed-enum `mode` input (rejected at
     the schema boundary if unknown ⇒ the port is never reached with a bad
     mode), `task` prompt, optional `maxTurns` / `maxTokens` budget. Threads the
     parent's `ctx.signal` into `DelegationRequest.parentSignal` so an abort on
     the parent unwinds the child (boomerang `errorKind:"cancelled"`). Renders
     the typed `BoomerangResult` to model-facing text with the `errorKind`
     leading on failure (model branches on KIND, not prose).
   - `index.ts` — barrel + `delegateTools(port)` builder (single-element array,
     mirroring `subagentBgTools` shape).

2. **New composition-root builder `src/agent/tier1/delegate.ts`** —
   `buildDelegateBlock(config)` reads `config.delegation?.delegator`; absent ⇒
   `[]`. The producer `DelegationPort` is a structural SUPERSET of the tool-side
   narrower port (it additionally carries `describeMode`), so the adaptation is
   a direct narrowing assignment — no wrapper needed. Mirrors
   `buildSubagentBgBlock` exactly.

3. **Three surgical wire edits**:
   - `src/agent/tier1/index.ts` re-exports `buildDelegateBlock`.
   - `src/agent/features.ts` pushes `buildDelegateBlock(config)` into
     `extraTools` (sibling to the `buildSubagentBgBlock` line).
   - `src/agent/types.ts` adds `"delegation"` to the `FeaturesConfig` Pick union
     (documents the new features.ts consumer; keeps the Pick from drifting away
     from `AgentConfig`).

### `delegate` vs `subagent_fork` — "when not to use" guidance

The tool DESCRIPTION explicitly steers the model:

- It BLOCKS the parent. If parallel work is needed while the child runs, use
  `subagent_fork` + `subagent_await` instead.
- For a SIMPLE step the parent can do itself (read one file, run one command),
  do it directly — delegation spends a whole child conversation + a turn/token
  budget and only pays off for a self-contained subtask that benefits from an
  isolated context and a posture.

### HITL tier

`always-confirm` (more conservative than `subagent_fork`'s `pre-approval-ok`):
the synchronous path has no concurrency cap and blocks the parent, so a full
mode-posture child conversation defaults to confirm.

## Consequences

- **Default-OFF / byte-identical.** No `config.delegation` ⇒ `extraTools` is
  unchanged, the registry is byte-identical, no child is ever spawned. Proven by
  hellgate cases (4) slot-absent and (5) slot-wired.
- **NO-THROW preserved.** The port contract is no-throw for operational
  failures; the tool additionally wraps the call in try/catch so an unexpected
  (programmer-bug) throw degrades to a graceful `ok:false` rather than bubbling
  past the loop.
- **Slice-fence clean.** `@/tool/delegate` never imports `@/agent`; the
  duck-typed mirror + the tier-1 composition root are the only bridge. The
  mode-mirror drift guard pins `DELEGATE_MODES === AGENT_MODES`.
- **No heuristics.** Mode is a closed enum; budget overflow is enforced by the
  producer port (returns typed `errorKind`); no thresholds invented here.

## Alternatives considered

- **Inject the port via `ToolContext` (a new seam) rather than the tier-1
  builder.** Rejected — the background trio establishes the convention that the
  port is passed to the tool at BUILD time from config, via the tier-1 builder.
  Following that keeps the seam count flat and the wire mirror obvious.
- **Add a separate `explore` tool / method.** Rejected and explicitly
  documented — `explore` is a mode value, not a port method. A separate tool
  would duplicate the surface for one of five modes.
