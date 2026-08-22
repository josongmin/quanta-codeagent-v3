# quanta ↔ Terminal-Bench 2.1 (Harbor) adapter

Runs the quanta terminal-operator as a [Harbor](https://harborframework.com/docs)
`BaseAgent` against the canonical `terminal-bench/terminal-bench-2-1` dataset.

Two halves, one box:

- **Hands** (Python, this dir): `quanta_agent.QuantaAgent` (the Harbor `BaseAgent`
  glue), `quanta_terminal_bridge` (the pure line-delimited-JSON serve loop), and
  `quanta_terminal_atif` (the ATIF trajectory emitter). Harbor loads the agent and
  hands it a container `environment`.
- **Brain** (TypeScript, repo `src/`): `src/apps/terminal/brain-mode.ts`, launched by
  the hands as a subprocess via the `quanta-terminal-brain` shim. The brain decides;
  its `container_exec` frames run on the box through the bridge → `environment.exec`.

The pure bridge, the glue WIRING, provenance, reasoning effort and the ATIF
conversion are all unit-tested with no Docker and no Harbor. What needs a box is
only the live `harbor run` (real container, real installed brain, real creds).

---

## Pinned runtime

| Thing | Pin | Where the pin comes from |
| --- | --- | --- |
| Harbor | `harbor==0.21.0` | newest non-dev PyPI release (2026-08-10); satisfies the upstream floor `harbor[modal]>=0.20.0` declared in [`terminal-bench-2-1/leaderboard/pyproject.toml`](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/pyproject.toml) |
| Dataset | `terminal-bench/terminal-bench-2-1` | [`leaderboard/src/leaderboard/core/hub.py`](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/src/leaderboard/core/hub.py) `DATASET` |
| Dataset ref | `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` | same file, `DATASET_REF` |
| Coverage | 89 tasks × ≥ 5 trials | [`leaderboard/src/leaderboard/ci/static_analysis.py`](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/src/leaderboard/ci/static_analysis.py) `EXPECTED_TASK_COUNT` / `MIN_TRIALS_PER_TASK` |

> PyPI `harbor` **is** the real framework (author Alex Shaw, harborframework.com,
> the Terminal-Bench authors). The older note that it was a name squat is stale:
> `0.1.20` was a yanked release of this same project, and `0.13.0+` are the
> framework proper. There is no separate `harbor-framework` distribution.

`adapters/terminal-bench/uv.lock` pins the full transitive closure. Re-lock only
by editing `pyproject.toml` and re-running `uv lock`.

---

## Install — one path

```sh
uv sync --project adapters/terminal-bench --extra dev --extra harbor --frozen
```

Then everything runs through that environment:

```sh
uv run --project adapters/terminal-bench python -c \
  'from quanta_agent import QuantaAgent; print(QuantaAgent.name())'   # -> quanta
uv run --project adapters/terminal-bench harbor run --help
uv run --project adapters/terminal-bench python -m pytest -q adapters/terminal-bench/tests
```

`quanta_agent` imports harbor under a `try/except` fallback (`BaseAgent = object`),
so `import quanta_agent` also works on a machine with no harbor — that is what
lets a plain `python3 -m pytest -q adapters/terminal-bench/tests` run the box-free
rails. The three ATIF-schema rails skip visibly in that mode; run them through
`uv run` to exercise them against harbor's own validator.

---

## Register the agent with Harbor

Harbor unified custom agents onto `--agent`. From the pinned `harbor run --help`:

> `--agent -a  [aider|…|vibe|acp:<agent>]  Agent to run, or a custom agent import
> path (module.path:ClassName).`

`AgentFactory.create_agent_from_config` treats an `--agent` value containing `:`
as an import path. This package installs a top-level `quanta_agent` module
exposing `QuantaAgent`, so the run flag is:

```
--agent quanta_agent:QuantaAgent
```

Verified against the pinned package: `QuantaAgent` **is** a
`harbor.agents.base.BaseAgent` subclass with **zero** remaining abstract methods,
`QuantaAgent.import_path() == "quanta_agent:QuantaAgent"`, and
`QuantaAgent.SUPPORTS_ATIF is True`.

---

## Agent version (`QUANTA_TB_AGENT_VERSION`) — required

Harbor stamps every trial with `AgentInfo.version = self.version() or "unknown"`,
and the leaderboard keys a submission on
`(agent, agent_version, model_name, reasoning_effort)`. A run with no version is
unattributable, so the adapter is **fail-closed**: constructing `QuantaAgent`
without an injected version raises.

```
QUANTA_TB_AGENT_VERSION = <package-version>+g<sha>[.dirty]
```

| Part | Meaning |
| --- | --- |
| `<package-version>` | the quanta repo `package.json` `version` (e.g. `1.0.025`), dotted numeric segments |
| `+g<sha>` | the exact commit, 7–40 lowercase hex |
| `.dirty` | **required** when the working tree is not clean, **forbidden** when it is |

A dirty run is allowed (development) but is never promotable, and can never
present itself as the clean SHA. Anything else — absent, malformed, a bare SHA,
a different dirty spelling — fails construction, before any model invocation.

```sh
harbor run … --ae QUANTA_TB_AGENT_VERSION="1.0.025+g$(git rev-parse --short=12 HEAD)"
```

---

## Reasoning effort

Pass Harbor's official agent kwarg; the adapter normalizes it and sets exactly one
`QUANTA_REASONING_EFFORT` in the brain subprocess env:

```sh
harbor run … --ak reasoning_effort=high
```

| Set | Values | Behaviour |
| --- | --- | --- |
| Harbor vocabulary | `none minimal low medium high xhigh max default` | accepted (source: the reference agent `harbor/agents/terminus_2/terminus_2.py`) |
| Quanta wire-honored | `minimal low medium high xhigh` | forwarded to the provider by `normalizeResponsesReasoningEffort` (`src/llm/openai-responses-wire.ts`) |
| Anything else | — | **`ValueError` before the brain is spawned** — never a silent default |

`max`, `none` and `default` are legal Harbor values that Quanta's Responses wire
currently **drops**. Such a run still executes and still records the requested
value, but `QuantaAgent.promotability()` marks it non-promotable with reason
`reasoning-effort-not-wired:<value>` — reporting an effort the provider never
received would be a false leaderboard receipt.

`QUANTA_REASONING_EFFORT` reaches only the OpenAI-Responses-family adapters
(`openai-responses`, `chatgpt-oauth`). On an Anthropic model it is inert today.

---

## ATIF trajectory

`run()` writes `self.logs_dir / "trajectory.json"` in ATIF. That path is the whole
contract: `harbor/upload/uploader.py` uploads `<trial_dir>/agent/trajectory.json`
as the Hub `trajectory_path`, and `<trial_dir>/agent` *is* the agent's `logs_dir`.
The pinned `AgentContext` has **no** trajectory field.

The payload is validated by harbor's own
`harbor.utils.trajectory_validator.TrajectoryValidator` over its own
`extra="forbid"` pydantic models — this adapter does not mirror the schema.

What is emitted, and what is not:

- **preserved** — tool name, arguments, exit code / ok flag, result content, event
  order (`step_id` sequential from 1), aggregate tokens + cost, model, effort,
  termination status;
- **excluded** — hidden verifier content (the adapter never sees it), credential
  and env values, unbounded tool stdout (every string is capped at
  `FIELD_CHAR_CAP`, the step list at `MAX_STEPS`), and synthetic reasoning text
  (the brain records none, so no `reasoning_content` is ever invented);
- **not replaced** — Quanta's own typed receipts (`verification`, `selfTest`,
  `oracleLoop`, `envPosture`) still ride `AgentContext.metadata`, secret-scrubbed.

