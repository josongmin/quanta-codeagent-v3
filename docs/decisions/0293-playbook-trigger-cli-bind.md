# ADR-0293 — playbookTrigger CLI auto-bind opt-in

Status: Accepted
Date: 2026-05-25
Owner: @songmin
Layer: src/apps/cli/repl
Slice: playbook-trigger CLI wire seam
Default-OFF: yes (RFC §1.2)

## Context

ADR-0203 (user-authored playbook frontmatter) + ADR-0240 (auto-dispatch
orchestrator) define a complete inline-trigger pipeline: a file save with
the configured comment marker fires an `onFire` callback, which the
orchestrator routes to a `PlaybookPlanQueueSink.enqueue(...)`. Wiring lives
in `src/skill/playbook/wire.ts:startPlaybookFromTrigger(...)` and bridges a
host-supplied `AgentConfig.playbookTrigger` slot to the orchestrator.

Today the slot is NEVER populated by the default composition root —
`src/apps/agent/index.ts:buildBaseFromArgs` does not construct it, so the
watcher is dead-code unless a custom host wires it manually. The CLI host
needs a one-line opt-in (env var OR flag) so operators can flip the trigger
on without writing TypeScript.

## Decision

Add a CLI-side `maybeStartPlaybookTriggerWire(opts)` helper that:

1. Detects opt-in via `QUANTA_PLAYBOOK_TRIGGER === "on"` (literal, case-
   sensitive) OR `cliFlag === true`.
2. Constructs an FS-rooted `InlineTriggerWatcherPort` (existing
   `createInlineTriggerWatcher()`) pointed at `<cwd>/.quanta/playbooks` by
   default.
3. Calls `startPlaybookFromTrigger({ enabled: true, watcher, registry,
   planQueueSink, threadId, defaultRoot })` and returns the controller
   wrapped in a `PlaybookTriggerWireHandle` (`stop()` + `isActive()`).
4. Sibling surface seam (`createPlaybookTriggerSurfaceSeam()`) — the
   session-bootstrap host calls `seam.attach(handle)` at session start and
   `seam.detach()` at session finish. The seam owns at most one live handle
   and stops a prior handle on re-attach.
5. CLI parser exposes `--playbook-trigger` (boolean, parsed in
   `cli-args.ts:parseAgentArgs`) and surfaces it in the help text.

### Env vs flag precedence

`QUANTA_PLAYBOOK_TRIGGER=on` WINS over `cliFlag === false`. Rationale:
operators commonly set env vars to override a hard-coded default in CI/
scripts; honoring the env even when a flag is explicitly false matches the
"env is escape hatch" pattern used elsewhere in the codebase. See
`tests/unit/playbook-trigger-cli-bind-hellgate.test.ts:HELL-PT-04`.

### Registry root scan

The CLI bind opt-in does NOT scan SKILL.md files today. A real
`PlaybookRegistry` requires the playbook discovery pass (separate slice)
and would mutate the playbook surface. Instead the helper passes an
EMPTY_REGISTRY placeholder — `enabled: true` is byte-identical to "no
registrations matched" (the orchestrator simply doesn't spawn watcher
subscriptions). A follow-up PR will inject a real registry through the
surface seam.

### No-throw + default-OFF allocation

- Default-OFF path returns a SHARED FROZEN `NOOP_HANDLE` singleton — zero
  allocation when neither env nor flag is set. `Object.isFrozen` pinned by
  `HELL-PT-13`.
- Registry root missing / non-directory ⇒ `logger.warn` + NOOP handle.
- `startPlaybookFromTrigger` throwing (defense-in-depth) ⇒ `logger.warn` +
  NOOP handle.
- The caller-supplied `planQueueSink` is wrapped in `safeSink` that
  catches throws and surfaces them as `{ok:false, reason}` to the
  orchestrator + logs via `logger.warn`.

## Consequences

### Positive

- Operators can flip the trigger on with `--playbook-trigger` or
  `QUANTA_PLAYBOOK_TRIGGER=on` — no code changes.
- Surface seam keeps the session-bootstrap edit out of THIS slice. A
  follow-up PR wires `seam.attach/detach` at the bootstrap/finish call-
  sites; until then both files stand alone and are fully tested.
- Default-OFF byte-identical: absent env + absent flag ⇒ zero allocation,
  zero observable change.

### Negative / Trade-offs

- No registry scan yet — the trigger fires but nothing is dispatched until
  a follow-up PR populates the registry. Acceptable for an opt-in seam:
  the wire is correct; the data is empty.
- The complexity warning on `parseAgentArgs` rose from 93 → 96 (pre-
  existing warning, max 15). Accepted tech debt; refactoring is a separate
  ADR.

### Out of scope

- Registry-from-disk scan (SKILL.md walker → `PlaybookRegistration[]`).
- Wiring the seam into `session-bootstrap.ts` / `session-loop.ts` (those
  files are in-flight on a parallel track per task brief).
- Closing the slot in `apps/agent/index.ts:buildBaseFromArgs` (in-flight).

## Files

- `src/apps/cli/repl/playbook-trigger-wire.ts` — `maybeStartPlaybookTriggerWire`
- `src/apps/cli/repl/playbook-trigger-surface-seam.ts` — surface seam
- `src/apps/agent/cli-args.ts` — `--playbook-trigger` flag plumbing
- `tests/unit/playbook-trigger-cli-bind-hellgate.test.ts` — 13 hellgate cases
- `biome.json` — exempt the new hellgate test from the apps/cli slice-
  isolation rule (the test deliberately imports the CLI helper to test it)

## Test plan

Hellgate cases (13 total):

| ID | Case |
| --- | --- |
| HELL-PT-01 | env absent + flag absent ⇒ NOOP handle |
| HELL-PT-02 | env "on" + flag absent ⇒ active handle |
| HELL-PT-03 | env absent + flag true ⇒ active handle |
| HELL-PT-04 | env "on" + flag false ⇒ active (env wins) |
| HELL-PT-05 | active handle: stop() idempotent (no throw / no warn) |
| HELL-PT-06 | registry root missing ⇒ logger.warn + NOOP |
| HELL-PT-07 | surface seam attach/detach/current round-trip |
| HELL-PT-08 | surface seam detach on never-attached is no-op |
| HELL-PT-09 | env "off" ⇒ NOOP (literal-"on" gate) |
| HELL-PT-10 | env "1"/"true"/"ON" ⇒ NOOP (no truthiness/case fold) |
| HELL-PT-11 | throwing sink ⇒ wire survives (defense-in-depth) |
| HELL-PT-12 | surface seam attach replaces prior handle (stops it) |
| HELL-PT-13 | default-OFF returns the shared FROZEN NOOP singleton |

Gate posture: 13 pass / 0 fail / `bunx tsc --noEmit` 0 errors on slice /
`bunx biome check` 0 errors on slice (pre-existing complexity warning on
`parseAgentArgs` unchanged).
