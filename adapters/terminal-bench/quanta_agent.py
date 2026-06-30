"""
Harbor ``BaseAgent`` glue for Terminal-Bench — the BOX-DEPENDENT hands-side entry.

⚠️ REQUIRES A BOX: this imports ``harbor`` (the harness) and only runs against a
live ``environment`` inside a provisioned container. It is intentionally NOT
unit-tested — the testable protocol/serve core lives in ``quanta_terminal_bridge``
and is fully covered without infrastructure. This file is the thin, verified-shape
wiring that the P2 box phase activates.

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

from typing import Any

from quanta_terminal_bridge import Environment, ExecResult

try:  # box-only: harbor is installed on the provisioned box, not in local dev
    from harbor.agents.base import BaseAgent  # type: ignore
    from harbor.environments.base import BaseEnvironment  # type: ignore
except Exception:  # noqa: BLE001 — local dev / unit env has no harbor; glue is box-only
    BaseAgent = object  # type: ignore
    BaseEnvironment = Any  # type: ignore


class HarborEnvironmentAdapter(Environment):
    """Adapt a Harbor ``BaseEnvironment`` to the bridge's ``Environment`` protocol:
    its ``exec`` already returns stdout/stderr/return_code, so this is a faithful
    1:1 shim (the one place Harbor's result shape meets ours)."""

    def __init__(self, environment: "BaseEnvironment") -> None:
        self._env = environment

    async def exec(self, command: str) -> ExecResult:
        r = await self._env.exec(command)
        return ExecResult(stdout=r.stdout, stderr=r.stderr, return_code=r.return_code)


class QuantaAgent(BaseAgent):  # type: ignore[misc]
    """quanta terminal-operator as a Harbor agent (box-only)."""

    @staticmethod
    def name() -> str:
        return "quanta"

    @staticmethod
    def version() -> "str | None":
        return None

    async def setup(self, environment: "BaseEnvironment") -> None:  # noqa: D401
        # Box phase: install/verify the quanta brain binary inside/alongside the env.
        return None

    async def run(  # noqa: D401
        self,
        instruction: str,
        environment: "BaseEnvironment",
        context: Any,
    ) -> None:
        # Box phase (the only un-unit-testable seam): spawn the quanta-TS brain, connect
        # its stdio as the bridge transport, and `serve(lines, write, adapter)` so the
        # brain's container_exec calls run via `environment.exec`. Then fill `context`
        # (n_*_tokens / cost_usd / rollout_details) from the brain's final report.
        #   adapter = HarborEnvironmentAdapter(environment)
        #   await serve(brain_stdout_lines, brain_stdin_write, adapter)
        raise NotImplementedError("QuantaAgent.run is wired in the P2 box phase")
