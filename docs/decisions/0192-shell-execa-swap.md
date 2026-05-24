# ADR-0192: Shell — swap self-rolled `Bun.spawn` runner for `execa`

- Status: Superseded — the `shell-execa` sibling adapter shipped with 0 src
  callers (only its own hellgate test imported it) and was deleted
  2026-05-25; see ADR-0195 (dead-sibling-cleanup). The self-impl `runShell`
  stays as it always was — the only path actually consumed by every caller.
  An undocumented orphan sibling, `src/storage/fs-jail-lib.ts` (which
  referenced this ADR in its docstring but had no ADR of its own), was
  deleted in the same sweep.
- Date: 2026-05-25
- Related: ADR-0006 (runtime-sandbox foundation + env allowlist), ADR-0081
  (PR-5 typed shell output events — STAYS on the self-impl), ADR-0175
  (linux-sandbox-native), ADR-0184 (conversation-checkpoint-lru-swap —
  same sibling-swap posture), ADR-0185 (file-write-atomic-lib-swap — same
  sibling-swap posture)
- SOTA reference: **`execa@9.6.1`** (https://github.com/sindresorhus/execa) —
  ~50M weekly downloads, Sindre Sorhus, 12+ years maintained, MIT, sideEffects:
  false, ESM. Ships `timeout` + `forceKillAfterDelay` (SIGTERM→SIGKILL
  escalation), `cancelSignal` (AbortSignal forwarding), `reject: false`
  (uniform result shape on success + failure), per-fd `encoding` /
  `buffer` / `maxBuffer`, full Node + Bun child_process compatibility.

## Context

`src/runtime/shell.ts` hand-rolls a `Bun.spawn` wrapper (216 LOC) that
implements:

- `bash -lc <command>` argv assembly + optional Seatbelt/Landlock argv wrap
- env scrubbing via the shared `scrubEnv()` (ADR-0006)
- timeout via `setTimeout` + `proc.kill()`
- SIGTERM→SIGKILL escalation via the `escalatingKill` helper
  (`src/runtime/guarded-spawn.ts` — KILL_GRACE_MS) + `disarm` cleanup
- AbortSignal forwarding via an `addEventListener("abort", …)` hook
- two output drain paths (buffered legacy + observer-streamed) sharing one
  spawn invocation, both terminated by `withSpawnedChild`'s kill-on-throw
  guard so a thrown observer cannot orphan the child

Every line of that — except the Seatbelt argv wrap and the typed
`onShellEvent` stream (PR-5 / ADR-0081) — is a feature execa ships natively
and has hardened across npm itself, `meow`, `oclif`, every Sindre tool, and
much of the Node CLI ecosystem.

The user principle is explicit: **"외부에 잘 만들어진 거 있으면 외부 거 써."**
`execa` is the canonical npm primitive for this exact task.

Negative invariants we are NOT violating:
- Public `ShellResult` shape stays byte-identical
  (`{ stdout, stderr, exitCode, timedOut }`).
- The self-impl `runShell` stays on disk and stays the default export
  every existing caller imports — bash tool, branch-search verifiers, git
  runner, worktree-fork, all 4 LLM-driven shell tools. NOTHING in
  `src/agent/**`, `src/tool/**`, `src/llm/**`, `src/lsp/**`, `src/mcp/**`,
  `src/observability/**`, `src/security/**` is touched by this slice.
- `onShellEvent` typed streaming stays on the self-impl — execa exposes a
  child `Subprocess` with stdout/stderr ReadableStreams, but its native API
  produces a single buffered `Result`. A streaming wrapper is follow-up.

## Decision

A sibling adapter `src/runtime/shell-execa.ts` (~158 LOC) re-exporting
`runShellExeca(command, options?)` with the SAME public contract as
`runShell`:

```
src/runtime/
  shell.ts          — UNCHANGED apart from a one-line sibling pointer comment.
                       Self-impl (Bun.spawn + escalatingKill + onShellEvent).
  shell-execa.ts    — NEW. execa-backed sibling. No onShellEvent (yet).
  index.ts          — barrel adds `export { runShellExeca } from "./shell-execa"`
                       in alphabetic position after `runShell`.
```

Adapter identity:

| field          | self-impl (`runShell`)              | lib (`runShellExeca`)                  |
|----------------|--------------------------------------|----------------------------------------|
| argv           | `["bash","-lc",cmd]` + Seatbelt wrap | `execa("bash",["-lc",cmd],{…})`         |
| timeout        | `setTimeout` + `escalatingKill`      | `timeout` + `forceKillAfterDelay:5000`  |
| abort          | `signal.addEventListener("abort",…)` | `cancelSignal: signal`                  |
| env            | `scrubEnv()` default; `inheritEnv:true`| same                                    |
| onShellEvent   | YES (PR-5 typed stream)              | NO — self-impl is the streaming path    |
| Seatbelt slot  | YES (`getShellSandbox().wrap(argv)`) | NO — sibling does not yet wrap argv     |
| exit on signal | OS-native (Bun surfaces 0 + signal)  | 137 (SIGKILL) / 143 (SIGTERM) / 127     |
| reject on ≠0   | NO                                   | NO — `reject: false` mirrors self-impl  |

`exactOptional`-friendly: the execa options object is built CONDITIONALLY —
`cancelSignal` is set only when `options.signal` is provided (instead of
explicitly `undefined`), so execa's strict `Options` type accepts the call
under `--exactOptionalPropertyTypes`.

## Hellgate

15 cases in `tests/unit/runtime-shell-execa-hellgate.test.ts` proving parity
with the self-impl's invariants. Hermetic — single `mkdtempSync` workdir,
cleaned up in `afterAll`.

| ID  | Invariant                                                          |
|-----|--------------------------------------------------------------------|
| A1  | `echo hello` → stdout `"hello\n"`, stderr empty, exitCode 0        |
| A2  | `false` → non-zero exitCode, ShellResult shape preserved           |
| A3  | `echo err >&2` → stderr `"err\n"`, stdout empty, exitCode 0        |
| A4  | `cwd` option respected (`pwd` lands in chosen dir)                  |
| A5  | `inheritEnv:true` surfaces parent env var to child                  |
| B6  | `sleep 5` + timeoutMs 100 → `timedOut:true`, non-zero exitCode      |
| B7  | default `killSignal: SIGTERM` reflected in exit semantics           |
| B8  | escalation actually terminates (elapsed < 7s for `sleep 30`)        |
| B9  | trap-ignoring child still dies via `SIGKILL` (< 7s, not 30s)        |
| C10 | already-aborted `AbortSignal` terminates promptly                   |
| C11 | mid-run abort kills subprocess (< 7s for `sleep 30`)                |
| C12 | no signal option → no abort wiring, command completes normally      |
| D13 | empty command → exitCode 127, stderr explains, no spawn             |
| D14 | 1 MiB stdout captured intact (no execa default truncation)          |
| D15 | UTF-8 multibyte (Korean/Japanese/emoji) round-trips through decoder |

The existing 3-case `tests/unit/shell.test.ts` against the self-impl stays
green untouched — the swap is additive.

## Alternatives rejected

- **`node:child_process.spawn` direct (our existing impl).** Re-invents
  timeout + SIGTERM/SIGKILL escalation + AbortSignal wiring + uniform error
  shape. Every concern we hand-roll is one execa already ships; the lib has
  12+ years of hardening (signal handling on every supported Node version,
  Windows quoting edge cases, etc.) we'd be replicating from scratch.
- **`cross-spawn`.** Only solves Windows shell quoting; doesn't address
  timeout, force-kill escalation, or AbortSignal. We're macOS/Linux-first;
  the Windows wins don't apply.
- **`zx`.** Sindre's sibling primitive (now `zx` is Google) but the API is
  template-tag-based (`` $`cmd` ``), not the function-call shape our
  `ShellResult` callers expect. Would force every caller to refactor.
- **Keep-self-only.** Re-litigation of the user principle. The lib is
  better-maintained than our 216 LOC could ever be; the sibling-adapter
  posture (ADR-0184 / ADR-0185 / ADR-0186) lets us swap progressively
  without breaking existing callers.

## SOTA realignment

Shell execution is NOT a competitive comparison axis (per
`agent-loop-4way-comparison`). All four agents (Codex / Claude Code /
Cursor / quanta) wrap `node:child_process` or `Bun.spawn` for tool exec.
The slice is internal hardening: same external contract, swap the backend.
Our unique axis (the `onShellEvent` typed-event stream from PR-5) stays
on the self-impl and remains unaffected.

## Subtle decisions

- **`bash -lc` vs `shell: true`.** execa's `shell: true` invokes
  `/bin/sh -c` and drops the `-l` (login-shell) flag, which on rare hosts
  breaks PATH inheritance from `~/.bashrc` etc. We pass `["bash","-lc",cmd]`
  as explicit argv to `execa("bash", […])` to preserve byte-identical
  semantics with the self-impl.
- **`reject: false`.** execa throws an `ExecaError` on non-zero exit by
  default; the self-impl never throws. `reject: false` gives us a uniform
  Result-shape projection regardless of success/failure, mirroring the
  caller-decides-what-is-failure posture the self-impl established.
- **`forceKillAfterDelay: 5000`.** execa's escalation clock matches the
  self-impl's `KILL_GRACE_MS` constant in `guarded-spawn.ts`. Verified by
  hellgate B9 (trap-ignoring child still dies within 7s).
- **`exitCode` projection for signal-killed children.** execa's `Result`
  surfaces `exitCode: undefined` + `signal: 'SIGKILL' | 'SIGTERM' | …` when
  the OS killed the child. We project to 137 (128+9, SIGKILL convention) /
  143 (128+15, SIGTERM convention) / 127 (catch-all) so the `ShellResult`
  contract (`exitCode: number`) holds.
- **`AbortSignal` is `cancelSignal`, not `signal`.** execa's option name is
  `cancelSignal` (the unprefixed `signal` is reserved for verbose-output
  routing in newer versions). Our adapter maps `options.signal →
  cancelSignal`.
- **No Seatbelt slot integration (yet).** The self-impl consults
  `getShellSandbox()` to wrap argv on macOS. The lib sibling does NOT — a
  follow-up can compose the slot's wrap output as the execa argv. Today,
  callers needing OS sandbox stay on `runShell`.
- **`stdin: "ignore"`.** Today `ShellOptions` exposes no `stdin` field; the
  self-impl implicitly closes stdin via Bun.spawn defaults. We set
  `stdin: "ignore"` on the execa side to match that behavior. Future stdin
  support is a separate options-surface extension.
- **Bun + execa compat.** execa uses `node:child_process` under the hood;
  Bun's child_process compat is production-grade for the spawn / kill /
  signal surfaces execa relies on. Verified by 15 hellgate cases all
  passing under `bun test`.

## Follow-up

- **Streaming wrapper.** Once the buffered sibling is corpus-calibrated,
  add a `runShellExecaStreaming` that wires execa's `Subprocess` stdout/
  stderr ReadableStreams to the same `RunShellEvent` union the self-impl
  emits — enabling parity with PR-5 / ADR-0081 and unlocking eventual
  deprecation of the self-impl streaming path.
- **Seatbelt slot composition.** Make `runShellExeca` consult
  `getShellSandbox().wrap(argv, cwd)` so macOS callers get OS sandbox by
  composing the slot's wrapped argv into `execa(argv[0], argv.slice(1), …)`.
- **Default flip.** After a corpus calibration window (same posture as
  ADR-0184/0185), consider flipping internal callers that DON'T need
  `onShellEvent` (worktree / git runner / branch-search isolate) to the
  lib variant.
- **`maxBuffer` policy.** execa's default `maxBuffer` is 100 MiB per stream.
  D14 confirms 1 MiB lands intact; if any caller ever hits the cap, surface
  it as a `ShellResult` warning or expose a per-call override.
