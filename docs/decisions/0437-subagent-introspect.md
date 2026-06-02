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
  `no-receiver`. `interrupt:true` passes `reason:"interrupt"` to the waker,
  which — on a BUSY child — ABORTS the in-flight turn before delivering (see
  "Interrupt" below).

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
  interrupt+no-waker), and the composition root shares the instance via the
  `QUANTA_SUBAGENT_FOLLOWUP=on` knob (2026-06-02 follow-up — `wireOptionalAgentPorts`).
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

### Interrupt (ADR-0437 follow-up — `interrupt:true` now ACTUALLY interrupts)

The prior follow-up made `followup_task` *trigger* a turn, but `wake(reason)`
IGNORED the reason: both `followup` and `interrupt` only triggered a turn, so
`interrupt:true` on a busy child merely QUEUED the message for AFTER the
in-flight turn completed its work — it never stopped anything. That gap is now
**CLOSED**.

- The `SubagentTurnGate` owns a per-turn `AbortController` (`turnAbort`). The
  child loop (`runTurn`, via `buildTurnSessionView`) calls `gate.armTurn(loopSignal)`
  at the top of EVERY turn: it mints a FRESH controller and returns the
  EFFECTIVE turn signal `AbortSignal.any([loopSignal, turnAbort.signal])`. The
  turn body runs against a per-turn session view whose `config.signal` IS that
  effective signal — so the in-flight LLM stream (`llm.stream({signal})`), the
  `streamingTurn` inter-phase abort checks, AND tool dispatch (`ToolContext.signal`)
  all observe it. This is the SAME AbortController→signal→stream/tool mechanism
  `task_stop`/`forceStop` already use to unwind in-flight work — **no parallel
  abort path** was added.
- `wake("interrupt")` on a BUSY (mid-turn, not parked) child aborts `turnAbort`
  (the in-flight stream/tool unwinds NOW) AND records a pending wake. The
  unwound turn returns `{kind:"interrupted"}` (distinct from `aborted`); the
  loop PARKS on the gate, the pending wake resolves `resume`, and a FRESH turn
  runs whose top-of-loop mailbox read surfaces the interrupting message. The
  child is NOT killed — the controller is reset by the next `armTurn`, so a
  fired interrupt never pre-aborts the next turn.
- `classifyTurnAbort` distinguishes the two using the ORIGINAL `loopSignal`: a
  turn-body abort is an INTERRUPT only when `gate.wasInterrupted()` AND the
  lifetime signal did NOT fire; otherwise it is a genuine lifetime cancel
  (`task_stop`/parent cancel) that finishes the child. An interrupt can never
  masquerade as a finish, and a real cancel can never be mistaken for a
  resumable interrupt.
- On an IDLE (parked) child there is nothing in flight, so `interrupt` is
  identical to `followup`: release the park (`woke`). `wake("followup")` NEVER
  aborts — byte-identical to the queue-only contract.

**What "interrupt" guarantees (turn-level, honestly scoped).** The in-flight
LLM stream aborts and `streamingTurn` stops dispatching further tool calls
between phases; an already-running tool observes the effective signal via its
`ToolContext.signal` (cooperative abort — the SAME cooperative contract
`task_stop` has today). We do NOT forcibly kill a tool that ignores its abort
signal mid-syscall. So the guarantee is **turn-level + cooperative-tool-level**:
the current turn's work unwinds at the next cooperative abort point, then a
fresh turn handles the message. This is the deepest interrupt reachable through
the existing AbortController seam without inventing a separate kill channel.

- **Default-OFF / byte-identical**: no gate ⇒ `buildTurnSessionView` returns the
  SAME session by identity (NO clone, NO `AbortSignal.any`) and `classifyTurnAbort`
  always returns `aborted` — the turn body is byte-for-byte the pre-feature path.
  Interrupt machinery only exists for a child whose runner wired a gate (i.e.
  `subagentTurnWake` + `taskId`).

