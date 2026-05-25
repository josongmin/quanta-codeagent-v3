# ADR-0301 — `--playbook-trigger` CLI flag echo through to wire

Status: Accepted
Date: 2026-05-26
Owner: @songmin
Layer: src/apps/agent + src/apps/cli/repl
Slice: playbook-trigger flag echo (last-mile of ADR-0293)
Default-OFF: yes (RFC §1.2)

## Context

ADR-0293 added the `--playbook-trigger` boolean flag to
`src/apps/agent/cli-args.ts` and built `maybeStartPlaybookTriggerWire({ env,
cliFlag, ... })` so the watcher honours BOTH an env var
(`QUANTA_PLAYBOOK_TRIGGER=on`) AND an explicit CLI opt-in. ADR-0299 then
wired the surface composition root so the session-loop reaches the helper
via `playbookSeam` + `playbookCliFlag` dep slots.

However, the **last mile** was never closed: the parsed
`AgentArgs.playbookTrigger` boolean was not threaded down to the session
loop's `playbookCliFlag` dep, and the call site in `repl.ts` passed nothing.
The result was a half-wired feature — only the env path worked; operators
typing `--playbook-trigger` saw no effect (the parser accepted the flag,
the wire respected `cliFlag`, but no caller ever set `cliFlag` to `true`).

## Decision

Thread the parsed flag through the full surface stack:

1. `src/apps/agent/index.ts` — extend `AssembleRequestPartial` with
   `playbookTrigger?: boolean` and propagate it inside `toAssembleRequest`
   (presence-only — absent ⇒ slot omitted on the projection).
2. `src/apps/cli/internal.ts` — add a `playbookTriggerFlag()` helper that
   reads `--playbook-trigger` off `process.argv` (parallel to
   `newSessionFlag()` for SOLID/SRP).
3. `src/apps/cli/repl/session-runtime-config.ts` — surface the read as a
   `playbookTriggerFlag: boolean` field on `SessionRuntimeConfig`.
4. `src/apps/cli/repl/session-bootstrap.ts` — forward the boolean through
   `SessionBootstrapResult.playbookCliFlag: boolean | undefined` (mapping
   `false → undefined` so the downstream consumer can spread the slot
   conditionally under `exactOptionalPropertyTypes`).
5. `src/apps/cli/repl/session-setup.ts` — forward the same shape onto
   `SessionSetupResult.playbookCliFlag`.
6. `src/apps/cli/repl.ts` — spread `playbookCliFlag: setup.playbookCliFlag`
   onto the `runSessionLoop` call (3-line addition, comment + spread).
   `session-loop.ts` already consumed `playbookCliFlag` as of ADR-0299; no
   change needed there.

### Env vs flag precedence (unchanged, locked here)

`QUANTA_PLAYBOOK_TRIGGER=on` WINS over `cliFlag === false`. The wire helper
(`maybeStartPlaybookTriggerWire`) is the single arbiter; this ADR only
threads the boolean to it. See HELL-0301-vii in the hellgate.

### `false → undefined` mapping

Bootstrap maps `runtime.playbookTriggerFlag === true ? true : undefined` so
the downstream slot is OMITTED when the operator did NOT pass the flag —
keeping the default-OFF path byte-identical (no `cliFlag: false` reaches
the wire; env-on precedence remains the only opt-in path).

## Consequences

### Pro
- Operators can now opt in via either env var OR `--playbook-trigger`,
  whichever fits their workflow (CI/scripts vs interactive).
- The half-wired state (parser accepts flag, wire ignores it) is closed.
- Default-OFF byte-identical when neither knob is set (RFC §1.2).
- No new dependencies; no domain code touched.

### Trade-offs
- Threading adds 4 trivial `playbookCliFlag?` / `playbookTrigger?` fields
  to interfaces (`AssembleRequestPartial`, `SessionRuntimeConfig`,
  `SessionBootstrapResult`, `SessionSetupResult`). Each is presence-only
  to keep `exactOptionalPropertyTypes` clean.
- `toAssembleRequest` was at biome's cognitive-complexity cap (15) — the
  added `if (args.playbookTrigger === true)` branch pushed it to 16. Fixed
  by extracting an ADR-0236+0301 mega-wire helper (`liftMegaWireFields`)
  out of the function body, which BOTH closes my pushed-over and removes
  the existing complexity load that was about to bite the next wire flag.

## Plane cleanliness

Changes ONLY in `apps/agent/index.ts` + `apps/cli/internal.ts` + 3 repl
session files + `repl.ts` (3 lines). NO touches to `surface-compose.ts`,
`session-loop.ts`, `slash-surface.ts`, `prompt-pipeline.ts`,
`slash-commands.ts`, T1/T2/T3/T4 source files, `src/agent/types.ts`, or
any domain code. User in-flight files (6 `src/agent/*`/`tests/*` prompt
files) untouched.

## Tests

`tests/unit/apps/cli/playbook-flag-echo-hellgate.test.ts` — 9 cases:

| # | Invariant |
|---|-----------|
| i | `--playbook-trigger` parsed ⇒ `AgentArgs.playbookTrigger === true` |
| ii | Flag absent ⇒ `AgentArgs.playbookTrigger === undefined` (not `false`) |
| iii | `toAssembleRequest` propagates true ⇒ partial.playbookTrigger=true; absent ⇒ slot omitted |
| iv | `playbookTriggerFlag()` reflects `process.argv` presence |
| v | env=on + flag absent ⇒ wire active (existing precedence) |
| vi | env absent + flag=true ⇒ wire active (NEW path) |
| vii | env=on + flag=false ⇒ env wins, wire active |
| viii | env absent + flag absent ⇒ NOOP handle |
| ix | `--playbook-trigger=maybe` ⇒ `AgentArgsError` (token equality, not prefix; grammar unchanged) |

Test sited under `tests/unit/apps/cli/` (not `tests/unit/apps/agent/`)
because the test imports `src/apps/cli/internal#playbookTriggerFlag` and
`src/apps/cli/repl/playbook-trigger-wire#maybeStartPlaybookTriggerWire`,
both gated behind the ADR-0024 slice-fence which permits the import only
from `src/apps/cli/**` and `tests/unit/apps/cli/**`. (The fix in passing:
the existing `session-loop-hellgate.test.ts` fixture in the same dir was
missing the new `playbookCliFlag` field and would otherwise fail tsc.)

## References

- ADR-0293 — playbook-trigger CLI auto-bind opt-in (this ADR closes its
  last-mile)
- ADR-0299 — surface composition wire (consumes `playbookSeam` +
  `playbookCliFlag` from this slice)
- ADR-0203 — playbook frontmatter
- ADR-0240 — inline-trigger auto-dispatch orchestrator
- RFC may-22-unified-agent-runtime §1.2 (default-OFF byte-identical)
- ADR-0024 — slice isolation / export-gap closure (governs test file
  placement)
