# ALBB-14 — Dead wires: identity per-turn reminder + automation ticker delivery

**Priority:** P2  <!-- downgraded from P1: both halves are default-OFF silent no-ops for opted-in operators, not crash/data-loss -->
**Wave:** C
**Depends on:** none
**Owner:** `src/agent/loop-helpers.ts`, `src/agent/loop/turn-iteration.ts`, `src/agent/loop/session-bootstrap.ts`, `src/host/runtime/agent-arg-builder.ts`
**Verdict:** keep (single ticket — two tightly-related dead-wire defects sharing the
`wire-or-hold-knob` fix pattern; no other bug-bash ticket overlaps).

## Goal

Wire the two documented-but-uncalled features so an opted-in operator gets the behavior
the ADR promises, OR hold the knob fail-loud. Kill the "knob-on-but-inert silent no-op"
class both halves currently exhibit.

## Problem (ground-truth verified 2026-07-09)

### 1. ADR-0239 identity per-turn reminder — defined, exported, NEVER called by the loop

`shouldSpliceIdentityReminder` (`src/agent/loop-helpers.ts:558`) and
`buildIdentityReminderText` (`src/agent/loop-helpers.ts:572`) are fully implemented.
The ADR contract at `src/agent/types/wire-slots-compose.ts:89-101` promises a per-turn
splice:

> ADR-0239 — when `perTurnReminderEnabled` is `true`, the loop ALSO splices the variant's
> identity lines into the per-turn working memory as a trailing `<system-reminder>` user
> message — Codex `ARCHITECT_NOTICE` / `EDITOR_NOTICE` pattern.

But `grep` for both symbols across `src/` returns call sites ONLY inside `loop-helpers.ts`
itself and under `tests/`. The turn injector block in `prepareTurnIteration`
(`src/agent/loop/turn-iteration.ts:199-206`) wires three siblings and NOT identity:

```ts
injectFocusChainMessage(args.cfg, args.wm)            // :199
injectWorkflowKeywordNudge(args.cfg, args.wm)         // :202
injectTurnBudgetReminder(args.cfg, args.wm, args.turn) // :206
```

⇒ `perTurnReminderEnabled` is **inert**: an operator can set it `true` and nothing ever
splices into the assembled working memory. Default-OFF, so impact is a silent no-op for
opted-in operators (not a crash).

Compounding silent path: the registry-throw branch in `buildIdentityReminderText`
swallows without a trace (`src/agent/loop-helpers.ts:584-586`):

```ts
  } catch {
    return undefined
  }
```

If the knob says "splice" (`shouldSpliceIdentityReminder === true`) but the registry
`variantFor` throws, the reminder silently vanishes — no warn, no metric. This is exactly
the knob-on-but-inert failure class this ticket exists to kill.

### 2. ADR-0240 automation ticker — only the CLI delivers; other surfaces schedule-but-drop

`startAutomationEngineTicker` (`src/agent/loop-helpers.ts:488`) has exactly one non-test
call site: `src/apps/cli/repl/session-loop.ts:649`. It returns `undefined` when the
handler is absent (`src/agent/loop-helpers.ts:495`).

The composition-root slot builder `resolveAutomation`
(`src/host/runtime/agent-arg-builder.ts:523`) installs a **stub handler that logs + drops**
(`src/host/runtime/agent-arg-builder.ts:535-548`):

```ts
      agentLoop: {
        enqueueUserMessage: async (_message: string): Promise<void> => {
          // Stub — the unified-agent base does not own an agent loop; ...
          logger.warn(
            "automation handler invoked with stub agent loop — fire ignored. " +
              "A mode-preset must override `automationEngine.handler` with a " +
              "real `AgentLoopPort.enqueueUserMessage`.",
          )
        },
      },
```

The CLI dodges the stub by minting a **fresh** slot with the real
`enqueueWithHeartbeat` handler (`src/apps/cli/repl/session-loop.ts:328-337`), then arming
the ticker at `:649`. But the **web-daemon** reaches this AgentConfig base via
`createRuntimeFromAgentConfigBase` (`src/apps/web-daemon/runtime-factory.ts:502`) and
**never starts a ticker** — `grep` for `Ticker`/`automationEngine` in
`src/apps/web-daemon/` and `src/apps/headless/` returns zero hits.

⇒ On a non-CLI surface with `QUANTA_AUTOMATION=on`, scheduled fires (a) are never ticked
if no ticker is armed, or (b) hit the stub handler, get recorded in the engine's run/inbox
rows, warn once, and are **dropped** — never delivered to a live loop. Default-OFF (slot
omitted unless `QUANTA_AUTOMATION=on`), so this is silent for opted-in operators, not a
crash. The real production delivery gap is **web-daemon specifically** (headless is a
fake-deps dev harness, not a production automation surface).

## Required changes (fail-closed, measure-first)

### Claim 1 — identity reminder

1. **Wire a fourth injector** in `prepareTurnIteration`, right beside the existing three
   (`src/agent/loop/turn-iteration.ts:199-206`). Add `injectIdentityReminder(cfg, wm, mode)`
   delegating to `buildIdentityReminderText`; append the returned
   `<system-reminder>…</system-reminder>` as a synthetic user message via the same
   `makeSyntheticUserMessage` seam `injectFocusChainMessage` uses. Mode comes from the
   turn's active mode (`AgentMode`, `src/agent/prompt.ts:249`). This mirrors the Codex
   `ARCHITECT_NOTICE` / `EDITOR_NOTICE` per-turn nudge cadence the ADR already cites — no
   new baseline invented.