A crashed, cancelled or timed-out trial still gets a bounded terminal receipt
(`extra.termination` ∈ `completed | no_report | error`), so a failure is a
recorded zero-reward trial, never a missing trial.

`QuantaAgent.promotability()` returns `{"promotable": bool, "reasons": [...]}`,
blocking on `dirty-worktree`, `reasoning-effort-not-wired:<v>`,
`missing-atif-trajectory` (the upstream rail: a rewarded trial with no
`trajectory_path` fails static analysis) and `invalid-atif-trajectory`.

---

## Credentials — how provider keys reach the brain

**Secrets are never baked into an image or a committed file.** They flow in at run
time:

```
host shell / CI secret store
   ├─ host `export KEY=VAL`               (→ os.environ)            ┐
   └─ harbor `--ae KEY=VAL`               (→ agent extra_env)       ┘  both merge:
        └─ QuantaAgent._brain_run_env() = { ...os.environ, ...extra_env }  (extra_env wins)
             └─ _spawn_brain(argv, env=…) -> quanta-terminal-brain -> bun -> brain-mode.ts
                  └─ quanta LLM factory reads ANTHROPIC_API_KEY / OPENAI_API_KEY
```

Provide **at least one** of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `QUANTA_API_KEY`.

Redaction authority is `quanta_terminal_atif.SECRET_ENV_NAMES` plus the name
suffixes `_API_KEY _KEY _PASSWORD _SECRET _TOKEN`: the live values of any
matching env var are scrubbed out of both the ATIF trajectory and the
`AgentContext.metadata` receipt, leaving a visible `[redacted:NAME]` marker. No
environment is ever serialized.

### Feature knobs (default-OFF)

```sh
export QUANTA_TB_ENV_OWNED=1        # lever #1: brain may install/build/configure
export QUANTA_TB_VERIFY_GATE=1      # lever #2: pre-report exercise-evidence gate
# …or per-run:  harbor run … --ae QUANTA_TB_ENV_OWNED=1 --ae QUANTA_TB_VERIFY_GATE=1
```

Model selection: `-m <model>` is harbor's; quanta's brain also honors
`QUANTA_TERMINAL_MODEL` / the `QuantaAgent(model=…)` ctor arg → forwarded as
`--model` to the brain.

---

## Live run shape (box-phase — Docker daemon + creds required)

```sh
uv run --project adapters/terminal-bench harbor run \
  -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  --agent quanta_agent:QuantaAgent \
  -m openai/gpt-5.5 \
  --ak reasoning_effort=xhigh \
  --ae QUANTA_TB_AGENT_VERSION="1.0.025+g$(git rev-parse --short=12 HEAD)" \
  --ae OPENAI_API_KEY="$OPENAI_API_KEY" \
  -k 5
```

Harbor shells out to the host `docker` (or Daytona/Modal via `-e`) to provision
each task's container, so harbor runs on the HOST; `QuantaAgent.run()` spawns the
brain there and its `container_exec` frames reach the task container via
`environment.exec`.

---

## Box image

There is **no Quanta-owned image story**: Harbor owns the task sandbox
(Docker/Daytona/Modal). `Dockerfile` in this directory has no automated consumer
in this repo — see the TB21-01 receipt for its disposition.
