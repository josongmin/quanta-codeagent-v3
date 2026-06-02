# ADR-0459: Command-hooks composition-root wire (security-reviewed activation of ADR-0454)

**Status:** Accepted (2026-06-03)
**Type:** Composition-root wire for the existing ADR-0454 slice — NO new slice logic.
**Scope:** `src/apps/agent/index.ts` (the agent composition root) + the
`AssembleRequestPartial.commandHookBindings` thread. Reuses the ADR-0454 slice
verbatim (`src/agent/command-hooks/*`). No change to the slice's security model.

## Context

ADR-0454 shipped a complete, 25-hellgate-sealed command-hooks slice: a runner
that executes user-authored `settings.json#hooks` shell commands on HookBus
events, triple-gated (enabled + acknowledgedRisk + ≥1 binding), injection-safe
(payload is stdin-JSON, never the command string), env-allowlist-scrubbed, and
timeout-bounded. But `installCommandHooks` was never called at any composition
root — the slice was a dead seam. The 2026-06-02 audit corrected its fc maturity
L3→L2 and the ADR-0454 deliberate_hold deferred the root wire to "a dedicated
composition-root ADR" precisely because it ARMS ARBITRARY SHELL EXECUTION and
warranted a security review rather than an incidental wire. This ADR is that
review + the wire.

## Decision

Wire command-hooks at the agent composition root, default-OFF, gated by an
explicit env opt-in, threading the async settings load through the partial so
the SYNC `buildBaseFromArgs` (and its ~21 callers) stays synchronous.

### Activation path

1. **runMain (async)** — ONLY when `QUANTA_COMMAND_HOOKS=1`:
   `partial.commandHookBindings = await loadCommandHookBindings(
   join(process.cwd(), "settings.json"))`. Matches the existing migration
   translator's `settings.json#hooks` read path. Knob unset ⇒ not loaded.
2. **buildBaseFromArgs (sync)** — `installCommandHooksIntoBase(base, env, p.commandHookBindings)`:
   - Knob unset ⇒ return (no config, no throw, no handlers — byte-identical).
   - Build `CommandHookConfig { enabled:true, acknowledgedRisk: QUANTA_COMMAND_HOOKS_ACK, bindings }`.
   - `normalizeCommandHookGate(config)` — **throws** `CommandHookConfigError`
     when enabled without an acknowledgement (fail-fast at startup, never mid-turn).
   - Not armed (ack present but no bindings) ⇒ return (no-op).
   - Armed ⇒ get-or-mint the HookBus (`base.hooks ?? new HookBus()`; reuses the
     observability bus if present — command hooks are independent of
     `QUANTA_OBSERVABILITY`), then `installCommandHooks(bus, gate, deps)`.

### Permission port — the triple-gate is the approval

The original ADR-0454 spec imagined routing `CommandHookPermissionPort.isAllowed`
through a permission decision. Investigation found `PermissionMode` is
`default | acceptEdits | bypass | auto` — there is **no read-only/plan mode** to
gate on (read-only is a separate `sandboxPolicy` axis not present on the base at
build time). Per an explicit design decision, the **triple-gate IS the approval**:
the operator (a) set `enabled`, (b) typed an audit-grade `acknowledgedRisk`
string, and (c) authored the bindings on disk — three deliberate, auditable acts.
So the wired port is `{ isAllowed: () => true }`. `bypass` mode is the recommended
operating posture. The port remains an **injected seam**: a host MAY supply a
stricter port (e.g. routing through an interactive approval) without touching the
slice.

### Security invariants the wire does NOT weaken

All enforced INSIDE the ADR-0454 slice; the root only supplies config + ports:
1. **Fail-fast**: `enabled` without `acknowledgedRisk` ⇒ throws at startup.
2. **Injection-safety**: the command is the argv tail verbatim; the event payload
   reaches the child only as stdin JSON — there is no interpolation surface.
3. **Env-allowlist**: every exec scrubs to `DEFAULT_ENV_ALLOWLIST` (the shell
   tool's single source of truth) — parent secrets never leak.
4. **Timeout + output cap**: each command is wall-clock-bounded; a timeout is a
   fail-closed DENY.
5. **Bindings provenance**: bindings come ONLY from `settings.json#hooks`
   (operator-authored on disk) — never hardcoded, never model-derived.

### Default-OFF / byte-identical

`QUANTA_COMMAND_HOOKS` unset ⇒ no settings read, no config, no gate, no bus
minted by this path, zero handlers ⇒ the HookBus + event stream are byte-identical
to the pre-wire agent.

## Consequences

- Command hooks are now operator-activatable end-to-end (`QUANTA_COMMAND_HOOKS=1`
  + `QUANTA_COMMAND_HOOKS_ACK="<reason>"` + `settings.json#hooks`).
- ADR-0454 fc maturity returns to L3 (live root consumer); the remaining
  deliberate_hold is only the DockerSandbox-backed exec port for true OS
  isolation (a clean future swap of `createSandboxCommandHookExec`).
- A host wanting a stricter permission decision injects its own
  `CommandHookPermissionPort` — no slice change.

## Evidence

- Code: `src/apps/agent/index.ts` (`installCommandHooksIntoBase`, the
  `commandHookBindings` partial thread, the runMain async load); slice unchanged
  at `src/agent/command-hooks/*`.
- Tests: `tests/unit/apps/agent/command-hooks-wire-hellgate.test.ts` (5 cases:
  default-OFF no-op / enabled-without-ack throws / disarmed no-op / armed mints
  bus / reuses existing bus) + the 25-case slice hellgate
  (`tests/unit/command-hooks-hellgate.test.ts`) for the emit→exec→verdict behavior.
- Knobs: `QUANTA_COMMAND_HOOKS` (1 ⇒ arm), `QUANTA_COMMAND_HOOKS_ACK`
  (audit-grade acknowledgement; required when armed).
