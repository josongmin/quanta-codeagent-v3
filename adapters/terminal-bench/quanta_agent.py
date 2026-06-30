"""
Harbor ``BaseAgent`` glue for Terminal-Bench — the BOX-DEPENDENT hands-side entry.

⚠️ REQUIRES A BOX TO ACTUALLY RUN: against a real container ``environment`` this
imports ``harbor`` and spawns a real brain subprocess. But the WIRING is proven
without a box: the spawn is injectable via the module-level ``_spawn_brain`` seam,
so ``tests/test_quanta_agent_run.py`` pins run()/setup() with a fake brain + fake
env (no harbor, no Docker, no subprocess). The pure protocol/serve core lives in
``quanta_terminal_bridge`` (also box-free). What still NEEDS a box is only the real
``tb run`` integration: a live container, a real installed brain, real creds.

Interface verified P0 (harbor-framework/harbor main, RFC §7.5):
  BaseAgent: staticmethod name()->str · version()->str|None ·
             async setup(self, environment)->None ·
             async run(self, instruction, environment, context: AgentContext)->None
  BaseEnvironment.exec(command, ...) -> ExecResult{stdout:str|None, stderr:str|None, return_code:int}

Flow: Harbor loads this agent, hands it a container ``environment``. ``run`` spawns
the quanta-TS BRAIN as a subprocess and runs the bridge ``serve`` loop so the brain's
``container_exec`` calls (line-delimited JSON, see quanta_terminal_bridge.protocol)
execute via ``environment.exec`` — i.e. THIS process is the "hands", quanta-TS is the
"brain" (RFC §11 F2). On completion it fills ``context`` token/cost/trajectory slots.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any, AsyncIterator, Optional, Protocol

from quanta_terminal_bridge import Environment, ExecResult, serve

try:  # box-only: harbor is installed on the provisioned box, not in local dev
    from harbor.agents.base import BaseAgent  # type: ignore
    from harbor.environments.base import BaseEnvironment  # type: ignore
except Exception:  # noqa: BLE001 — local dev / unit env has no harbor; glue is box-only
    BaseAgent = object  # type: ignore
    BaseEnvironment = Any  # type: ignore


# Default brain executable; override via env so the box can point at an installed
# path without a code change. The TS brain MUST accept the argv shape below.
_DEFAULT_BRAIN_CMD = "quanta-terminal-brain"

# Provider creds the brain needs to talk to its LLM. For now (B6 will tighten this
# to an explicit-allowlist-only env) we forward the parent env WHOLESALE so creds
# pass through; this list is the documented minimum the box must provide and the
# anchor B6 narrows down to.
_CRED_ENV_ALLOWLIST = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "QUANTA_API_KEY",
)


class BrainProcess(Protocol):
    """Shape of a spawned brain (real or fake) — see ``_spawn_brain``.

    ``stdout_lines`` is an async iterator of the brain's outbound JSON frames (what
    ``serve`` reads); ``stdin_write`` writes one encoded frame line back to the
    brain's stdin (what ``serve`` calls to reply); ``wait`` awaits brain exit (and,
    for a real brain, is when its ``--report-out`` file is fully flushed)."""

    def stdout_lines(self) -> AsyncIterator[str]: ...
    async def stdin_write(self, line: str) -> None: ...
    async def wait(self) -> None: ...


class HarborEnvironmentAdapter(Environment):
    """Adapt a Harbor ``BaseEnvironment`` to the bridge's ``Environment`` protocol:
    its ``exec`` already returns stdout/stderr/return_code, so this is a faithful
    1:1 shim (the one place Harbor's result shape meets ours)."""

    def __init__(self, environment: "BaseEnvironment") -> None:
        self._env = environment

    async def exec(self, command: str) -> ExecResult:
        r = await self._env.exec(command)
        return ExecResult(stdout=r.stdout, stderr=r.stderr, return_code=r.return_code)


class _AsyncSubprocessBrain:
    """Real spawned brain: wraps an ``asyncio.subprocess.Process`` and exposes the
    ``BrainProcess`` shape. Box-only path — exercised by ``tb run``, not unit tests
    (unit tests inject a fake via ``_spawn_brain``)."""

    def __init__(self, proc: "asyncio.subprocess.Process") -> None:
        self._proc = proc

    async def stdout_lines(self) -> AsyncIterator[str]:
        assert self._proc.stdout is not None
        async for raw in self._proc.stdout:  # newline-delimited by the StreamReader
            yield raw.decode("utf-8", errors="replace").rstrip("\n")

    async def stdin_write(self, line: str) -> None:
        stdin = self._proc.stdin
        assert stdin is not None
        stdin.write((line + "\n").encode("utf-8"))
        await stdin.drain()

    async def wait(self) -> None:
        stdin = self._proc.stdin
        if stdin is not None:  # EOF the brain's stdin so it can finish + flush report
            try:
                stdin.close()
            except Exception:  # noqa: BLE001 — already-closed pipe is fine
                pass
        await self._proc.wait()


async def _spawn_brain(
    argv: "list[str]", env: "dict[str, str]", report_path: str
) -> BrainProcess:
    """Spawn the quanta-TS brain subprocess wired for the bridge. SEAM: unit tests
    monkeypatch this to return a fake brain, so the wiring is proven without ever
    launching a real process. ``report_path`` is already encoded in ``argv``
    (``--report-out``); it is passed explicitly so a fake can target it directly."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        env=env,
    )
    return _AsyncSubprocessBrain(proc)


def _brain_cmd() -> str:
    return os.environ.get("QUANTA_TERMINAL_BRAIN_CMD") or _DEFAULT_BRAIN_CMD


def _brain_env() -> "dict[str, str]":
    """Env handed to the brain: the parent env wholesale (so creds in
    ``_CRED_ENV_ALLOWLIST`` and PATH pass through). B6 will narrow this to an
    explicit allowlist; the wholesale copy is the permissive interim."""
    return dict(os.environ)


def _apply_report_to_context(report: "dict[str, Any]", context: Any) -> None:
    """Fold the brain's final report into the harbor ``AgentContext``.

    Field names VERIFIED against harbor 0.16.1 (the AgentContext pydantic model):
    ``n_input_tokens``/``n_output_tokens`` (int|None), ``cost_usd`` (float|None),
    ``metadata`` (dict[str, Any]|None). Note ``rollout_details`` is typed
    ``list[RolloutDetail]`` — NOT a free dict — so the brain's raw record rides the
    free-form ``metadata`` slot instead (we don't synthesize RolloutDetail objects).
    Every slot is hasattr-guarded so the dev fake (no harbor) degrades to a no-op
    instead of crashing."""
    tokens = report.get("tokens")
    if not isinstance(tokens, dict):  # malformed/absent tokens → no token slots
        tokens = {}

    def _set(name: str, value: Any) -> None:
        if value is not None and hasattr(context, name):
            setattr(context, name, value)

    _set("n_input_tokens", tokens.get("input"))
    _set("n_output_tokens", tokens.get("output"))
    _set("cost_usd", report.get("cost_usd"))
    # rollout_details is list[RolloutDetail] (not a dict); the brain's raw record
    # (turns/final/trajectory) rides the free-form metadata slot, which IS dict-typed.
    _set("metadata", report)


class QuantaAgent(BaseAgent):  # type: ignore[misc]
    """quanta terminal-operator as a Harbor agent (box-only).

    ``model`` is resolved from (constructor arg) → (``QUANTA_TERMINAL_MODEL`` env)
    and forwarded to the brain via ``--model``."""

    def __init__(self, *, model: "str | None" = None, **_kwargs: Any) -> None:
        # **_kwargs: harbor may construct agents with extra config; swallow unknown
        # keys so construction never breaks on a harbor-side addition.
        self._model = model or os.environ.get("QUANTA_TERMINAL_MODEL")

    @staticmethod
    def name() -> str:
        return "quanta"

    @staticmethod
    def version() -> "str | None":
        return None

    @property
    def model(self) -> "str | None":
        return self._model

    async def setup(self, environment: "BaseEnvironment") -> None:
        """Box phase: verify the quanta brain is runnable in/alongside the env.

        Probes ``<brain> --version`` and raises a clear ``RuntimeError`` if it is
        not present (non-zero exit / not found), so a misprovisioned box fails loud
        at setup instead of mid-run. Testable with a fake environment."""
        adapter = HarborEnvironmentAdapter(environment)
        brain = _brain_cmd()
        result = await adapter.exec(f"{brain} --version")
        if result.return_code != 0:
            raise RuntimeError(
                f"quanta brain '{brain}' is not runnable in the environment "
                f"(`{brain} --version` exited {result.return_code}); "
                f"install it or set QUANTA_TERMINAL_BRAIN_CMD. "
                f"stderr={result.stderr!r}"
            )

    async def run(
        self,
        instruction: str,
        environment: "BaseEnvironment",
        context: Any,
    ) -> None:
        """Box phase (the only un-unit-testable seam): spawn the quanta-TS brain,
        bridge its stdio to the container via ``serve``, then fold its final report
        into ``context``.

        Wiring (proven by unit tests with fakes; the real run still needs a box):
          * write ``instruction`` to a temp file → ``--instruction-file`` (no arg
            escaping); ``--model`` from config; ``--report-out`` a temp file the
            brain writes its final JSON report to.
          * ``serve(brain.stdout_lines(), brain.stdin_write, adapter)`` runs until
            the brain closes stdout (EOF); the brain's ``exec`` frames execute via
            ``environment.exec`` and ``exec_result`` frames return to its stdin.
          * after the brain exits, parse ``--report-out`` and populate ``context``.
        """
        adapter = HarborEnvironmentAdapter(environment)

        with tempfile.TemporaryDirectory(prefix="quanta-tb-") as tmp:
            instruction_file = Path(tmp) / "instruction.txt"
            instruction_file.write_text(instruction)
            report_path = str(Path(tmp) / "report.json")

            argv = [_brain_cmd(), "--instruction-file", str(instruction_file)]
            if self._model:
                argv += ["--model", self._model]
            argv += ["--report-out", report_path]

            brain = await _spawn_brain(argv, _brain_env(), report_path)

            # The bridge: serve drains the brain's stdout, runs each exec via the
            # adapter, and replies on the brain's stdin. Returns on brain EOF.
            await serve(brain.stdout_lines(), brain.stdin_write, adapter)
            # Let the brain finish + flush its report file, then ingest it.
            await brain.wait()

            report = _read_report(report_path)
            if report is not None:
                _apply_report_to_context(report, context)


def _read_report(report_path: str) -> "Optional[dict[str, Any]]":
    """Read + parse the brain's final report; a missing/garbled report degrades to
    ``None`` (the box run already happened — we don't crash teardown over telemetry)."""
    try:
        raw = Path(report_path).read_text()
    except OSError:
        return None
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None
