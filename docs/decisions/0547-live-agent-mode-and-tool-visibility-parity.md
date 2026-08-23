# ADR-0547 — The live AgentMode reaches the gate, and the model is never shown a tool dispatch will refuse

Status: Accepted (2026-08-24)
Slice: `src/agent/mode.ts` · `src/agent/types.ts` · `src/agent/loop/stream-consume.ts` · `src/sdk/runtime/context.ts` · `src/apps/cli/repl/session-loop/bootstrap.ts`
Feature: `live-agent-mode-tool-parity` (feature-catalog §3-permission-safety)
Related: ADR-0036 (plan vs default collaboration mode) · ADR-0303 (per-turn posture sync) · ADR-0443 / RFC-08 (mode cycle) · ADR-0512 (skill-scope visibility filter — the precedent this mirrors)

## Context

### 1. The PLAN pill promised a guarantee nothing enforced

`MODE_CYCLE`'s plan rung is `{ permissionMode: "default", agentMode: "plan" }`, described to the operator as **"research and propose, never touch files"**.

The `permissionMode` half reaches `createSession`. The `agentMode` half reached a status pill and nothing else: `RuntimeSessionConfig` had no mode field at all, and `agentMode` appeared nowhere under `src/host/**`, `src/sdk/**` or `src/agent/**`. So `shift+tab` → PLAN repainted the chrome while the agent kept full write capability.

The gap was easy to miss because the launch-time paths **do** work: `--plan` / `QUANTA_PLAN=1` set `features.planMode` → `cfg.planMode`, and the dispatch gate honors that. Only the interactive cycle — the affordance an operator actually reaches for — was inert.

A posture that is announced but not enforced is worse than one that does not exist, because the operator stops watching after the CLI tells them it is safe.

### 2. A read-only mode still advertised tools dispatch would refuse

`visibleSpecs` was filtered by the **skill** gate only. In plan/review/audit the model was advertised `write`, `edit`, `apply_patch` and `bash` — all refused by the dispatch gate — so it spent a turn calling one and reading a denial. The skill-scope code comments name this exact failure ("see-but-can't-call") as the reason the skill filter exists; mode never got the same treatment.

## Decision

**One live resolution, used everywhere.** `resolveLiveAgentMode(source)` reads `agentModeState?.get()` first, then the fixed `mode`, then legacy `planMode`. Every consumer that previously called `resolveAgentMode(config.mode, config.planMode)` — the prompt, the admissibility gate, the plan-enter wire, the skill gate, the turn iteration, and `resolveCollaborationMode` (the dispatch seam) — now goes through it. Read once per turn, never mid-turn, matching `permissionModeState`'s contract.

**One mode predicate, two call shapes.** `isToolBlockedInMode(mode, isReadOnly)` is the rule; `isMutatingToolBlockedInMode(mode, action)` delegates to it. The visible-spec filter and the dispatch gate therefore consult the *same* predicate over the *same* value — `registry.isReadOnly(name)` is exactly the `action.isReadOnly` the gate reads — so visible == dispatchable by construction rather than by convention.

**Read-only tools are never hidden.** Plan mode has to be able to investigate, and `request_plan_exit` has to stay reachable or the model cannot leave the mode it is in.

**Wiring.** `agentModeState` is a pass-through compose key, and the REPL bootstrap folds in `{ get: () => modeCycle.current().agentMode }` — a *reader*, not a snapshot, which is what makes a mid-session flip real. No cycle wired ⇒ the slot is omitted ⇒ the launch-time `--plan` path is byte-identical.

## Consequences

- Fail-closed is preserved and asserted: an unrecognized mode hides mutating tools rather than advertising them, because `MUTATING_MODES` membership is the test.
- The paired control is load-bearing. A "fix" that hid mutating tools in every mode would satisfy the parity invariant and destroy the product, so `default`/`editor` are asserted to keep the full surface.
- `PASS_THROUGH_COMPOSE_KEYS` is now exported so the wiring proof asserts the contract at runtime rather than by grepping the source — a key silently dropped from that list is exactly how a wired-looking feature ends up reaching nothing.
- Three injections each produce a distinct RED: removing the spec filter, making the live resolution ignore `agentModeState`, and dropping the compose key.
- Two functions crossed the 150-line god-function cap from the additions and were split (`withLiveAgentMode`, `resolveVisibleSpecs`) rather than allowlisted.