## Default-OFF

`buildSubagentIntrospectBlock` returns `[]` unless `enableIntrospect` /
`enableFollowup` are set; `followup_task` additionally needs the
mailbox+wake substrate. Gates off ⇒ tools absent ⇒ byte-identical.

## Knobs

- `QUANTA_SUBAGENT_INTROSPECT=on` — composition-root env knob (strict `=on`).
  Sets `config.subagent.enableIntrospect = true` AND wires a shared
  `AgentMetaRegistry` (richer `list_agents` rows). → `list_agents`.
- `QUANTA_SUBAGENT_FOLLOWUP=on` — composition-root env knob. Sets
  `config.subagent.enableFollowup = true` AND wires BOTH followup dependency
  ports so the tool is FUNCTIONAL: a shared `TurnWakeRegistry` (the TRIGGER
  substrate the runner registers per-child wakers into) + a `createSubagentMailbox`
  (DELIVERY) when not already wired via `QUANTA_SUBAGENT_MAILBOX`. → `followup_task`.
  All three knobs are resolved in `wireOptionalAgentPorts`
  (`src/agent/optional-ports.ts`) — the single env→optional-port wire every
  surface calls (unified-agent mode-presets + CLI via
  `host/runtime/internal/context-binding.ts`). Mirrors the `QUANTA_SUBAGENT_MAILBOX`
  knob idiom. Unset / typo ⇒ slots absent ⇒ byte-identical.
- `config.subagent.enableIntrospect / enableFollowup: boolean` — the underlying gates.
- `config.subagentAgentMeta?` — optional depth/label side-table.

> **2026-06-02 follow-up — limitation CLOSED.** The runner-level turn-wake gate
> (below) made `followup_task` *functional*, but NO composition root set
> `enableIntrospect`/`enableFollowup` or wired the `TurnWakeRegistry`/mailbox
> from env, so `list_agents`/`followup_task` never reached the registry in a
> real session (dead seam). With `QUANTA_SUBAGENT_FOLLOWUP=on` the shared
> `TurnWakeRegistry` is now wired at the composition root, so the runner's
> per-child waker registration has a live registry to register into — a
> `followup_task` against a running child reports `triggered` (not `no_waker`).

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

`tests/unit/subagent-turn-interrupt-hellgate.test.ts` — `interrupt:true` ACTUALLY
interrupts: GATE units (busy interrupt aborts THIS turn's signal + records
pending→resume; armTurn RESETS the controller; idle interrupt = plain wake;
followup NEVER aborts; the effective signal fires on a real lifetime abort but
`wasInterrupted` stays false; interrupt-before-armTurn degrades safely) + an
END-TO-END proof against a real `runAgent` child whose turn BLOCKS in an
in-flight LLM stream: `followup_task(interrupt:true)` makes the in-flight
stream's signal FIRE (the turn unwinds) AND a SECOND turn run; a non-interrupt
followup does NOT abort the in-flight stream (regression); idle interrupt is a
plain wake; no-waker honest-degrade unchanged; default-OFF (no gate) byte-
identical. 11 tests.

`tests/unit/subagent-knobs-wire-hellgate.test.ts` — the composition-root env
wire: `QUANTA_SUBAGENT_{BATCH,INTROSPECT,FOLLOWUP}=on` ⇒ the corresponding
flags + dep ports (`AgentMetaRegistry`/`TurnWakeRegistry`/mailbox) are wired and
the tier-1 builders register the tools; a `followup_task` against a child with a
live waker reports `triggered` (NOT `no_waker`); every knob unset ⇒ base
unchanged + zero tools (byte-identical); strict `=on` (typo ⇒ off);
caller-override-precedence; env→flag fold pure + total. 12 tests.

## Consequences

- The LLM can enumerate live children and push a child to act now.
- Frozen contracts (`registry.ts`, `tools-6.ts`, `handlers-6.ts` schemas) are
  untouched; all new state is isolated side-ports.
