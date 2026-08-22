# syntax=docker/dockerfile:1.7
#
# Box image Harbor builds to run quanta as a Terminal-Bench agent.
#
# ┌── ROLES inside this image ─────────────────────────────────────────────────┐
# │ HANDS  = the Python `quanta_agent.QuantaAgent` (Harbor BaseAgent glue) +    │
# │          `quanta_terminal_bridge` serve loop. Harbor loads + drives it.     │
# │ BRAIN  = the quanta-TS operator: `bun run …/src/apps/terminal/brain-mode.ts`│
# │          launched by the hands via the `quanta-terminal-brain` shim.        │
# └────────────────────────────────────────────────────────────────────────────┘
#
# BUILD CONTEXT = the QUANTA REPO ROOT (not this adapter dir) — the brain needs the
#   whole `src/` tree + tsconfig path-alias config + node_modules. Harbor must build
#   with:  docker build -f adapters/terminal-bench/Dockerfile -t quanta-tb <repo-root>
#   (the README spells the harbor-driven equivalent).
#
# SECRETS: provider creds are NEVER baked here. No ARG/ENV holds a key. They arrive
#   at RUN time via Harbor task-env / `-e` and `quanta_agent._brain_env()` forwards
#   them to the brain (README §creds). A grep for *_API_KEY below MUST find nothing.
#
# Pins are explicit; anything unverifiable without a daemon is tagged `# box-verify`.

# ── Stage 1: bun runtime + quanta repo + brain deps ───────────────────────────
# box-verify: confirm this exact bun tag is the one the brain is tested against
# (local dev bun == 1.3.14). Pinned to the matching minor; digest-pin on the box.
FROM oven/bun:1.3.14-debian AS brain

# Python 3 is needed in the FINAL image for the hands; install it in the base that
# carries bun so we ship ONE runtime layer with both. (debian variant has apt.)
# box-verify: python3.11+ availability on this debian release; pin once built.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      ca-certificates \
      git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/quanta

# Dependency layer first (cache-friendly): only the manifest + lockfile, then a
# frozen install. bunfig.toml carries the install config; bun.lock pins versions.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Now the source + the tsconfig path-alias config the `@/` imports resolve through.
# (brain-mode.ts imports `@/activity`, `@/host/bootstrap`, … — these resolve via
# tsconfig.base.json `paths` + `baseUrl`, so BOTH tsconfigs are required at root.)
COPY tsconfig.json tsconfig.base.json ./
COPY src ./src

# ── The brain launch shim: `quanta-terminal-brain` ───────────────────────────
# COPIED, never re-declared here. The shim is a tracked file and the contract it
# implements (--version interception, verbatim argv forwarding, root resolution)
# is documented at its own head.
#
# This image used to `printf` its own copy of that shim. Two consequences, both
# real: the image and the repo could drift apart with nothing to notice, and —
# worse — the HOST had no shim at all, because Harbor launches the Python hands
# with `uv run --project adapters/terminal-bench harbor run …` on the host, so
# the brain is spawned there too. aug-22 measurement: `terminal doctor` returned
# `BLOCKED: brain-shim — Executable not found in $PATH`, i.e. no 2.1 canary had
# ever been startable. One tracked file now serves both.
#
# Pinned by tests/unit/apps/bench/terminal/brain-shim-hellgate.test.ts.
COPY adapters/terminal-bench/bin/quanta-terminal-brain /usr/local/bin/quanta-terminal-brain
RUN chmod +x /usr/local/bin/quanta-terminal-brain

# ── The Python hands: bridge + glue ──────────────────────────────────────────
# Installed into the system python with the harbor extra (box-only). Editable is
# unnecessary in the image; a normal install is reproducible. `.[harbor]` pulls
# the real harbor framework (VCS-pinned in pyproject — box-verify the ref).
WORKDIR /opt/quanta/adapters/terminal-bench
COPY adapters/terminal-bench/pyproject.toml ./pyproject.toml
COPY adapters/terminal-bench/README.md ./README.md
COPY adapters/terminal-bench/quanta_agent.py ./quanta_agent.py
COPY adapters/terminal-bench/quanta_terminal_bridge ./quanta_terminal_bridge
COPY adapters/terminal-bench/protocol-golden.json ./protocol-golden.json
# box-verify: `.[harbor]` resolution needs network + the right harbor ref. If the
# box pins harbor by a different mechanism, install it separately and `pip install .`
# (no extra) here instead.
RUN python3 -m pip install --no-cache-dir --break-system-packages ".[harbor]"

# ── Wire the brain cmd for the hands (NON-secret config only) ─────────────────
# This is the ONE env the contract needs baked: where the brain shim lives. It is
# NOT a secret. Creds are injected at run time (Harbor task-env / -e), never here.
ENV QUANTA_TERMINAL_BRAIN_CMD=quanta-terminal-brain
# …and where the repo it should launch lives. The shim sits in /usr/local/bin,
# outside the repo, so it cannot derive the root from its own path here — the
# image states it rather than letting the shim guess.
ENV QUANTA_TERMINAL_BRAIN_REPO=/opt/quanta

# Sanity defaults so the brain runs as a non-interactive operator. (No secrets.)
ENV PYTHONUNBUFFERED=1

# box-verify: Harbor selects the agent at run time via `--agent quanta_agent:QuantaAgent`;
# it imports `quanta_agent` from the installed package above. No ENTRYPOINT/CMD here —
# Harbor owns the container lifecycle and invokes the agent, not a baked entrypoint.
