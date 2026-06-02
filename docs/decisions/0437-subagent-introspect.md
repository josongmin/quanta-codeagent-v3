# ADR-0437 — Subagent introspection: `list_agents` + `followup_task`

- Status: Accepted
- Date: 2026-06-02
- RFC: `docs/plans/jun-2-misc/04-subagent-introspect.md`
- Slice: `src/subagent/introspect-tools.ts`, `src/subagent/turn-wake.ts`,
  `src/subagent/agent-meta.ts` (new) + `src/agent/tier1/subagent-introspect.ts`
- Absorbs: Codex `multi_agents_v2/{list_agents, followup_task}` (codex-rs 0.135)

## Context

quanta has spawn / wait / close / send_input + a rich mailbox, but two gaps:

1. **No enumeration tool** — `TaskRegistry.list()` is host-internal; the LLM
   cannot ask "which children are alive?". `wait_agent` needs an id already;
   `subagent_read_messages` only surfaces children that messaged first.
2. **No message + immediate-turn-trigger** — `send_input` only delivers to a
   child *paused* on a one-shot input channel; the mailbox is only seen when a
   child *reads*. Neither actively wakes a child's next loop iteration.

Codex's `list_agents` and `followup_task` fill exactly these two.

## Decision

Two new LLM tools in a new `@/subagent` slice, both default-OFF:

- **`list_agents`** — read-only, concurrency-safe enumeration over
  `TaskRegistry.list()` (snapshot copy). 4-status registry union narrowed to a
  3-bucket view (`running` / `settled` / `failed`); `prefix` filters by id OR
  label; `includeSettled` toggles finished children; `limit` caps. Depth/label
  come from an optional `AgentMetaRegistry` side-table (option B — the frozen
  `TaskRecord` is NOT mutated); absent ⇒ `depth=0` + a description-derived
  label.
- **`followup_task`** — deliver-and-trigger to a non-root running child.
  Delivery is SYNTHESIZED over the injected mailbox `send` (NOT a new store —
  the mailbox keeps its quota/escape/NO-THROW protections); the trigger is a
  new persistent `TurnWakeRegistry` (sibling of `InputChannelRegistry`, but
  persistent + for busy/idle children, not one-shot/paused). Outcome:
  `woke` (idle → immediate turn), `queued` (mid-turn → next turn), or
  `no-receiver`. `interrupt:true` passes `reason:"interrupt"` to the waker.

### Wiring

- `spawn_agent` (6-tool) records `{depth,label}` into the optional
  `AgentMetaRegistry` (new optional dep on `SpawnAgentDeps`/`Subagent6Deps`) —
  no-op when unwired, byte-identical spawn path.
- The host owns one `TurnWakeRegistry` (`config.subagentTurnWake`) and one
  `AgentMetaRegistry` (`config.subagentAgentMeta`), shared between the runner
  (writer) and the introspect tools (reader).

### Policy decisions

- **Non-root only**: root is the main loop, never in the registry, so an
  unknown id naturally covers a root-targeting attempt (`cause:"id_unknown"`).
- **Self-target**: rejected (`cause:"self_target"`) when the host injected the
  caller's own id.
- **Honest degradation**: no live waker ⇒ `cause:"no_waker"` but the mailbox
  delivery still stands (the target sees the message on its next read).

### Stubbed vs wired (honesty)

- `list_agents` is fully wired: reflects real `TaskRegistry` + `AgentMetaRegistry`
  state, including a spawn-through-6-tool integration test.
- `followup_task` delivery (mailbox) is fully wired. The trigger port
  (`TurnWakeRegistry`) is fully functional and tested (deliver+trigger+queue+
  interrupt+no-waker), and the composition root shares the instance. The
  runner registering real per-child wakers INTO its `runAgent` loop (the
  idle→woke / mid-turn→queued seam) is the documented follow-up per RFC §11 —
  until then `followup_task` honestly reports `no_waker` and the message is
  still delivered. No silent no-op.

## Default-OFF

`buildSubagentIntrospectBlock` returns `[]` unless `enableIntrospect` /
`enableFollowup` are set; `followup_task` additionally needs the
mailbox+wake substrate. Gates off ⇒ tools absent ⇒ byte-identical.

## Knobs

- `config.subagent.enableIntrospect: boolean` → `list_agents`.
- `config.subagent.enableFollowup: boolean` → `followup_task` (needs
  `config.subagentMailbox` + `config.subagentTurnWake`).
- `config.subagentAgentMeta?` — optional depth/label side-table.

## Tests

`tests/unit/subagent-introspect-hellgate.test.ts` — RFC §8's 16 cases (list
reflectivity/bucketing/prefix/concurrency-safe/depth-label/limit; followup
deliver+trigger/queue/interrupt/not-found/settled/no-waker/self-target/root)
+ gating/default-OFF + a wired spawn→list integration + TurnWakeRegistry units.
24 tests.

## Consequences

- The LLM can enumerate live children and push a child to act now.
- Frozen contracts (`registry.ts`, `tools-6.ts`, `handlers-6.ts` schemas) are
  untouched; all new state is isolated side-ports.
