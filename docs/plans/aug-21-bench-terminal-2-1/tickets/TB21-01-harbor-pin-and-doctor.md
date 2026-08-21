# TB21-01 — pinned Harbor runtime and doctor

**Priority:** P0
**Size:** M
**Depends on:** TB21-00A
**Parallelizable:** no
**Live benchmark cost:** one import/sandbox probe

## Goal

Replace the stale Harbor `main` dependency and old CLI assumptions with one
locked, locally diagnosable runtime that can import Quanta as a current Harbor
external agent.

## Current defect

`adapters/terminal-bench/pyproject.toml` currently declares:

```toml
"harbor @ git+https://github.com/harbor-framework/harbor.git"
```

That is not reproducible. The README is pinned to Harbor 0.16.1 behavior and uses
`--agent-import-path`, while current Harbor docs show a custom agent via
`--agent path.to.agent:SomeAgent`. The actual pinned package must decide the CLI;
the docs must not carry both as equally valid.

## Required changes

1. Resolve the exact Harbor version/ref compatible with the canonical TB2.1
   dataset and upstream leaderboard tooling.
2. Replace the floating VCS dependency with an exact package version or immutable
   git commit.
3. Add an adapter-local lock (`uv.lock`) and a single documented install path.
4. Prove whether `QuantaAgent` is host-side `BaseAgent` in the pinned version.
5. If the existing Quanta Dockerfile has no runtime consumer, delete it. Harbor's
   task sandbox remains Docker/Daytona-owned; do not keep a second image story.
6. Add the doctor implementation under `src/apps/bench/terminal/doctor.ts` and
   expose it only through `quanta-bench terminal doctor`.
7. An optional `bench:tb:doctor` package script may call the unified CLI verbatim;
   it must contain no independent parsing or preflight logic.

## Doctor contract

The doctor returns non-zero on a required failure and prints a bounded receipt for:

- repo SHA and dirty state;
- Bun, Python, uv, Harbor, and Docker client versions;
- Docker daemon reachability;
- custom-agent module and class import;
- `BaseAgent` subclass and abstract-method closure;
- brain shim `--version`;
- canonical dataset name and pinned ref;
- selected sandbox availability;
- required credential **presence only**;
- model and reasoning effort;
- output/report directory writability.

It must never print credential values or the full process environment.

## RED rails

Before implementation, capture tests that fail for:

- the floating Harbor spec;
- an unimportable custom agent;
- a Harbor version outside the lock;
- Docker client present but daemon unavailable;
- `latest` or an absent dataset ref in a promotable manifest;
- missing brain shim;
- a secret-like value appearing in doctor output.

Prefer runtime reflection of the installed Harbor package over source-string
scanning. Any static guard must include a real call pattern and an anti-vacuum
floor.

## Expected owner files

- `adapters/terminal-bench/pyproject.toml`
- `adapters/terminal-bench/uv.lock` (new)
- `adapters/terminal-bench/README.md`
- `adapters/terminal-bench/Dockerfile` (delete if confirmed unused)
- `src/apps/bench/terminal/doctor.ts`
- `src/apps/bench/commands/terminal.ts`
- a small adapter-local Python probe only when Harbor reflection cannot be done
  safely from Bun; it returns typed data to the bench doctor and is not a CLI
- `package.json` only for an optional thin alias
- targeted doctor/import tests

## Proof rails

```sh
uv sync --project adapters/terminal-bench --extra dev --frozen
uv run --project adapters/terminal-bench python -c \
  'from quanta_agent import QuantaAgent; print(QuantaAgent.name())'
uv run --project adapters/terminal-bench harbor run --help

bun run src/apps/bench/cli.ts terminal doctor
python3 -m pytest -q adapters/terminal-bench/tests
git diff --check
```

The exact custom-agent flag is asserted from the pinned `harbor run --help` and an
import smoke. Do not keep an old alias solely to make a README example pass.

## Definition of done

- A clean checkout can reproduce the adapter environment from the lock.
- No floating Harbor dependency remains.
- Doctor fails loud before a paid run on every required missing dependency.
- Doctor uses the unified bench terminal I/O/error path; no second CLI exists.
- The README contains one current invocation shape.
- The Dockerfile is either proven and tested as a live owner or deleted.
- Existing user modifications remain unaltered and are not accidentally staged.

## Stop rule

If the pinned Harbor version changes `BaseAgent`, `AgentContext`, or custom-agent
construction materially, stop before adding shims. TB21-02 must target the new
owner contract directly.
