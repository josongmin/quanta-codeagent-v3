# quanta ↔ Terminal-Bench (Harbor) adapter

Runs the quanta terminal-operator as a [Harbor](https://github.com/harbor-framework/harbor)
`BaseAgent` against [Terminal-Bench](https://www.tbench.ai/) tasks.

Two halves, one box:

- **Hands** (Python, this dir): `quanta_agent.QuantaAgent` (the Harbor `BaseAgent`
  glue) + `quanta_terminal_bridge` (the pure line-delimited-JSON serve loop). Harbor
  loads the agent and hands it a container `environment`.
- **Brain** (TypeScript, repo `src/`): `src/apps/terminal/brain-mode.ts`, launched by
  the hands as a subprocess via the `quanta-terminal-brain` shim. The brain decides;
  its `container_exec` frames run on the box through the bridge → `environment.exec`.

The pure bridge + the glue WIRING are unit-tested with no Docker and no Harbor
(`tests/`, 27 tests). What needs a box is only the live `tb run` (real container,
real installed brain, real creds) — flagged **box-phase** throughout.

---

## Install (local dev — no Docker, no Harbor)

```sh
cd adapters/terminal-bench
pip install -e .
```

This installs the bridge + the `quanta_agent` glue with **zero** third-party deps.
`quanta_agent` imports harbor under a `try/except` fallback, so importing it works
with harbor absent:

```sh
python3 -c "import quanta_agent; print(quanta_agent.QuantaAgent.name())"   # -> quanta
python3 -m pytest -q                                                       # -> 27 passed
```

Install the real framework only inside the box image:

```sh
pip install -e ".[harbor]"   # box-phase; pulls harbor-framework/harbor (box-verify the ref)
```

---

## Register the agent with Harbor

Harbor loads a CUSTOM agent by its **import path** `module:Class` via the
`--agent-import-path` flag (VERIFIED against harbor 0.16.1 — it sets
`AgentConfig.import_path`; the bare `--agent` flag is for harbor's BUILT-IN named agents
only — `aider|claude-code|terminus-2|…`). This package installs a top-level `quanta_agent`
module exposing `QuantaAgent` (a concrete `harbor.agents.base.BaseAgent` subclass —
verified in-image: zero remaining abstract methods, `name()=="quanta"`), so the run flag is:

```
--agent-import-path quanta_agent:QuantaAgent
```

---

## Credentials (B6 — how provider keys reach the brain)

**Secrets are NEVER baked into the image.** The Dockerfile holds no `ARG`/`ENV` key —
a `docker history` / layer grep finds nothing. Creds flow in at **run time**:

```
host shell / CI secret store
   └─ harbor / tb run injects into the CONTAINER env  (task-env / -e KEY=VAL)
        └─ QuantaAgent.run() -> _brain_env() copies the parent env
             └─ quanta-terminal-brain shim -> bun -> brain-mode.ts
                  └─ quanta LLM factory reads ANTHROPIC_API_KEY / OPENAI_API_KEY
```

The brain's LLM factory (`src/llm/factory.ts`) selects a provider from
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; `quanta_agent._CRED_ENV_ALLOWLIST` forwards
exactly those plus `QUANTA_API_KEY`. Provide **at least one** of:

| env var             | used by                        |
| ------------------- | ------------------------------ |
| `ANTHROPIC_API_KEY` | brain LLM (Anthropic BYOK)     |
| `OPENAI_API_KEY`    | brain LLM (OpenAI BYOK)        |
| `QUANTA_API_KEY`    | brain LLM (quanta gateway)     |

Pass them at run time, e.g.:

```sh
# box-phase — requires Docker daemon + harbor installed
harbor run \
  -d terminal-bench/terminal-bench-2 \
  -m gpt-5 \
  --agent-import-path quanta_agent:QuantaAgent \
  -e OPENAI_API_KEY="$OPENAI_API_KEY"          # or ANTHROPIC_API_KEY / QUANTA_API_KEY
```

> Harbor itself shells out to the host `docker` to provision each task's container
> (verified: it aborts with "Docker is not installed" when `docker` is absent), so
> harbor runs on the HOST (Docker Desktop), not inside this image — the image is the
> agent runtime harbor builds/uses. `QuantaAgent.run()` spawns the brain there and its
> `container_exec` frames reach the task container via `environment.exec`.

> Do **not** put keys in the Dockerfile, in `pyproject.toml`, or in any committed
> file. The only baked env is `QUANTA_TERMINAL_BRAIN_CMD=quanta-terminal-brain`
> (non-secret: it just names the brain shim).

Model selection: `-m <model>` is harbor's; quanta's brain also honors
`QUANTA_TERMINAL_MODEL` / the `QuantaAgent(model=…)` ctor arg → forwarded as
`--model` to the brain.

---

## Build the box image (box-phase — requires Docker daemon)

The Dockerfile's build context is the **quanta repo root** (it copies `src/`, the
tsconfig path-alias config, and this adapter):

```sh
# from the repo root
docker build -f adapters/terminal-bench/Dockerfile -t quanta-tb:local .
```

Harbor builds/uses this image to provision the box. The image contains: the bun
runtime + quanta `src/`, the `quanta-terminal-brain` shim, the Python hands
(`pip install ".[harbor]"`), and `QUANTA_TERMINAL_BRAIN_CMD` pre-set. No creds.

---

## Box verification status (run against real Docker + harbor 0.16.1)

VERIFIED on a live Docker daemon + the real `harbor` (jul-01):
- ✅ **Image builds end-to-end** — `docker build … -t quanta-tb:local .` → 1.7 GB; the
  real `harbor 0.16.1` + `quanta-terminal-bench 0.1.0` install. (Found+fixed: the image
  needed `git` for pip's VCS clone of harbor.)
- ✅ **Agent loads as a valid harbor agent** — `quanta_agent:QuantaAgent` import_path
  resolves, IS a `harbor.agents.base.BaseAgent` subclass, ZERO remaining abstract methods.
- ✅ **AgentContext fold verified** — harbor's real `AgentContext` (pydantic) accepts
  `n_input_tokens`/`n_output_tokens`/`cost_usd` + the raw report on `metadata`
  (`rollout_details` is `list[RolloutDetail]`, so the report rides `metadata` instead).
- ✅ **brain shim** — `quanta-terminal-brain --version` → exit 0 (what `setup()` probes).
- ✅ **real LLM wired** — `brain-mode.ts buildRealLlm` now binds the shared `tryCreateLLM`
  provider factory (no longer a throw).

Remaining for a green LIVE `tb run` (needs LLM tokens + a task):
1. Run harbor on the HOST (Docker Desktop up) with this package installed
   (`pip install -e adapters/terminal-bench`) — harbor provisions the task container via
   the host `docker`.
2. Download a task/dataset (`harbor download …` / `-d terminal-bench/…`).
3. Provide a brain credential (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`QUANTA_API_KEY`) the
   `tryCreateLLM` factory can use, and run:
   ```sh
   harbor run -d terminal-bench/terminal-bench-2 -m <model> \
     --agent-import-path quanta_agent:QuantaAgent -e OPENAI_API_KEY="$OPENAI_API_KEY"
   ```
4. Score quanta+Opus-4.8 vs the standardized-scaffold Opus-4.8 baseline (58.3%).
