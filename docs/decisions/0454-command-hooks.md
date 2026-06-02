# ADR-0454 — Disk-configured command hooks (security-gated shell on HookBus events)

Status: accepted
Date: 2026-06-02
Slice: `src/agent/command-hooks/`
Tests: `tests/unit/command-hooks-hellgate.test.ts`

## Context

quanta's `HookBus` (`src/agent/hooks.ts`) is purely in-process TS callbacks
(`.on(type, handler)`). It has no way to run a user-authored shell command on a
hook event — the Claude Code `settings.json#hooks` model, where the harness
executes `{ "type": "command", "command": "..." }` entries.

The migration translator (`src/migration/translators/claude-code-config.ts`)
already PARSES those command-hook entries into `TranslatedHook`, but
`src/apps/cli/session-import-handler.ts` only COUNTS them — there was no
executor. This ADR adds the missing executor.

Command hooks run **arbitrary user shell**, so this is security-sensitive. The
design is built around a strict opt-in trust model rather than turning shell
execution on by default.

## Decision

A closed-port slice that, on a matching HookBus event, runs the configured
shell command(s) ONE-SHOT through an injected spawn port, passing the hook
event payload as JSON on the child's stdin (the Claude Code contract), and maps
the command's exit code / stdout back to the HookBus `deny` / `updatedInput`
channels.

### Components

- `types.ts` — the closed ports: `CommandHookExecPort` (one-shot
  stdin-capable spawn), `CommandHookPermissionPort` (approve/deny), and the
  config / gate / verdict types. Typed errors + documented defaults.
- `gate.ts` — `normalizeCommandHookGate` (the security funnel) +
  `mapClaudeEvent` (Claude event name → quanta `HookEventType`).
- `settings-loader.ts` — reads `settings.json#hooks` (the exact Claude shape
  the translator understands) into flat bindings. Missing/malformed ⇒ `[]`.
- `runner.ts` — `runCommandHooks`: select matching bindings, check permission
  ONCE per event, serialize the payload to JSON stdin, exec each command in
  binding order, fold exit/stdout into one `CommandHookVerdict`.
- `sandbox-exec.ts` — the production `CommandHookExecPort`, reusing the SAME
  `LocalSandbox` confinement (`scrubEnv`, `disclaimedShellArgv`,
  `escalatingKill`, `withSpawnedChild`) plus stdin delivery.
- `install.ts` — `installCommandHooks`: register HookBus handlers that adapt
  `HookEvent` → runner → `HookEmitResult`. Registers NOTHING when disarmed.

## Security model

A command hook ONLY ever spawns a process when ALL of these hold, checked in
order; the first failure makes the path a byte-identical no-op:

1. **Opt-in toggle** — `enabled === true` (strict). Default-OFF.
2. **Risk acknowledgement** — a non-empty `acknowledgedRisk` string the
   operator authored. `enabled: true` WITHOUT it throws `CommandHookConfigError`
   at config time (fail fast, never mid-turn). Mirrors the redaction-disable
   acknowledgement in `src/security/redaction-config.ts`, inverted: there the
   *dangerous* direction is turning protection OFF; here it is turning shell
   execution ON. Whitespace-only ack counts as empty.
3. **At least one binding** — `enabled + ack` with zero command hooks is
   disarmed (nothing to gate), not an error.
4. **Permission gate** — `CommandHookPermissionPort.isAllowed({event, toolName})`
   is consulted ONCE per event before the first spawn. A refusal yields a deny
   verdict and NO spawn. A command hook is treated as a privileged operation
   and routes through the normal approve/deny path.
5. **Confinement** (production adapter) — env-allowlist scrub (parent secrets /
   API keys never reach the child), wall-clock timeout (default 30s, typed),
   combined-output byte cap (default 1MB, typed), dotfile-skipping shell, and
   SIGTERM→SIGKILL escalation. All reuse the existing `LocalSandbox` machinery.

### Injection safety

The user command is the **argv tail** handed to the spawn port verbatim
(`bash --noprofile --norc -c <command>`). It is **never** string-concatenated
with the event payload. The payload — which can be model- or tool-derived —
reaches the command exclusively as JSON written to the child's stdin, then EOF.
There is no interpolation surface through which payload content could alter the
command string. Sealed by a hellgate that feeds a `$(rm -rf /)`-style payload
and asserts the command string is unchanged and the hostile text appears only
inside the stdin JSON envelope.

### Fail-closed verdict mapping

