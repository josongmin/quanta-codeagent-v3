# ADR-0455 — agent-driven DECLARED local-environment selection

**Status:** Accepted (2026-06-02)
**Type:** Tool-system / runtime slice (env composition for spawned shells).
**Scope:** new `src/runtime/local-env/` slice (`types.ts` / `parse.ts` /
`apply.ts` / `load.ts` / `index.ts`) + a structural `localEnv` field threaded
through `ShellOptions` (`src/runtime/types.ts`) → applied in
`src/runtime/shell.ts` → surfaced on `ToolContext.localEnv` (`src/tool/types.ts`)
→ forwarded by the bash tool (`src/tool/bash/index.ts`) → wired from
`AgentConfig.localEnv` (`src/agent/types.ts`) by the dispatch seam
(`src/agent/dispatch.ts`). Hellgate `tests/unit/local-environments-hellgate.test.ts`.

ADR-number note: 0450 was the highest existing decision on the base
(25462831); 0451–0454 are left for concurrently-active sibling sessions. This
slice took the explicitly-assigned next number, 0455.

## Context

Today quanta's spawned shells inherit only the AMBIENT shell env: `runShell`
builds a SCRUBBED env from `DEFAULT_ENV_ALLOWLIST` (`scrubEnv`), then optionally
overlays egress-proxy vars (ADR-0428). There is NO way for a project to DECLARE
a per-project dev environment (a python venv on `PATH`, a pinned node toolchain,
project env vars) and have the agent's shell/tool execution pick it up. The
batch-eval path has a `setupCmd` (`src/runner/batch/eval/env-prep.ts`) but that
is EVAL-only and runs an arbitrary command — it is not an agent-driven,
declarative, live-session mechanism.

Codex ships `.codex/environments/environment.toml` (its webview has a
named-environment selector). We absorb the DECLARATIVE core: a project declares
named environments; the agent selects one; the spawned shell gets that env's
declared vars / PATH-prepends.

## Decision

A project DECLARES named environments in `.quanta/environment.toml` (canonical)
or `.codex/environments/environment.toml` (Codex-compat). Schema (TOML):

```toml
default = "py"                 # optional; MUST name a declared env

[env.py]
vars = { PYTHONPATH = "src", VIRTUAL_ENV = ".venv" }
pathPrepend = [".venv/bin"]

[env.node20]
vars = { NODE_ENV = "development" }
pathPrepend = ["node_modules/.bin"]
```

**Pure / total / fail-closed parser.** `parseLocalEnvConfig(body, toml)` takes a
DI'd TOML parse function (`Bun.TOML.parse` at the composition root) and returns
a typed `LocalEnvParseResult`. A TOML syntax error (parser throw) is CAUGHT and
mapped to `toml_syntax`; every malformed shape (`no_environments`,
`bad_env_table`, `bad_var_name`, `bad_var_value`, `bad_path_entry`,
`default_unknown`, `bad_default`) is a CLOSED reason. The parser NEVER returns a
silent default / partial config.

**No heuristic env detection.** Nothing is sniffed from the filesystem. The
loader (`loadLocalEnvConfig`) walks CWD → repo-root (the SAME `.git`/root/depth
boundary `loadRepoRules` uses) looking ONLY for the PRESENCE of a declared
config file. A directory that "looks like" a python project (has a `.venv` dir)
is NOT detected. Every applied value comes from the parsed config.

**Composition with the allowlist (the security rule).** `applyLocalEnv(base,
selection, allowlist)` overlays the selected env's `vars` / `pathPrepend` ON TOP
of the already-scrubbed base — it does NOT bypass the allowlist:

- a declared var whose NAME is not in the active allowlist is DROPPED (it cannot
  smuggle a non-allowlisted name — e.g. `AWS_SECRET_ACCESS_KEY` — into the
  child);
- `PATH` is on `DEFAULT_ENV_ALLOWLIST`, so `pathPrepend` applies; fragments are
  prepended (in declaration order) to whatever `PATH` survived the scrub. PATH
  prepend is VALIDATED at parse time: each entry must be a single non-empty
  fragment with no `:` (no multi-element injection), no `=` (no var-assignment
  smuggling), no NUL.

**"Activate" is declarative, never an exec hook.** A venv's `source
.venv/bin/activate` is expressed purely as env mutations (`pathPrepend
[".venv/bin"]` + `vars.VIRTUAL_ENV`). There is NO arbitrary command run by this
slice — an exec-style activate hook is deliberately OUT OF SCOPE (that is the
T4 hook track's concern).

**Switching.** `selectEnvironment(config, name?)` resolves a selection: an
explicit name selects that env (an unknown name ⇒ `undefined`, NOT a silent
fallback to default); absent name ⇒ the declared default; neither ⇒ `undefined`.
A composition root switches environments by re-selecting a different declared
name onto the per-session `AgentConfig.localEnv`.

**Default-OFF, byte-identical.** With no config file the loader returns
`undefined` and nothing is threaded; `applyLocalEnv(base, undefined, …)` returns
the SAME `base` reference, so the child env is byte-identical to the pre-slice
path. An empty selection (`{ vars: {}, pathPrepend: [] }`) also returns the same
reference.

## Wiring

The seam mirrors the ADR-0428 `proxyEnv` pattern exactly:
`AgentConfig.localEnv` → `dispatch.ts` surfaces it on `ToolContext.localEnv` →
the bash tool forwards it verbatim to `ShellOptions.localEnv` → `runShell`
composes it via `applyLocalEnv(scrubEnv(), localEnv, DEFAULT_ENV_ALLOWLIST)`
BEFORE the proxy injection. `@/runtime` does not import `@/tool`/`@/agent`; the
field types are structural mirrors of `LocalEnvSelection`.

The on-disk loader (`loadLocalEnvConfig`) is exported but a composition root
(CLI / `runAgent`) is the place that reads it and sets `AgentConfig.localEnv`.
That binding is a small follow-up (the parser/apply/select/load core + the full
shell→tool→dispatch wire are the substance of this slice).

## Consequences

- Projects get a declarative, agent-driven dev environment with no host
  mutation and no exec hook — the allowlist still governs every var.
- A malformed config fails closed (typed error) instead of silently degrading.
- The bash tool's child shell sees the declared env; `runShell` is the single
  application point so any future shell-class tool inherits it for free.
- The composition-root binding of `loadLocalEnvConfig` → `AgentConfig.localEnv`
  is the one remaining wire (parser + apply + select + load + the full
  shell/tool/dispatch seam are landed and proven by the hellgate).
