"""TB21-02 RED rails — agent version identity and reasoning effort.

Two defects this pins:

* ``QuantaAgent.version()`` returned ``None``, so every Harbor receipt recorded
  the agent as ``"unknown"`` (``BaseAgent.to_agent_info`` does
  ``self.version() or "unknown"``) and the leaderboard's submission key
  ``(agent, agent_version, model, reasoning_effort)`` had no provenance.
* Harbor's official ``--ak reasoning_effort=...`` was not a proven owner of
  ``QUANTA_REASONING_EFFORT`` in the brain subprocess.

Everything here runs with NO harbor, NO Docker and NO subprocess: the brain
spawn is injected through the module-level ``_spawn_brain`` seam.
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

CLEAN_VERSION = "1.0.025+g9d5369d310bb"
DIRTY_VERSION = "1.0.025+g9d5369d310bb.dirty"


class FakeEnv:
    def __init__(self, result=None):
        self._result = result or ExecResult(stdout="", stderr="", return_code=0)
        self.calls = []

    async def exec(self, command):
        self.calls.append(command)
        return self._result


class FakeContext:
    def __init__(self):
        self.n_input_tokens = None
        self.n_cache_tokens = None
        self.n_output_tokens = None
        self.cost_usd = None
        self.rollout_details = None
        self.metadata = None


class FakeBrain:
    def __init__(self, report_path, report_payload):
        self._report_path = Path(report_path)
        self._payload = report_payload
        self.stdin_received = []

    async def stdout_lines(self):
        return
        yield  # pragma: no cover — makes this an async generator

    async def stdin_write(self, line):
        self.stdin_received.append(line)

    async def wait(self):
        self._report_path.write_text(json.dumps(self._payload))


def _patch_spawn(monkeypatch, captured, report_payload=None):
    async def fake_spawn(argv, env, report_path):
        captured["argv"] = argv
        captured["env"] = env
        captured["spawned"] = captured.get("spawned", 0) + 1
        return FakeBrain(report_path, report_payload or {"final": "ok"})

    monkeypatch.setattr(quanta_agent, "_spawn_brain", fake_spawn)


def _explode_spawn(monkeypatch, captured):
    async def fake_spawn(argv, env, report_path):  # pragma: no cover — must never run
        captured["spawned"] = True
        raise AssertionError("_spawn_brain must not be reached")

    monkeypatch.setattr(quanta_agent, "_spawn_brain", fake_spawn)


def _agent(tmp_path, version=CLEAN_VERSION, **kwargs):
    extra_env = dict(kwargs.pop("extra_env", None) or {})
    if version is not None:
        extra_env.setdefault(quanta_agent.AGENT_VERSION_ENV, version)
    return QuantaAgent(logs_dir=tmp_path, extra_env=extra_env, **kwargs)


# ── version identity ─────────────────────────────────────────────────────────


def test_version_is_never_none(tmp_path, monkeypatch):
    """AP-4: the literal defect — `version()` returned `None`."""
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    agent = _agent(tmp_path)
    assert agent.version() is not None
    assert agent.version() == CLEAN_VERSION


def test_absent_injected_version_fails_construction(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    with pytest.raises(RuntimeError) as excinfo:
        QuantaAgent(logs_dir=tmp_path)
    assert quanta_agent.AGENT_VERSION_ENV in str(excinfo.value)


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "1.0.025",  # no SHA at all
        "9d5369d310bb",  # bare SHA, no package version
        "1.0.025+gZZZZZZZ",  # not hex
        "1.0.025+g9d5",  # too short to identify a commit
        "1.0.025+g9d5369d310bb.wip",  # unknown suffix
        "1.0.025+g9d5369d310bb-dirty",  # wrong dirty spelling
    ],
)
def test_malformed_injected_version_fails_construction(tmp_path, monkeypatch, bad):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    with pytest.raises(ValueError):
        QuantaAgent(logs_dir=tmp_path, extra_env={quanta_agent.AGENT_VERSION_ENV: bad})


def test_dirty_version_never_presents_as_the_clean_sha(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    agent = _agent(tmp_path, version=DIRTY_VERSION)
    assert agent.version() == DIRTY_VERSION
    assert agent.version() != CLEAN_VERSION
    assert agent.version().endswith(".dirty")


def test_dirty_version_is_not_promotable(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    agent = _agent(tmp_path, version=DIRTY_VERSION)
    receipt = agent.promotability()
    assert receipt["promotable"] is False
    assert "dirty-worktree" in receipt["reasons"]


def test_clean_version_with_no_effort_is_promotable_once_atif_exists(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured)
    agent = _agent(tmp_path)
    # Before a run there is no trajectory, so promotion is blocked on ATIF.
    assert agent.promotability()["promotable"] is False
    assert "missing-atif-trajectory" in agent.promotability()["reasons"]

    asyncio.run(agent.run("do it", FakeEnv(), FakeContext()))
    assert agent.promotability() == {"promotable": True, "reasons": []}


def test_environment_variable_delivery_also_works(tmp_path, monkeypatch):
    """Harbor delivers the value via `--ae`; a plain host export must work too."""
    monkeypatch.setenv(quanta_agent.AGENT_VERSION_ENV, CLEAN_VERSION)
    agent = QuantaAgent(logs_dir=tmp_path)
    assert agent.version() == CLEAN_VERSION


# ── reasoning effort ─────────────────────────────────────────────────────────


def test_reasoning_effort_reaches_the_brain_env_exactly_once(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    monkeypatch.delenv(quanta_agent.REASONING_EFFORT_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured)

    agent = _agent(tmp_path, reasoning_effort="max")
    asyncio.run(agent.run("x", FakeEnv(), FakeContext()))

    brain_env = captured["env"]
    assert brain_env[quanta_agent.REASONING_EFFORT_ENV] == "max"
    # "exactly one value": the env is a dict, so the rail is that no other
    # spelling of the same knob is delivered alongside it.
    effort_keys = [k for k in brain_env if "REASONING_EFFORT" in k]
    assert effort_keys == [quanta_agent.REASONING_EFFORT_ENV]
    # And the argv carries no competing --reasoning-effort flag.
    assert not any("effort" in str(a).lower() for a in captured["argv"])


def test_reasoning_effort_is_normalized(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured)
    agent = _agent(tmp_path, reasoning_effort="  HIGH ")
    assert agent.reasoning_effort == "high"
    asyncio.run(agent.run("x", FakeEnv(), FakeContext()))
    assert captured["env"][quanta_agent.REASONING_EFFORT_ENV] == "high"


@pytest.mark.parametrize("bad", ["ultra", "MAXIMUM", "9", "hi"])
def test_unknown_reasoning_effort_fails_before_spawn_brain(tmp_path, monkeypatch, bad):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _explode_spawn(monkeypatch, captured)
    with pytest.raises(ValueError) as excinfo:
        _agent(tmp_path, reasoning_effort=bad)
    assert bad.strip().lower() in str(excinfo.value).lower()
    assert "spawned" not in captured


def test_absent_reasoning_effort_leaves_the_knob_unset(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    monkeypatch.delenv(quanta_agent.REASONING_EFFORT_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured)
    agent = _agent(tmp_path)
    assert agent.reasoning_effort is None
    asyncio.run(agent.run("x", FakeEnv(), FakeContext()))
    assert quanta_agent.REASONING_EFFORT_ENV not in captured["env"]


def test_effort_harbor_accepts_but_quanta_does_not_wire_blocks_promotion(tmp_path, monkeypatch):
    """`max` / `none` / `default` are legal Harbor efforts, but Quanta's
    Responses wire (`normalizeResponsesReasoningEffort`) drops anything outside
    `minimal|low|medium|high|xhigh`. Reporting `max` on a leaderboard row while
    the provider silently got its own default would be a false receipt."""
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured)
    agent = _agent(tmp_path, reasoning_effort="max")
    asyncio.run(agent.run("x", FakeEnv(), FakeContext()))
    receipt = agent.promotability()
    assert receipt["promotable"] is False
    assert "reasoning-effort-not-wired:max" in receipt["reasons"]


def test_wire_honored_effort_does_not_block_promotion(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured)
    agent = _agent(tmp_path, reasoning_effort="xhigh")
    asyncio.run(agent.run("x", FakeEnv(), FakeContext()))
    assert agent.promotability() == {"promotable": True, "reasons": []}


def test_agent_info_receipt_records_version_effort_and_model(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    agent = _agent(tmp_path, model="gpt-5.5", reasoning_effort="high")
    info = agent.agent_info_receipt()
    assert info["name"] == "quanta"
    assert info["version"] == CLEAN_VERSION
    assert info["reasoning_effort"] == "high"
    assert info["reasoning_effort_wire_honored"] is True
    assert info["model"] == "gpt-5.5"
    assert info["package_version"] == "1.0.025"
    assert info["commit"] == "9d5369d310bb"
    assert info["dirty"] is False


def test_context_metadata_carries_the_provenance_receipt(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _patch_spawn(monkeypatch, captured, report_payload={"final": "ok", "turns": 2})
    ctx = FakeContext()
    agent = _agent(tmp_path, reasoning_effort="high")
    asyncio.run(agent.run("x", FakeEnv(), ctx))

    assert ctx.metadata is not None
    receipt = ctx.metadata["quanta_agent"]
    assert receipt["version"] == CLEAN_VERSION
    assert receipt["reasoning_effort"] == "high"
    # The brain's own typed receipts are NOT replaced by the provenance block.
    assert ctx.metadata["final"] == "ok"
    assert ctx.metadata["turns"] == 2


def test_secret_env_values_never_enter_the_context_metadata(tmp_path, monkeypatch):
    """The brain's report is free-form: it can echo a credential it was handed
    (an error string, a curl it logged). ``metadata`` is uploaded with the trial,
    so the whole report is scrubbed before it lands there."""
    sentinel = "sk-SENTINEL-DO-NOT-LEAK"
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    captured = {}
    _patch_spawn(
        monkeypatch,
        captured,
        report_payload={
            "final": "request failed with key %s" % sentinel,
            "trajectory": [{"kind": "exec", "cmd": "curl -H 'x: %s'" % sentinel}],
            "verification": {"verdict": "unverifiable", "detail": sentinel},
        },
    )
    ctx = FakeContext()
    agent = _agent(tmp_path, extra_env={"OPENAI_API_KEY": sentinel})
    asyncio.run(agent.run("x", FakeEnv(), ctx))

    serialized = json.dumps(ctx.metadata)
    assert sentinel not in serialized
    # Scrubbed, not deleted: the receipts are still there, with a visible marker.
    assert "[redacted:OPENAI_API_KEY]" in serialized
    assert ctx.metadata["verification"]["verdict"] == "unverifiable"