2. **Make the silent registry-throw catch observable** (`src/agent/loop-helpers.ts:584`).
   When `shouldSpliceIdentityReminder` returns `true` but the registry `variantFor` throws,
   emit a one-shot `logger.warn` (dedup per session — mirror the `focus-chain inject failed`
   warn pattern already at `src/agent/loop/turn-iteration.ts:173`) instead of a bare
   swallow. Keep the loop byte-identical when the knob is off (slot absent ⇒ early return,
   no warn).
3. Default-OFF invariant preserved: no `identityModeVariant` slot ⇒ zero allocation, zero
   injected message, byte-identical assembled working memory.

### Claim 2 — automation delivery

1. **Move ticker start/stop into the shared session lifecycle** so ALL surfaces that
   assemble an `AgentConfig` get delivery, not just the CLI. Add
   `maybeStartAutomationTicker(cfg)` in session bootstrap (near where `finishAgentSession`
   is wired, `src/agent/loop/session-bootstrap.ts:257`) and register its `stop()` on the
   existing LIFO close stack so teardown is guaranteed on throw. `startAutomationEngineTicker`
   already returns `undefined` when the wire is incomplete, so this is byte-identical when
   `automationEngine` is absent.
2. **Replace the composition-root stub's silent-drop with a fail-loud path**
   (`src/host/runtime/agent-arg-builder.ts:535-548`). Two acceptable postures; pick one and
   document it:
   - **(a) Surfaces MUST override** `automationEngine.handler` with a real
     `AgentLoopPort.enqueueUserMessage` before assembly. Web-daemon wires its own enqueue
     port (mirroring the CLI's `enqueueWithHeartbeat` at
     `src/apps/cli/repl/session-loop.ts:328-337`). This is the primary target — it closes
     the web-daemon gap for real.
   - **(b) If a surface intentionally leaves the stub**, the drop must be **measured, never
     silent**: increment an explicit `automation.fires_dropped_no_handler` counter on each
     stub invocation (in addition to the existing warn) so the gap surfaces in metrics.
3. **Document the override contract** in `src/agent/types/wire-slots-compose.ts` next to the
   ADR-0240 automation slot (`automationEngine`, ~`:162-195`): state that a surface arming
   the ticker MUST supply a real `handler`, and that the base composition-root handler is a
   fail-loud stub.

Measure-first: do NOT ship any efficacy claim about the identity reminder improving agent
behavior; land the wire default-OFF and A/B the nudge separately. No arbitrary thresholds.

## Acceptance

- Flipping `perTurnReminderEnabled` `false → true` produces a visible `<system-reminder>`
  line in the **assembled** working memory after a real `prepareTurnIteration` turn;
  `false`/absent ⇒ byte-identical absent.
- Registry-throw-during-splice emits a warn/metric instead of vanishing silently.
- A non-CLI (web-daemon-shaped) assembled config with `QUANTA_AUTOMATION=on` + a real
  handler delivers a scheduled fire to that handler.
- The stub path increments `automation.fires_dropped_no_handler` (posture b) OR is
  unreachable because surfaces override the handler (posture a) — proven by test.

## Proof rails (red-on-injection / mutation, not vacuous)

Existing tests today only **unit-call** the helpers — they do NOT exercise the loop wire,
which is why the dead wires passed CI. Promote them to assert against assembled state:

1. **Identity** — upgrade `tests/integration/identity-per-turn-reminder-hellgate.test.ts`
   (currently calls `buildIdentityReminderText` directly, incl. the registry-throw swallow
   case at `:160-182`) to drive a real `prepareTurnIteration` turn and assert against the
   post-turn `WorkingMemory`:
   - `perTurnReminderEnabled: true` ⇒ the `<system-reminder>` identity line is PRESENT in
     `wm`.
   - `perTurnReminderEnabled: false` / slot absent ⇒ byte-identical, line ABSENT.
   - **Mutation guard:** deleting the new `injectIdentityReminder(...)` call in
     `turn-iteration.ts` makes the "present" assertion RED (proves the test is wired to the
     loop, not the helper).
   - **Registry-throw observability:** a variant registry that throws ⇒ the test asserts a
     warn/metric was emitted (spy on `logger.warn`), not a silent `undefined`.
2. **Automation** — add `tests/integration/albb-14-automation-wire.test.ts` (or extend
   `tests/integration/automation-engine-tick-wire-hellgate.test.ts`):
   - With `QUANTA_AUTOMATION=on` + a fake handler + fake `AutomationTickerDeps`
     (`setInterval`/`clearInterval` injection seam at `src/agent/loop-helpers.ts:468`) on a
     **non-CLI** assembled config, a scheduled fire reaches the handler (assert the fake
     `enqueueUserMessage` was called). Mutation guard: removing `maybeStartAutomationTicker`
     from bootstrap makes this RED.
   - Negative: the composition-root stub path increments
     `automation.fires_dropped_no_handler` (posture b) or is proven unreachable via
     handler-override assertion (posture a) — extend
     `tests/integration/composition-root-wire-hellgate.test.ts`, which already asserts the
     `automationEngine` slot shape at `:53,:66`.

```sh
bun test tests/integration/identity-per-turn-reminder-hellgate.test.ts
bun test tests/integration/automation-engine-tick-wire-hellgate.test.ts
bun test tests/integration/composition-root-wire-hellgate.test.ts
# new:
bun test tests/integration/albb-14-automation-wire.test.ts
```
