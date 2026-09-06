# SEP5-01 — one `gh` process-execution authority

**Priority:** P1
**Status:** IMPLEMENTED IN WORKTREE — hardening commit pending
**Depends on:** SEP5-00
**Finding coverage:** D3

## Goal

Every production `gh` invocation must use one argv-only process primitive with
the same environment scrub, abort, timeout, and process-tree termination policy.
Caller adapters may translate result shapes but may not spawn `gh` themselves.

## Current failure

`createBunGhCliPort` omits `env`, so a child inherits arbitrary parent secrets.
`defaultGhRunner` uses `scrubEnv(CI_ENV_ALLOWLIST)`. `ci-bot.ts` has a third
spawner with the scrub but only a root `proc.kill()` deadline.

Behavioral reproduction at the audit SHA:

```text
QUANTA_AUDIT_SECRET=sentinel
createBunGhCliPort("env")  -> child contains sentinel
defaultGhRunner(["env"]) -> child does not contain sentinel
```

## Owning contract

Keep the executable primitive in `src/tool/gh/runner.ts` and extend it without
breaking the existing `GhRunner` adapter:

```ts
export interface GhExecRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface GhExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type GhExecPort = (request: GhExecRequest) => Promise<GhExecResult>

export const defaultGhExec: GhExecPort = async (request) => {
  // Bun.spawn(request.argv, { cwd, env: scrubEnv(CI_ENV_ALLOWLIST), ... })
  // combine caller abort and timeout; escalating tree-kill exactly once
  // drain stdout/stderr; always clear timers/listeners in finally
}
```

`defaultGhRunner(argv, cwd, timeoutMs)` becomes a compatibility adapter over
`defaultGhExec`. Do not make the core concatenate a shell string.

## Write set

| File | Change |
|---|---|
| `src/tool/gh/runner.ts` | Add `GhExecPort`, signal-aware canonical execution, retain `GhRunner` adapter |
| `src/tool/gh/index.ts` | Export the new port/types if needed by composition roots |
| `src/apps/cli/from-pr-cmd-adapters.ts` | Replace direct `Bun.spawn` with a result-shape adapter over `GhExecPort` |
| `src/apps/cli/from-pr-cmd-runner.ts` | Inject the canonical executor when constructing `GhCliPort` |
| `src/apps/agent/mode-presets/ci-bot.ts` | Delete `spawnGh`; adapt canonical executor to `CiBotWiring["gh"]` |
| `tests/unit/cli/gh-exec-policy-hellgate.test.ts` | New behavioral environment/abort/tree-kill battery |
| `tests/unit/apps/agent/ci-bot-preset.test.ts` | Assert ci-bot uses the injected canonical behavior, not a copied allowlist |

## Implementation steps

1. Add the new request/result port and implement timeout/caller-signal
   composition. Ensure an already-aborted signal does not spawn.
2. Reuse `defaultPpidWalkKiller` and `escalatingKill`; disarm on normal exit.
3. Convert `defaultGhRunner` to a thin adapter.
4. Make `createBunGhCliPort(binary, exec = defaultGhExec)` prepend `binary` and
   map `{code}` to `{exitCode}`.
5. Replace ci-bot's local spawn with an injected `GhExecPort` closure.
6. Search for remaining `Bun.spawn(["gh"` and direct equivalent paths.

## RED rails

- A non-allowlisted sentinel inherited by any of the three public paths fails.
- Removing `env: scrubEnv(CI_ENV_ALLOWLIST)` from the owner fails behaviorally.
- A fake child that forks and holds stdout open must be gone after timeout.
- An already-aborted signal performs zero spawn calls.
- Signal abort and deadline racing may kill once but must settle every promise.
- Arguments containing spaces, quotes, `$()`, and newlines remain one argv item.

## Test and ratchet implementation

- In `gh-exec-policy-hellgate.test.ts`, execute the real `env` binary through
  `defaultGhRunner`, `createBunGhCliPort`, and the ci-bot adapter with
  `QUANTA_GH_RATCHET_SENTINEL` set only in the parent. Assert all three child
  outputs omit it and assert the adapter population is exactly three.
- Reuse the descendant fixture pattern from
  `runtime/process-tree-kill-hellgate.test.ts`: a child forks a grandchild that
  holds stdout open. After timeout, poll both PIDs with a bounded deadline and
  require both to be absent.
- Add six argv rows: space, single quote, double quote, `$()`, newline, and a
  leading dash after `--`. The fixture echoes JSON argv; exact array equality is
  required.
- Instrument the spawn seam for an already-aborted signal and require
  `spawnCalls === 0`; race signal/deadline 50 times and require one terminal
  result and at most one tree-kill initiation per run.
- Mutation A: remove the canonical scrubbed `env`; the sentinel row must fail in
  all three projections. Mutation B: replace `escalatingKill` with `proc.kill()`;
  the descendant row must fail, not merely time out.
- Enroll the final direct-spawn inventory in
  `runtime/exec-cluster-spawn-env-scrub-ban-hellgate.test.ts`; retain that test's
  injected-offender and non-zero spawn-site controls.

## Proof rails

```sh
bun test tests/unit/cli/gh-exec-policy-hellgate.test.ts
bun test tests/unit/apps/agent/ci-bot-preset.test.ts
bun test tests/unit/apps/cli/from-pr-cmd-runner.test.ts tests/unit/apps/cli/from-pr-cmd.test.ts
rg -n 'Bun\.spawn|spawnGh' src/tool/gh src/apps/cli/from-pr-cmd-adapters.ts src/apps/agent/mode-presets/ci-bot.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- One production process owner controls every `gh` subprocess.
- Caller adapters preserve binary prefix, signal, timeout, and result shape.
- Environment and tree-kill guarantees are proven by real child processes.
- No ceiling or architecture allowlist increases.

## Stop conditions

- Preserving a caller requires dropping its `AbortSignal` or timeout semantics.
- The implementation introduces shell-string execution.
- A source scan is the only evidence that scrubbing occurs.

## Closeout update — 2026-09-06

The canonical executor was already landed. This closeout hardens its remaining
abort/deadline registration race in `src/tool/gh/runner.ts`:

- caller abort and deadline now share one terminal latch;
- listener registration is followed by an abort recheck, closing the
  preflight-to-registration window;
- process-tree termination can be initiated at most once even when abort and
  deadline become ready together.

The regression rail is behavioral, not a symbol scan. The fake signal fires
during listener registration, and
`tests/unit/cli/gh-exec-policy-hellgate.test.ts` requires one settled result,
one tree-kill initiation, and listener removal. The focused GH battery passed
five consecutive executions. Process-tree and environment-scrub rails remain
enrolled in the normal full-suite manifest.

**Current receipt:** implementation is present in the working tree. A clean
synthetic verification snapshot at `7e0528d0f0ed756affcc9f05db896011b003796d`
passed the focused SEP5 bundle, typecheck, lint debt, slice fences, god-code,
feature-catalog validation, one complete 34/34 full-suite run, and all 21
`test:ci` gates. The implementation is branch-delivered on `main` through
`fd4bad9976712b0584c18dd359263890d86f6803`; the final ticket-only closeout is
verified again at its own exact HEAD.
