# ADR-0437 — Subagent introspection: `list_agents` + `followup_task`

- Status: Accepted
- Date: 2026-06-02
- RFC: `docs/plans/jun-2-misc/04-subagent-introspect.md`
- Slice: `src/subagent/introspect-tools.ts`, `src/subagent/turn-wake.ts`,
  `src/subagent/turn-gate.ts` (follow-up), `src/subagent/agent-meta.ts` (new) +
  `src/agent/tier1/subagent-introspect.ts`, `src/agent/subagent-runner.ts` +
  `src/agent/loop.ts` (follow-up wiring)
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
  interrupt+no-waker), and the composition root shares the instance.
- **CLOSED (2026-06-02 follow-up, RFC §11): the runner now registers a real
  per-child waker into its `runAgent` loop.** See "Turn-wake gate" below. The
  prior `no_waker` honest-degrade now only fires when the feature is OFF / no
  wake registry is wired / the target already settled — never as a silent
  no-op for a live wired child.

### Turn-wake gate (ADR-0437 follow-up — closes the limitation)

The missing piece was that nothing *registered* a per-child waker, so
`wake()` always returned `no-receiver`. Now:

- `spawn_agent` (`handlers-6.ts`) threads its registry **`taskId`** onto
  `SubagentRequest` (new optional field) — the same id `followup_task`,
  `wait_agent`, and `close_agent` target.
- The runner (`createSubagentRunner`), when BOTH `config.subagentTurnWake` AND
  `req.taskId` are present, mints a per-child **`SubagentTurnGate`**
  (`src/subagent/turn-gate.ts`) and registers a `Waker` (bridged to that gate)
  under `taskId` into the shared `TurnWakeRegistry`. The gate is threaded onto
  the **child** config (`config.subagentTurnGate`); the disposer (unregister +
  release) runs in the runner's `finally`, BEFORE the registry settles the
  task, so a `followup_task` racing completion sees `no-receiver`.
- The child agent loop (`src/agent/loop.ts` `runAgentTurnLoop`), at its **clean
  `completed`** finish, PARKS on the gate (`shouldParkOnGate`) instead of
  exiting. The gate's `wait`:
  - resolves `woke` when a wake arrives while parked (idle) ⇒ the loop runs
    another turn;
  - resolves `resume` when a wake was already pending (the loop was busy when
    `followup_task` fired) ⇒ the queued turn runs now;
  - resolves `settle` on the abort signal / dispose ⇒ the loop really finishes.
  On `woke`/`resume` the loop `continue`s the `for` — and the **next turn's
  top-of-loop mailbox read** surfaces the delivered followup. This REUSES the
  existing per-turn injection seam; there is no second turn driver.
- **idle vs busy** (the `woke`/`queued` distinction) is decided by whether the
  loop is currently parked on the gate: parked ⇒ `woke` (released now), not
  parked ⇒ `queued` (a pending flag the next `wait` consumes). PURE: no clock /
  `Math.random` / real timer — the gate is driven only by `wake`/abort events;
  child lifetime is bounded by the parent's `task_stop`/cancel (the abort
  signal), which is the deterministic "stop waiting" event.
- **Default-OFF / byte-identical**: only `completed` parks (error/refusal/
  budget/aborted finish exits at once), and only when a gate is wired. Root
  sessions never carry a gate. No wake registry OR no `taskId` ⇒ no waker, no
  gate, `followup_task` honest-degrades to `no_waker` exactly as before.

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

`tests/unit/subagent-turn-wake-gate-hellgate.test.ts` — the follow-up wiring:
gate idle→woke / busy→queued(resume) / abort→settle / dispose→settle units;
runner registers a waker under `req.taskId` (+ no-waker on default-OFF / no
taskId); and an END-TO-END proof against a real `runAgent` child loop that a
`followup_task` wake makes the child run ANOTHER observable turn (LLM called
again), with the no-wake path byte-identical (one turn) + `no_waker` degrade.
11 tests.

## Consequences

- The LLM can enumerate live children and push a child to act now.
- Frozen contracts (`registry.ts`, `tools-6.ts`, `handlers-6.ts` schemas) are
  untouched; all new state is isolated side-ports.