| command result | verdict |
| --- | --- |
| timed out (killed) | **DENY** (`timed out`) — fail-closed; an unbounded hook must not pass the tool through |
| exit ≠ 0 | **DENY** (Claude Code: a non-zero PreToolUse hook blocks the call); reason from stdout JSON `{deny}`/`{reason}` if present |
| exit 0 + stdout `{decision:"block"}` or `{deny}` | **DENY** (structured block) |
| exit 0 + stdout `{updatedInput}` | **REWRITE** the tool args (presence-of-key) |
| exit 0, no structured verdict | neutral (observer) |

Multiple matching commands run sequentially in binding order; the **first deny
wins** (mirrors HookBus deny semantics), the **last updatedInput wins**
(rewrites compose).

## Why reuse the sandbox, NOT the plugin-isolation spawner

The task asked to consider `src/plugin-isolation`. It was evaluated and is the
WRONG fit: `IsolatedProcessSpawnerPort` is a **persistent, line-framed JSON RPC
duplex** that REQUIRES a READY-sentinel first stdout line and rejects a child
that exits before emitting one (`spawn-timeout` / `spawn-failed`). A command
hook is a **one-shot fire-and-collect** with a free-form (often non-JSON)
stdout that exits immediately — it would always trip the spawner's contract.

`LocalSandbox` (`src/runtime/sandbox.ts`) is the correct reuse: one-shot
capture, env-allowlist, timeout, output cap, argv-not-string, kill escalation.
The production exec adapter reuses the sandbox's `scrubEnv` (the single source
of truth for the env allowlist), `disclaimedShellArgv`, `escalatingKill`, and
`withSpawnedChild` — adding only stdin delivery, which the sandbox lacks. The
env-allowlist guarantee is shared either way.

## Default-OFF byte-identical

- No config / `enabled !== true` ⇒ `normalizeCommandHookGate` returns a
  disarmed gate.
- A disarmed gate makes `runCommandHooks` return `{ deny: null, timedOut: false }`
  with ZERO exec calls.
- `installCommandHooks` on a disarmed gate registers NO HookBus handlers, so
  the bus is byte-identical to one with no command hooks.
- A host that never calls `installCommandHooks` is also byte-identical.

Sealed by hellgate (default-off / no-spawn / no-handler-registration cases).

## DI / structural

- No raw `child_process` in the slice — all spawning is behind
  `CommandHookExecPort`. Tests inject a fake, so NO real shell runs in CI.
- No `Date.now` / `Math.random` / real timer in the runner — the only timer
  (the kill watchdog) lives in the production adapter, exactly as `LocalSandbox`
  does, behind the injected port.
- Slice-fence `@/...` barrels (`@/runtime`, `@/runtime/guarded-spawn`,
  `@/runtime/shell-disclaim`); no reach into another slice's internals.

## Knobs

| knob | type | default | notes |
| --- | --- | --- | --- |
| `CommandHookConfig.enabled` | `boolean?` | `false` | Master opt-in. Strict `=== true`. |
| `CommandHookConfig.acknowledgedRisk` | `string?` | unset | Required (non-empty) when `enabled`. |
| `CommandHookConfig.timeoutMs` | `number?` | `30000` | Per-command wall-clock budget. |
| `CommandHookConfig.maxOutputBytes` | `number?` | `1048576` | Per-command combined stdout/stderr cap. |
| `CommandHookConfig.envAllowlist` | `string[]?` | `DEFAULT_ENV_ALLOWLIST` | Env names allowed through to the child. |

## Honest gaps

- `LocalSandbox` is not an OS security boundary (it does not chroot or block
  network). The trust model is "the user opted in to running their OWN config";
  the env-allowlist + timeout + output-cap are defense-in-depth, not a jail. A
  `DockerSandbox`-backed `CommandHookExecPort` (true isolation) is a clean
  future swap with no caller change (the port is closed).
- Root wiring (where the host reads `enabled`/`acknowledgedRisk` from
  settings/env and calls `installCommandHooks`) is intentionally NOT done in
  this slice — it stays default-OFF until a composition-root ADR arms it,
  matching the project's seam-first absorption pattern.
  **CLOSED (2026-06-03):** the root wire landed in the security-reviewed
  **ADR-0459** — `installCommandHooksIntoBase` (`src/apps/agent/index.ts`) reads
  `QUANTA_COMMAND_HOOKS` + `QUANTA_COMMAND_HOOKS_ACK` + `settings.json#hooks` and
  arms the gate (fail-fast on enabled-without-ack). The triple-gate is the
  approval (`isAllowed: () => true`, `bypass` mode recommended; the port is an
  injectable seam a host may tighten). Only the DockerSandbox exec-port swap
  remains held.
