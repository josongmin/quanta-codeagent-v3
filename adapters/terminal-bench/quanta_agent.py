"""
Harbor ``BaseAgent`` glue for Terminal-Bench 2.1 — the BOX-DEPENDENT hands-side entry.

⚠️ REQUIRES A BOX TO ACTUALLY RUN: against a real container ``environment`` this
imports ``harbor`` and spawns a real brain subprocess. But the WIRING is proven
without a box: the spawn is injectable via the module-level ``_spawn_brain`` seam,
so ``tests/`` pins run()/setup()/version()/effort/ATIF with a fake brain + fake env
(no harbor, no Docker, no subprocess). The pure protocol/serve core lives in
``quanta_terminal_bridge`` (also box-free); ATIF emission lives in
``quanta_terminal_atif``.

Interface READ OUT OF THE PINNED PACKAGE (harbor 0.21.0 — see README for how):
  BaseAgent (``harbor/agents/base.py``):
    staticmethod name() -> str
    **instance** method version() -> str | None      ← was a staticmethod in 0.16.x
    async setup(self, environment) -> None
    async run(self, instruction, environment, context: AgentContext) -> None
    class vars SUPPORTS_ATIF / SUPPORTS_RESUME / SUPPORTS_WINDOWS / …
    __init__(logs_dir, model_name=None, logger=None, mcp_servers=None,
             skills_dir=None, *args, extra_env=None, load_trajectory=None, **kwargs)
  AgentContext (``harbor/models/agent/context.py``):
    n_input_tokens / n_cache_tokens / n_output_tokens / cost_usd /
    rollout_details: list[RolloutDetail] / metadata: dict
    — there is NO trajectory field; ATIF is a FILE (see ``quanta_terminal_atif``).
  Custom agent selection: ``harbor run --agent quanta_agent:QuantaAgent``
    (``--agent-import-path`` was removed; ``AgentFactory.create_agent_from_config``
     treats a ``name`` containing ``:`` as an import path).
  Agent kwargs: ``--ak key=value`` → ``AgentConfig.kwargs`` → the constructor.
  Agent env:    ``--ae KEY=VALUE``  → the ``extra_env`` kwarg.

Flow: Harbor loads this agent, hands it a container ``environment``. ``run`` spawns
the quanta-TS BRAIN as a subprocess and runs the bridge ``serve`` loop so the brain's
``container_exec`` calls (line-delimited JSON, see quanta_terminal_bridge.protocol)
execute via ``environment.exec`` — i.e. THIS process is the "hands", quanta-TS is the
"brain". On completion it fills ``context`` token/cost/metadata slots and writes the
ATIF trajectory Harbor uploads as the Hub ``trajectory_path``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, AsyncIterator, Optional, Protocol

import quanta_terminal_atif as atif
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

# Provider creds the brain needs to talk to its LLM. Documented minimum the box
# must provide. The REDACTION authority (which env names hold secrets) is
# ``quanta_terminal_atif.SECRET_ENV_NAMES`` / ``SECRET_ENV_NAME_SUFFIXES`` — one
# SSOT, so a new provider key is scrubbed without editing two lists.
_CRED_ENV_ALLOWLIST = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "QUANTA_API_KEY",
)

# ── provenance (TB21-02) ─────────────────────────────────────────────────────

#: Runtime-injected agent version. The bench run command DERIVES this from the
#: exact Quanta commit + package version and injects it with ``--ae`` (or a host
#: export). Absent ⇒ construction fails: a trial with no provenance can never be
#: reconciled with a leaderboard row, because the upstream submission key is
#: ``(agent, agent_version, model, reasoning_effort)``.
AGENT_VERSION_ENV = "QUANTA_TB_AGENT_VERSION"

#: ``<package-version>+g<sha>[.dirty]``
#:
#: * ``package-version`` — the quanta repo ``package.json`` ``version``
#:   (e.g. ``1.0.025``); dotted numeric segments only.
#: * ``g<sha>`` — the exact commit, 7–40 lowercase hex (``git describe`` style).
#: * ``.dirty`` — REQUIRED when the working tree is not clean, FORBIDDEN when it
#:   is. This is the non-promotable marker: a dirty development run can never
#:   present itself as the clean SHA.
AGENT_VERSION_RE = re.compile(
    r"^(?P<package>[0-9]+(?:\.[0-9]+)*)\+g(?P<commit>[0-9a-f]{7,40})(?P<dirty>\.dirty)?$"
)

# ── reasoning effort (TB21-02) ───────────────────────────────────────────────

#: The knob the brain's LLM composition root reads
#: (``src/llm/factory.ts`` ``resolveReasoningEffort``).
REASONING_EFFORT_ENV = "QUANTA_REASONING_EFFORT"

#: Harbor's official custom-agent effort vocabulary, taken from the reference
#: leaderboard agent's constructor Literal
#: (``harbor/agents/terminus_2/terminus_2.py``). The official 2.1 leaderboard
#: config uses ``xhigh`` / ``max`` / ``high``.
HARBOR_REASONING_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max", "default"}
)

#: The values Quanta's own Responses wire actually FORWARDS to the provider —
#: ``normalizeResponsesReasoningEffort`` (``src/llm/openai-responses-wire.ts``)
#: is the closed-set SSOT and DROPS anything outside this set.
#:
#: The difference matters: reporting ``reasoning_effort: max`` on a leaderboard
#: row while the provider silently received its own default would be a false
#: receipt, so a Harbor-legal value outside this set runs but is NOT promotable.
WIRE_HONORED_REASONING_EFFORTS = frozenset({"minimal", "low", "medium", "high", "xhigh"})


class AgentVersion:
    """Parsed :data:`AGENT_VERSION_ENV` value."""

    __slots__ = ("raw", "package_version", "commit", "dirty")

    def __init__(self, raw: str, package_version: str, commit: str, dirty: bool) -> None:
        self.raw = raw
        self.package_version = package_version
        self.commit = commit
        self.dirty = dirty

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return "AgentVersion({0!r})".format(self.raw)


def parse_agent_version(raw: "str | None") -> AgentVersion:
    """Parse + validate an injected agent version. Never guesses, never defaults."""
    if raw is None:
        raise RuntimeError(
            "{0} is not set. The bench run command must inject it as "
            "'<package-version>+g<sha>' (append '.dirty' for an uncommitted "
            "tree, which marks the run non-promotable). Deliver it with "
            "`harbor run --ae {0}=...` or a host export.".format(AGENT_VERSION_ENV)
        )
    match = AGENT_VERSION_RE.match(raw)
    if match is None:
        raise ValueError(
            "{0}={1!r} is malformed; expected '<package-version>+g<sha>' with an "
            "optional '.dirty' suffix (e.g. '1.0.025+g9d5369d310bb.dirty')".format(
                AGENT_VERSION_ENV, raw
            )
        )
    return AgentVersion(
        raw=raw,
        package_version=match.group("package"),
        commit=match.group("commit"),
        dirty=match.group("dirty") is not None,
    )


def normalize_reasoning_effort(raw: "str | None") -> "str | None":
    """Normalize + validate a requested reasoning effort.

    Returns ``None`` when nothing was requested. Raises ``ValueError`` for a
    value outside Harbor's official vocabulary — BEFORE the brain is spawned, so
    an unknown effort can never silently default to the provider's own setting.
    """
    if raw is None:
        return None
    effort = str(raw).strip().lower()
    if effort == "":
        return None
    if effort not in HARBOR_REASONING_EFFORTS:
        raise ValueError(
            "reasoning_effort={0!r} is not one of Harbor's values {1}".format(
                effort, sorted(HARBOR_REASONING_EFFORTS)
            )
        )
    return effort


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
    ``BrainProcess`` shape. Box-only path — exercised by ``harbor run``, not unit
    tests (unit tests inject a fake via ``_spawn_brain``)."""

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
    (``--report-out``); it is passed explicitly so a fake can target it directly.

    Observability: the brain logs (turns / tool calls / errors) to STDERR (stdout is
    reserved for protocol frames). When ``QUANTA_TB_BRAIN_LOG_DIR`` is set, the brain's
    stderr is captured to a file there (one per run) so a run can be inspected after the
    fact; absent ⇒ stderr is inherited (default, byte-identical)."""
    log_dir = env.get("QUANTA_TB_BRAIN_LOG_DIR")
    stderr_dest = None
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        stamp = os.path.basename(os.path.dirname(report_path)) or "brain"
        stderr_dest = open(os.path.join(log_dir, f"brain-{stamp}.stderr.log"), "ab")  # noqa: SIM115
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr_dest,  # None ⇒ inherit (default); a file ⇒ captured for inspection
            env=env,
        )
    finally:
        if stderr_dest is not None:
            stderr_dest.close()  # the child holds its own dup'd fd; the parent handle is done
    return _AsyncSubprocessBrain(proc)


def _brain_cmd(env: "dict[str, str]") -> str:
    return env.get("QUANTA_TERMINAL_BRAIN_CMD") or _DEFAULT_BRAIN_CMD


def _overlay_env(extra_env: "Optional[dict[str, str]]") -> "dict[str, str]":
    """Brain subprocess env = the host env (``os.environ``) with Harbor's ``--ae``/
    ``--agent-env`` values (``extra_env``) OVERLAID on top. Overlay order matters:
    ``extra_env`` WINS, so ``--ae QUANTA_TB_ENV_OWNED=1`` flips the knob even when the
    host env leaves it unset — and a plain host ``export`` still works (os.environ is the
    base). Same precedence as harbor's own ``BaseAgent._env_sources``. This is the SINGLE
    env source for ``_brain_cmd`` / ``_probe_brain_version`` / ``_spawn_brain`` / model /
    version / effort resolution, so both delivery paths light up the same knobs."""
    return {**os.environ, **(extra_env or {})}


async def _probe_brain_version(brain: str, env: "dict[str, str]") -> "tuple[int, str]":
    """Run ``<brain> --version`` ON THE HOST (where ``run`` spawns the brain — it is a host
    subprocess that drives the task container via ``container_exec``, NOT installed inside the
    environment). Returns ``(return_code, stderr)``; a missing binary maps to ``(127, …)``. SEAM:
    unit tests monkeypatch this so ``setup`` is verified without a real brain."""
    try:
        proc = await asyncio.create_subprocess_exec(
            brain,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as e:
        return 127, str(e)
    _, stderr = await proc.communicate()
    return (proc.returncode or 0), stderr.decode("utf-8", errors="replace")


def _apply_report_to_context(
    report: "Optional[dict[str, Any]]",
    context: Any,
    provenance: "dict[str, Any]",
    env: "dict[str, str]",
) -> None:
    """Fold the brain's final report + the provenance receipt into ``AgentContext``.

    Field names VERIFIED against the pinned harbor's ``AgentContext`` pydantic model:
    ``n_input_tokens``/``n_cache_tokens``/``n_output_tokens`` (int|None), ``cost_usd``
    (float|None), ``metadata`` (dict[str, Any]|None). ``rollout_details`` is typed
    ``list[RolloutDetail]`` — NOT a free dict — so the brain's raw record rides the
    free-form ``metadata`` slot instead (we don't synthesize RolloutDetail objects).
    Every slot is hasattr-guarded so the dev fake (no harbor) degrades to a no-op
    instead of crashing.

    Quanta's own typed receipts (``verification`` / ``selfTest`` / ``oracleLoop`` /
    ``envPosture``) stay here verbatim — ATIF does not replace them — but the whole
    payload is scrubbed of live credential values first."""
    tokens = report.get("tokens") if isinstance(report, dict) else None
    if not isinstance(tokens, dict):  # malformed/absent tokens → no token slots
        tokens = {}

    def _set(name: str, value: Any) -> None:
        if value is not None and hasattr(context, name):
            setattr(context, name, value)

    _set("n_input_tokens", tokens.get("input"))
    _set("n_output_tokens", tokens.get("output"))
    _set("n_cache_tokens", tokens.get("cached"))
    _set("cost_usd", report.get("cost_usd") if isinstance(report, dict) else None)

    metadata: "dict[str, Any]" = {}
    if isinstance(report, dict):
        metadata.update(atif.scrubbed(report, env))
    metadata["quanta_agent"] = provenance
    _set("metadata", metadata)


class QuantaAgent(BaseAgent):  # type: ignore[misc]
    """quanta terminal-operator as a Harbor agent (box-only).

    ``model`` is resolved from (constructor arg) → (harbor's parsed ``model_name``)
    → (``QUANTA_TERMINAL_MODEL`` in the merged env) and forwarded to the brain via
    ``--model``."""

    #: Harbor reads this class var to decide whether the agent speaks ATIF
    #: (``harbor/agents/base.py``). ``run`` writes ``logs_dir/trajectory.json``,
    #: which the uploader publishes as the Hub ``trajectory_path``.
    SUPPORTS_ATIF: bool = True

    def __init__(
        self,
        logs_dir: "str | Path | None" = None,
        model_name: "str | None" = None,
        *args: Any,
        model: "str | None" = None,
        reasoning_effort: "str | None" = None,
        **kwargs: Any,
    ) -> None:
        # Harbor constructs BaseAgent subclasses with (logs_dir, model_name=…, logger=…,
        # extra_env=…, **agent_kwargs) and relies on BaseAgent.__init__ → _init_model_info()
        # to set _parsed_model_name/_provider (read by to_agent_info()). Forward those so
        # harbor's init runs. The `object` fallback (no harbor — the unit env) takes NO
        # args, so guard the super() call and set the same fields by hand.
        if BaseAgent is not object:
            super().__init__(logs_dir, model_name, *args, **kwargs)  # type: ignore[misc]
        else:
            self.logs_dir = Path(logs_dir) if logs_dir is not None else None  # type: ignore[assignment]
            self.model_name = model_name
        # Harbor delivers `--ae KEY=VAL` as the `extra_env` kwarg and stores it on
        # `self._extra_env`; under the fallback we own it. Never clobber harbor's copy.
        if not hasattr(self, "_extra_env"):
            self._extra_env: "dict[str, str]" = dict(kwargs.get("extra_env") or {})

        env = self._brain_run_env()
        # Model resolution: explicit ctor arg → harbor's parsed model_name → merged env
        # (so `--ae QUANTA_TERMINAL_MODEL=…` works too).
        self._model = model or getattr(self, "model_name", None) or env.get("QUANTA_TERMINAL_MODEL")

        # Provenance + effort are validated HERE — before setup(), before run(), and
        # therefore before any model invocation. Both fail loud rather than default.
        self._version = parse_agent_version(env.get(AGENT_VERSION_ENV))
        self._reasoning_effort = normalize_reasoning_effort(
            reasoning_effort if reasoning_effort is not None else env.get(REASONING_EFFORT_ENV)
        )
        self._atif_errors: "list[str]" = []

    # ── env / identity ───────────────────────────────────────────────────────

    def _brain_run_env(self) -> "dict[str, str]":
        """The env handed to the brain subprocess: host env with `--ae` overlaid (SSOT)."""
        return _overlay_env(self._extra_env)

    @staticmethod
    def name() -> str:
        return "quanta"

    def version(self) -> "str | None":
        """The injected agent version, verbatim.

        Instance method (not a staticmethod) — that is the pinned harbor 0.21
        ``BaseAgent`` contract, and ``to_agent_info()`` calls ``self.version()``.
        Never ``None``: construction already failed if it was not injected."""
        return self._version.raw

    @property
    def model(self) -> "str | None":
        return self._model

    @property
    def reasoning_effort(self) -> "str | None":
        """The normalized effort actually delivered to the brain (``None`` = unset)."""
        return self._reasoning_effort

    @property
    def reasoning_effort_wire_honored(self) -> "bool | None":
        if self._reasoning_effort is None:
            return None
        return self._reasoning_effort in WIRE_HONORED_REASONING_EFFORTS

    @property
    def atif_path(self) -> "Path | None":
        """Where this trial's ATIF trajectory belongs (``None`` without a logs dir)."""
        logs_dir = getattr(self, "logs_dir", None)
        if logs_dir is None:
            return None
        return Path(logs_dir) / atif.ATIF_FILENAME

    def agent_info_receipt(self) -> "dict[str, Any]":
        """Everything a report/manifest needs to identify this agent run.

        Harbor's own ``AgentInfo`` carries only name/version/model, and the
        upstream leaderboard reads the effort out of the *job config*; this is
        the receipt Quanta's own report sink records."""
        return {
            "name": self.name(),
            "version": self.version(),
            "package_version": self._version.package_version,
            "commit": self._version.commit,
            "dirty": self._version.dirty,
            "model": self._model,
            "reasoning_effort": self._reasoning_effort,
            "reasoning_effort_wire_honored": self.reasoning_effort_wire_honored,
            "atif_trajectory": atif.ATIF_FILENAME,
        }

    def promotability(self) -> "dict[str, Any]":
        """Whether this run may back a leaderboard submission, and why not.

        Every reason is a hard upstream or internal rule:

        * ``dirty-worktree`` — the backlog: "a dirty run may be used for
          development but is not promotable";
        * ``reasoning-effort-not-wired:<v>`` — Harbor accepts the value but
          Quanta's Responses wire drops it, so the reported effort would not be
          the effort sent to the provider;
        * ``missing-atif-trajectory`` — upstream static analysis fails any
          rewarded trial with no Hub ``trajectory_path``;
        * ``invalid-atif-trajectory`` — the file exists but harbor's own
          validator rejected it.
        """
        reasons: "list[str]" = []
        if self._version.dirty:
            reasons.append("dirty-worktree")
        if self._reasoning_effort is not None and not self.reasoning_effort_wire_honored:
            reasons.append("reasoning-effort-not-wired:{0}".format(self._reasoning_effort))
        path = self.atif_path
        if path is None or not path.exists():
            reasons.append("missing-atif-trajectory")
        elif self._atif_errors:
            reasons.append("invalid-atif-trajectory")
        return {"promotable": not reasons, "reasons": reasons}

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def setup(self, environment: "BaseEnvironment") -> None:
        """Verify the quanta brain is runnable ON THE HOST (where ``run`` spawns it as a
        subprocess that drives the task container via ``container_exec`` — the brain is NOT
        installed inside ``environment``). Probes ``<brain> --version`` and raises a clear
        ``RuntimeError`` on failure, so a misconfigured host fails loud at setup instead of
        mid-run. ``environment`` is unused here (the brain is host-side); kept for the
        harbor ``setup(self, environment)`` contract."""
        del environment  # host-side brain — no container probe (see _probe_brain_version)
        env = self._brain_run_env()
        brain = _brain_cmd(env)
        rc, stderr = await _probe_brain_version(brain, env)
        if rc != 0:
            raise RuntimeError(
                f"quanta brain '{brain}' is not runnable on the host "
                f"(`{brain} --version` exited {rc}); install it or set "
                f"QUANTA_TERMINAL_BRAIN_CMD. stderr={stderr!r}"
            )

    async def run(
        self,
        instruction: str,
        environment: "BaseEnvironment",
        context: Any,
    ) -> None:
        """Box phase (the only un-unit-testable seam): spawn the quanta-TS brain,
        bridge its stdio to the container via ``serve``, then fold its final report
        into ``context`` and emit the ATIF trajectory.

        Wiring (proven by unit tests with fakes; the real run still needs a box):
          * write ``instruction`` to a temp file → ``--instruction-file`` (no arg
            escaping); ``--model`` from config; ``--report-out`` a temp file the
            brain writes its final JSON report to.
          * ``QUANTA_REASONING_EFFORT`` is set ONCE in the brain env from the
            validated ``reasoning_effort`` agent kwarg.
          * ``serve(brain.stdout_lines(), brain.stdin_write, adapter)`` runs until
            the brain closes stdout (EOF); the brain's ``exec`` frames execute via
            ``environment.exec`` and ``exec_result`` frames return to its stdin.
          * after the brain exits, parse ``--report-out``, populate ``context``, and
            write ``logs_dir/trajectory.json`` (ATIF).

        The finalize step runs in a ``finally``: a crashed, cancelled or timed-out
        trial still leaves a bounded terminal receipt rather than a missing trial.
        """
        adapter = HarborEnvironmentAdapter(environment)
        env = self._brain_run_env()
        if self._reasoning_effort is not None:
            env[REASONING_EFFORT_ENV] = self._reasoning_effort

        report: "Optional[dict[str, Any]]" = None
        termination = atif.TERMINATION_ERROR
        try:
            with tempfile.TemporaryDirectory(prefix="quanta-tb-") as tmp:
                instruction_file = Path(tmp) / "instruction.txt"
                instruction_file.write_text(instruction)
                report_path = str(Path(tmp) / "report.json")

                argv = [_brain_cmd(env), "--instruction-file", str(instruction_file)]
                if self._model:
                    argv += ["--model", self._model]
                argv += ["--report-out", report_path]

                brain = await _spawn_brain(argv, env, report_path)

                # The bridge: serve drains the brain's stdout, runs each exec via the
                # adapter, and replies on the brain's stdin. Returns on brain EOF.
                await serve(brain.stdout_lines(), brain.stdin_write, adapter)
                # Let the brain finish + flush its report file, then ingest it.
                await brain.wait()

                report = _read_report(report_path)
            termination = (
                atif.TERMINATION_COMPLETED if report is not None else atif.TERMINATION_NO_REPORT
            )
        finally:
            self._finalize(instruction, report, termination, context, env)

    def _finalize(
        self,
        instruction: str,
        report: "Optional[dict[str, Any]]",
        termination: str,
        context: Any,
        env: "dict[str, str]",
    ) -> None:
        """Emit the ATIF trajectory + the context receipt. Never raises.

        Called from ``run``'s ``finally``, so raising here would mask the real
        failure of a crashed trial. ATIF problems are recorded as promotability
        reasons instead — the trial's reward is real either way, only the
        submission is blocked."""
        self._atif_errors = []
        try:
            payload = atif.build_trajectory_payload(
                instruction=instruction,
                report=report,
                agent_name=self.name(),
                agent_version=self._version.raw,
                termination=termination,
                model=self._model,
                reasoning_effort=self._reasoning_effort,
                reasoning_effort_wire_honored=self.reasoning_effort_wire_honored,
                session_id=getattr(self, "session_id", None),
                secret_values=atif.secret_values_from_env(env),
                extra={"quanta_agent": self.agent_info_receipt()},
            )
            logs_dir = getattr(self, "logs_dir", None)
            if logs_dir is None:
                self._atif_errors = ["no logs_dir: harbor did not supply one"]
            else:
                atif.write_trajectory(logs_dir, payload)
        except atif.AtifValidationError as exc:
            self._atif_errors = list(exc.errors)
        except Exception as exc:  # noqa: BLE001 — telemetry must not kill a trial
            self._atif_errors = ["{0}: {1}".format(type(exc).__name__, exc)]

        provenance = self.agent_info_receipt()
        provenance["termination"] = termination
        provenance["promotability"] = self.promotability()
        if self._atif_errors:
            provenance["atif_errors"] = self._atif_errors
        try:
            _apply_report_to_context(report, context, provenance, env)
        except Exception:  # noqa: BLE001 — a fake/partial context must not kill a trial
            pass


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
