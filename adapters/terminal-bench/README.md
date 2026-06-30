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

Harbor loads an agent by an **import selector** `module:Class` (RFC §3). This package
installs a top-level `quanta_agent` module exposing `QuantaAgent`, so the selector is:

```
--agent quanta_agent:QuantaAgent
```

`QuantaAgent.name()` returns `quanta`.

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
  --agent quanta_agent:QuantaAgent \
  -e OPENAI_API_KEY="$OPENAI_API_KEY"          # or ANTHROPIC_API_KEY / QUANTA_API_KEY
```

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

## Box-phase steps remaining to a green `tb run`

Everything above is verified WITHOUT a daemon (import smoke, pytest, shim logic,
contract-match — see the agent's report). To reach a green live run you still need:

1. **Docker daemon up** + **harbor installed** (`pip install ".[harbor]"`, box-verify
   the harbor-framework ref pinned in `pyproject.toml`).
2. **Build the image**: `docker build -f adapters/terminal-bench/Dockerfile -t quanta-tb:local .` (from repo root).
   Resolve any `# box-verify` pins (bun tag digest, python3 version, harbor ref).
3. **Wire the real brain LLM**: `brain-mode.ts`'s `buildRealLlm` currently throws
   ("box-wired"); bind it to the provider factory on the box.
4. **Run**:
   ```sh
   harbor run -d terminal-bench/terminal-bench-2 -m <model> \
     --agent quanta_agent:QuantaAgent -e OPENAI_API_KEY="$OPENAI_API_KEY"
   ```
5. Confirm `setup()` passes (`quanta-terminal-brain --version` → exit 0 in-box) and a
   task `run()` produces a `--report-out` the hands fold into `AgentContext`
   (box-verify the `AgentContext` field names in `quanta_agent._apply_report_to_context`).
