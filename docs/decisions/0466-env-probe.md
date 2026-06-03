# ADR-0466 — Startup environment probe + graceful-degradation warnings

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF resilience seam (`@/runtime/env-probe`).
**Scope:** `src/runtime/env-probe/` (4 new files: `types.ts`, `checks.ts`,
`probe.ts`, `index.ts`) + the hellgate `tests/unit/env-probe-hellgate.test.ts`.
No shared files edited — composition wiring is deferred (see Consequences).
**Default-OFF:** `runEnvProbe(exec, opts)` with `opts.enabled !== true` returns
`[]` WITHOUT invoking the exec port. The composition root will set `enabled`
from `QUANTA_ENABLE_ENV_PROBE === "1"`. A deployment that does not set the flag
sees zero change — no shell-outs, no warnings, byte-identical startup.

ADR-number note: 0462 was the highest existing decision; this slice took the
next clearly-free number assigned by the integration plan, 0466.

## Context

Faithful absorption of Cursor's `CloudAgentStartupWarning` /
`CloudAgentStartupWarningType` + `CloudSetupBlocker` / `CloudSetupBlockerAction`
(`startup_warnings[]` persisted on agent state). When an agent starts in an
environment that is missing part of its toolchain (no `python3`, no test
runner, etc.), Cursor surfaces structured warnings so the agent ADAPTS rather
than blindly invoking a binary that isn't there and failing mid-turn.

quanta had no equivalent: the agent would attempt `pytest` / `bun test` /
`python3` and only discover the gap as a spawn failure deep inside a turn.

## Decision

Add a read-only, pure, deterministic startup probe behind a port, in
`@/runtime` (the slice that already owns shell/spawn concerns and may import
`@/storage` + `@/shared`).

1. **Closed check list** (`checks.ts`, `CORE_CHECKS`) — node, bun, python3, git.
   Each entry is a hand-authored `ProbeCheck` naming the binary, a
   side-effect-free `--version` probe argv, the `WarningKind`, and a severity.
   NO HEURISTICS — nothing is sniffed; the list is a documented constant.

2. **Manifest-derived test-runner checks** (`testRunnerChecks(manifest)`) — the
   ONLY thing read about the project is the PRESENCE of a declared manifest:
   - `package.json` declares a `test` script ⇒ expect a JS runner (probe `bun`);
   - `pyproject.toml` present ⇒ expect `pytest`.
   The manifest is READ by the composition root (via `@/storage`) and passed in;
   the runner stays pure. A JS-only repo never gets a spurious pytest warning.

3. **`ProbeExecPort`** (port inversion / DI) — `(argv) => Promise<Result<{found,
   version?}, ProbeExecError>>`. The real adapter shells out at the composition
   root; tests inject a deterministic fake. NO-THROW: a detection that errors
   resolves `Err`, and the runner SKIPS that check (no warning, no crash). The
   runner additionally wraps each call so a programmer-bug REJECTION degrades to
   the same skip rather than escaping the boundary.

4. **`runEnvProbe(exec, opts)`** (`probe.ts`) — iterates `CORE_CHECKS` then the
   manifest-derived checks in a stable order, emitting a `StartupWarning` for
   each absent binary. Worst case returns `[]`. Honors an optional
   `AbortSignal` (short-circuits, returns warnings gathered so far). Never
   blocks startup.

5. **`degradationHint(kind, target)`** — total over the closed `WarningKind`
   union (`assertNever` guard), producing the agent-readable adaptation
   guidance folded into the warning.

### Severity rationale

`warn` for node/bun/git (core to nearly every tool path) and for an
expected-but-missing test runner; `info` for python3 (used only by python
repair/eval flows). There is deliberately NO `error` level — the probe is
advisory and NEVER blocks startup, so it has no fatal class.

## Default-OFF / byte-identical proof

- `opts.enabled !== true` ⇒ `runEnvProbe` returns `[]` on the FIRST line,
  before touching `opts.manifest` or `exec`. Hellgate cases
  `enabled omitted / enabled:false / no opts` assert `[]` AND that the exec port
  was never called (`calls === []`).
- No consumer in `@/apps` / `@/agent` imports the barrel today, so the slice is
  dead code at the deployment level until the integration wiring lands.

## Consequences

- A new read-only resilience capability the agent can fold into context.
- One `--version` shell-out per check (≤6) at session start, ONLY when the gate
  is on — bounded, side-effect-free, abortable.
- Determinism: same checks + same port answers ⇒ identical warning list; no
  wall-clock, no randomness, no Set-iteration-order dependence.

## Negative invariants

- The probe NEVER throws and NEVER blocks startup — worst case `[]`.
- The probe NEVER mutates anything — it is read-only (resolves `--version`).
- The check list is CLOSED — no dynamic/heuristic discovery of "tools to probe".
- The only project fact consulted is the PRESENCE of a declared manifest; the
  manifest contents beyond `scripts.test` / file-existence are NOT sniffed.
- `version` is advisory only — it NEVER gates a warning (no version-threshold
  magic).
- The slice imports only `@/shared` (+ its own files); it does NOT reach `@/llm`
  / `@/tool` / `@/agent` / `@/permission`. The shell-out adapter is wired at the
  composition root, not here.

## Honest deferred (integration TODOs)

- **No composition wiring** — the real `ProbeExecPort` adapter (shell `--version`
  via `@/runtime` spawn) and the gate read (`QUANTA_ENABLE_ENV_PROBE`) + the
  manifest read (package.json / pyproject.toml via `@/storage`) must be wired at
  `src/apps/agent/**`; the resulting `StartupWarning[]` folded into agent
  context. Out of this slice's file fence.
- **No persistence** — Cursor persists `startup_warnings[]` on agent state; this
  slice only computes them. Persisting via the session store is a follow-up.
- **`version` unused** — the port returns it; surfacing version-aware hints is a
  later enhancement that needs no contract change.
