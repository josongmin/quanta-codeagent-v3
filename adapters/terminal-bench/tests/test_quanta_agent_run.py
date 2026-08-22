"""
Hellgate coverage for the (otherwise box-only) ``QuantaAgent.run`` / ``setup``
WIRING — proven without harbor, without Docker, without a real subprocess.

``run`` is the one box-activated seam: it spawns the quanta-TS BRAIN as a child
process and bridges its stdio to ``environment.exec`` via the fully-tested
``serve`` loop, then folds the brain's final JSON report into the harbor
``AgentContext``. We can't spawn a real brain in a unit test, so the spawn is
injected through the module-level ``_spawn_brain`` seam: a FAKE brain stands in
for the child, a FAKE environment stands in for the container, and the report is
a plain temp file the fake brain "writes". This pins:

  (a) run() actually drove serve → environment.exec("ls") was called,
  (b) the brain received the matching exec_result frame on its stdin,
  (c) context got the token/cost fields parsed from the report,
  (d) the spawn contract (argv: --instruction-file/--model/--report-out, env
      forwarding) is what the TS brain must match,
  (e) setup() probes the brain and fails loud when it is absent.

Since TB21-02 every construction also needs an injected ``QUANTA_TB_AGENT_VERSION``
(provenance is fail-closed) and a ``logs_dir`` (where the ATIF trajectory lands),
so these tests go through the ``agent`` helper below rather than ``QuantaAgent()``.

NO real subprocess, NO harbor, NO Docker.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import quanta_agent  # noqa: E402
from quanta_agent import QuantaAgent  # noqa: E402
from quanta_terminal_bridge import ExecResult  # noqa: E402

DEV_VERSION = "1.0.025+g9d5369d310bb.dirty"


@pytest.fixture(autouse=True)
def _injected_agent_version(monkeypatch):
    """Every trial carries provenance. A dirty dev value keeps these runs
    explicitly non-promotable, which is exactly what a unit run is."""
    monkeypatch.setenv(quanta_agent.AGENT_VERSION_ENV, DEV_VERSION)


def agent(tmp_path, **kwargs):
    """Construct the agent the way harbor does: logs_dir first, kwargs after."""
    return QuantaAgent(logs_dir=tmp_path, **kwargs)


# ── fakes ────────────────────────────────────────────────────────────────────


class FakeEnv:
    """Container stand-in: records commands, returns a scripted ExecResult."""

    def __init__(self, result):
        self._result = result
        self.calls = []

    async def exec(self, command):
        self.calls.append(command)
        return self._result


class FakeBrain:
    """Stand-in for the spawned quanta-TS child process.

    ``stdout_lines`` yields the brain's outbound frames (what serve reads);
    ``stdin_write`` is the sink for serve's replies (what the brain reads). On
    ``wait`` it writes the report file it was told to (``report_path``), mirroring
    a real brain flushing its final report just before exit.
    """

    def __init__(self, outbound_frames, report_path, report_payload):
        self._outbound = list(outbound_frames)
        self._report_path = Path(report_path)
        self._report_payload = report_payload
        self.stdin_received = []
        self.waited = False

    async def stdout_lines(self):
        for frame in self._outbound:
            yield json.dumps(frame)

    async def stdin_write(self, line):
        self.stdin_received.append(line)

    async def wait(self):
        self.waited = True
        self._report_path.write_text(json.dumps(self._report_payload))


class FakeContext:
    """Harbor AgentContext stand-in exposing the slots run() should populate."""

    def __init__(self):
        # Mirrors the pinned harbor AgentContext slots run() populates.
        self.n_input_tokens = None
        self.n_cache_tokens = None
        self.n_output_tokens = None
        self.cost_usd = None
        self.rollout_details = None  # list[RolloutDetail] — we never set this (typed, not a dict)
        self.metadata = None  # dict[str, Any] — the brain's raw report rides here


# ── run(): the full bridge wiring ────────────────────────────────────────────


def _patch_spawn(monkeypatch, frames, report_payload, captured):
    """Install a fake _spawn_brain that records argv/env and returns a FakeBrain
    bound to the report path the agent chose."""

    async def fake_spawn(argv, env, report_path):
        captured["argv"] = argv
        captured["env"] = env
        captured["report_path"] = report_path
        # Capture the instruction file's contents WHILE the temp dir is still live
        # (run() cleans it up on exit) — mirrors the real brain reading it at spawn.
        if "--instruction-file" in argv:
            ipath = argv[argv.index("--instruction-file") + 1]
            captured["instruction_text"] = Path(ipath).read_text()
        brain = FakeBrain(frames, report_path, report_payload)
        captured["brain"] = brain
        return brain

    monkeypatch.setattr(quanta_agent, "_spawn_brain", fake_spawn)


def test_run_drives_serve_calls_env_exec_and_replies_to_brain(tmp_path, monkeypatch):
    env = FakeEnv(ExecResult(stdout="a.txt\nb.txt", stderr="", return_code=0))
    ctx = FakeContext()
    captured = {}
    report = {
        "instruction": "do the thing",
        "turns": 4,
        "tokens": {"input": 111, "output": 222},
        "cost_usd": 0.0042,
        "final": "done",
    }
    _patch_spawn(
        monkeypatch,
        frames=[{"id": 0, "type": "exec", "command": "ls"}],
        report_payload=report,
        captured=captured,
    )

    asyncio.run(agent(tmp_path).run("do the thing", env, ctx))

    # (a) serve actually ran the brain's exec against the environment.
    assert env.calls == ["ls"]
    # (b) the brain got the matching exec_result frame back on its stdin.
    brain = captured["brain"]
    assert len(brain.stdin_received) == 1
    reply = json.loads(brain.stdin_received[0])
    assert reply == {
        "id": 0,
        "type": "exec_result",
        "stdout": "a.txt\nb.txt",
        "stderr": "",
        "code": 0,
    }
    # (c) context got token/cost slots from the report.
    assert ctx.n_input_tokens == 111
    assert ctx.n_output_tokens == 222
    assert ctx.cost_usd == 0.0042
    # (d) the (secret-scrubbed) report rides metadata (dict-typed); rollout_details
    #     (list[RolloutDetail]) stays None.
    assert ctx.metadata is not None and ctx.metadata.get("cost_usd") == 0.0042
    assert ctx.rollout_details is None
    assert brain.waited is True


def test_run_spawn_contract_argv_and_instruction_file(tmp_path, monkeypatch):
    env = FakeEnv(ExecResult(stdout="", stderr="", return_code=0))
    ctx = FakeContext()
    captured = {}
    _patch_spawn(
        monkeypatch,
        frames=[],  # brain does nothing, just exits
        report_payload={"tokens": {"input": 1, "output": 2}, "cost_usd": 0.0},
        captured=captured,
    )
    monkeypatch.setenv("QUANTA_TERMINAL_BRAIN_CMD", "my-brain")

    asyncio.run(agent(tmp_path, model="gpt-5").run("hello instruction", env, ctx))

    argv = captured["argv"]
    assert argv[0] == "my-brain"  # configurable executable honored
    # --instruction-file held the instruction verbatim while the brain was live
    assert captured["instruction_text"] == "hello instruction"
    # --model forwarded, --report-out matches the path the spawner was handed
    assert _flag_value(argv, "--model") == "gpt-5"
    assert _flag_value(argv, "--report-out") == captured["report_path"]
    # creds are forwarded via env (parent env at minimum)
    assert isinstance(captured["env"], dict)


def test_agent_env_overlays_into_brain_env(tmp_path, monkeypatch):
    """review P0: `--agent-env` (delivered by harbor as the ``extra_env`` kwarg) must reach the brain
    subprocess env, so `--agent-env QUANTA_TB_ENV_OWNED=1` flips the knob — not only a host export."""
    monkeypatch.delenv("QUANTA_TB_ENV_OWNED", raising=False)
    monkeypatch.delenv("QUANTA_TB_VERIFY_GATE", raising=False)
    env = FakeEnv(ExecResult(stdout="", stderr="", return_code=0))
    ctx = FakeContext()
    captured = {}
    _patch_spawn(monkeypatch, frames=[], report_payload={"final": "x"}, captured=captured)

    subject = agent(tmp_path, extra_env={"QUANTA_TB_ENV_OWNED": "1", "QUANTA_TB_VERIFY_GATE": "1"})
    asyncio.run(subject.run("x", env, ctx))

    brain_env = captured["env"]
    assert brain_env["QUANTA_TB_ENV_OWNED"] == "1"  # the knob reaches the brain via --agent-env
    assert brain_env["QUANTA_TB_VERIFY_GATE"] == "1"
    assert "PATH" in brain_env  # host env still forwarded (os.environ base preserved)


def test_agent_env_overlay_wins_over_host_and_drives_brain_cmd_and_model(tmp_path, monkeypatch):
    """extra_env OVERLAYS os.environ (extra wins) and is the single source for brain-cmd + model."""
    monkeypatch.setenv("QUANTA_TERMINAL_BRAIN_CMD", "host-brain")  # host value…
    monkeypatch.delenv("QUANTA_TERMINAL_MODEL", raising=False)
    env = FakeEnv(ExecResult(stdout="", stderr="", return_code=0))
    ctx = FakeContext()
    captured = {}
    _patch_spawn(monkeypatch, frames=[], report_payload={"final": "x"}, captured=captured)

    subject = agent(
        tmp_path,
        extra_env={"QUANTA_TERMINAL_BRAIN_CMD": "agent-env-brain", "QUANTA_TERMINAL_MODEL": "gpt-5.5"},
    )
    asyncio.run(subject.run("x", env, ctx))

    assert captured["argv"][0] == "agent-env-brain"  # --agent-env overrides the host brain cmd
    assert _flag_value(captured["argv"], "--model") == "gpt-5.5"  # model resolved from merged env


def test_run_tolerates_missing_report_fields(tmp_path, monkeypatch):
    """A thin/partial report must degrade gracefully, never crash the box run."""
    env = FakeEnv(ExecResult(stdout="", stderr="", return_code=0))
    ctx = FakeContext()
    captured = {}
    _patch_spawn(
        monkeypatch,
        frames=[],
        report_payload={"final": "done"},  # no tokens / cost
        captured=captured,
    )
    # Must not raise even with a field-poor report.
    asyncio.run(agent(tmp_path).run("x", env, ctx))
    assert ctx.n_input_tokens is None  # untouched, not crashed


def test_run_tolerates_malformed_tokens_field(tmp_path, monkeypatch):
    """A non-dict ``tokens`` (garbled brain report) must not crash teardown."""
    env = FakeEnv(ExecResult(stdout="", stderr="", return_code=0))
    ctx = FakeContext()
    captured = {}
    _patch_spawn(
        monkeypatch,
        frames=[],
        report_payload={"tokens": 5, "cost_usd": 0.01},  # tokens is an int, not a dict
        captured=captured,
    )
    asyncio.run(agent(tmp_path).run("x", env, ctx))
    assert ctx.n_input_tokens is None  # no token slots set
    assert ctx.cost_usd == 0.01  # but cost still applied


def _flag_value(argv, flag):
    i = argv.index(flag)
    return argv[i + 1]


# ── setup(): brain presence probe ────────────────────────────────────────────


class ProbeEnv:
    """Env whose exec returns a scripted code for the brain --version probe."""

    def __init__(self, version_code):
        self._code = version_code
        self.calls = []

    async def exec(self, command):
        self.calls.append(command)
        return ExecResult(stdout="quanta-brain 0.1", stderr="", return_code=self._code)


def test_setup_passes_when_brain_present(tmp_path, monkeypatch):
    # The brain is HOST-side (run() spawns it as a subprocess), so setup() probes the host via
    # _probe_brain_version — NOT environment.exec. A present brain ⇒ (0, "") ⇒ no raise.
    seen = {}

    async def fake_probe(brain, env):
        seen["brain"] = brain
        return 0, ""

    monkeypatch.setattr(quanta_agent, "_probe_brain_version", fake_probe)
    asyncio.run(agent(tmp_path).setup(ProbeEnv(version_code=0)))
    assert seen["brain"]  # the host probe ran against the resolved brain cmd


def test_setup_raises_when_brain_absent(tmp_path, monkeypatch):
    async def fake_probe(brain, env):
        return 127, "command not found"  # host PATH miss

    monkeypatch.setattr(quanta_agent, "_probe_brain_version", fake_probe)
    try:
        asyncio.run(agent(tmp_path).setup(ProbeEnv(version_code=127)))
    except RuntimeError as e:
        assert "brain" in str(e).lower()
    else:  # pragma: no cover
        raise AssertionError("setup() must raise when the brain is not runnable")
