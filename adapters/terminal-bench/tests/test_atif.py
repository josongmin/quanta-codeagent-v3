"""TB21-02 RED rails — the ATIF trajectory.

The pinned Harbor (0.21.0) contract, read out of the installed package:

* ``harbor.agents.base.BaseAgent.SUPPORTS_ATIF`` declares ATIF support;
* ``harbor.upload.uploader`` uploads ``<trial_dir>/agent/trajectory.json`` as the
  Hub ``trajectory_path`` — and ``<trial_dir>/agent`` *is* the agent's
  ``logs_dir``. So the whole contract is "write ATIF to
  ``self.logs_dir / 'trajectory.json'``";
* the upstream leaderboard's static analysis fails any *rewarded* trial with no
  ``trajectory_path`` ("agents that only upload custom logs fail here").

``AgentContext`` has **no** trajectory slot in 0.21.0 — writing the file is the
only channel.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import quanta_agent  # noqa: E402
import quanta_terminal_atif as atif  # noqa: E402
from quanta_agent import QuantaAgent  # noqa: E402
from quanta_terminal_bridge import ExecResult  # noqa: E402

CLEAN_VERSION = "1.0.025+g9d5369d310bb"

SENTINEL = "sk-SENTINEL-DO-NOT-LEAK"


class FakeEnv:
    def __init__(self):
        self.calls = []

    async def exec(self, command):
        self.calls.append(command)
        return ExecResult(stdout="", stderr="", return_code=0)


class FakeContext:
    def __init__(self):
        self.n_input_tokens = None
        self.n_cache_tokens = None
        self.n_output_tokens = None
        self.cost_usd = None
        self.rollout_details = None
        self.metadata = None


class FakeBrain:
    def __init__(self, report_path, payload):
        self._report_path = Path(report_path)
        self._payload = payload

    async def stdout_lines(self):
        return
        yield  # pragma: no cover

    async def stdin_write(self, line):  # pragma: no cover
        pass

    async def wait(self):
        if self._payload is not None:
            self._report_path.write_text(json.dumps(self._payload))


def _patch_spawn(monkeypatch, payload):
    async def fake_spawn(argv, env, report_path):
        return FakeBrain(report_path, payload)

    monkeypatch.setattr(quanta_agent, "_spawn_brain", fake_spawn)


def _agent(tmp_path, **kwargs):
    extra_env = dict(kwargs.pop("extra_env", None) or {})
    extra_env.setdefault(quanta_agent.AGENT_VERSION_ENV, CLEAN_VERSION)
    return QuantaAgent(logs_dir=tmp_path, extra_env=extra_env, **kwargs)


_ORDERED_REPORT = {
    "instruction": "build the thing",
    "turns": 3,
    "tokens": {"input": 1200, "output": 340},
    "cost_usd": 0.0512,
    "final": "done",
    "verification": {"verdict": "verified-pass"},
    "selfTest": {"authored": True, "green": True},
    "oracleLoop": {"rounds": 1, "converged": True},
    "trajectory": [
        {"kind": "text", "text": "first I will look around"},
        {"kind": "exec", "cmd": "ls -la", "ok": True, "exitCode": 0, "preview": "a.txt"},
        {"kind": "text", "text": "now I will build"},
        {"kind": "exec", "cmd": "make", "ok": False, "exitCode": 2, "preview": "error"},
        {"kind": "pty", "cmd": "vim x", "ok": True, "exitCode": 0, "preview": "opened"},
        {"kind": "tool", "cmd": "write_file", "ok": True, "exitCode": 0, "preview": "wrote"},
    ],
}


def _run(tmp_path, monkeypatch, payload=_ORDERED_REPORT, **kwargs):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    _patch_spawn(monkeypatch, payload)
    ctx = FakeContext()
    agent = _agent(tmp_path, **kwargs)
    asyncio.run(agent.run(_ORDERED_REPORT["instruction"], FakeEnv(), ctx))
    return agent, ctx, json.loads((tmp_path / atif.ATIF_FILENAME).read_text())


# ── the file contract ────────────────────────────────────────────────────────


def test_atif_is_written_to_logs_dir_trajectory_json(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    assert (tmp_path / "trajectory.json").exists()
    assert traj["schema_version"].startswith("ATIF-v1.")


def test_agent_declares_atif_support_to_harbor(tmp_path):
    assert QuantaAgent.SUPPORTS_ATIF is True


def test_agent_block_carries_name_version_and_model(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch, model="gpt-5.5", reasoning_effort="high")
    assert traj["agent"]["name"] == "quanta"
    assert traj["agent"]["version"] == CLEAN_VERSION
    assert traj["agent"]["model_name"] == "gpt-5.5"
    assert traj["agent"]["extra"]["reasoning_effort"] == "high"


# ── ordering / fidelity ──────────────────────────────────────────────────────


def test_event_order_survives_brain_to_adapter_to_atif(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    steps = traj["steps"]
    # step_ids are sequential from 1 (ATIF hard-validates this).
    assert [s["step_id"] for s in steps] == list(range(1, len(steps) + 1))
    # The instruction is step 1 and it is a `user` step.
    assert steps[0]["source"] == "user"
    assert steps[0]["message"] == "build the thing"
    # The brain's ordered cassette follows, in the SAME order.
    observed = []
    for step in steps[1:]:
        for call in step.get("tool_calls") or []:
            observed.append(call["arguments"].get("command") or call["arguments"].get("data") or call["function_name"])
        if not step.get("tool_calls") and step["source"] == "agent":
            observed.append(step["message"])
    assert observed[:6] == [
        "first I will look around",
        "ls -la",
        "now I will build",
        "make",
        "vim x",
        "write_file",
    ]


def test_tool_name_arguments_and_exit_state_are_preserved(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    calls = [
        (s["tool_calls"][0], s["observation"]["results"][0])
        for s in traj["steps"]
        if s.get("tool_calls")
    ]
    names = [c["function_name"] for c, _ in calls]
    assert names == ["container_exec", "container_exec", "pty", "write_file"]
    make_call, make_result = calls[1]
    assert make_call["arguments"] == {"command": "make"}
    assert make_result["source_call_id"] == make_call["tool_call_id"]
    assert make_result["extra"]["exit_code"] == 2
    assert make_result["extra"]["ok"] is False
    assert make_result["content"] == "error"


def test_no_synthetic_reasoning_text_is_invented(tmp_path, monkeypatch):
    """The brain does not emit model reasoning; ATIF must not fabricate any."""
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    assert all("reasoning_content" not in s for s in traj["steps"])


def test_final_metrics_carry_tokens_and_cost(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    metrics = traj["final_metrics"]
    assert metrics["total_prompt_tokens"] == 1200
    assert metrics["total_completion_tokens"] == 340
    assert metrics["total_cost_usd"] == 0.0512
    assert metrics["total_steps"] == len(traj["steps"])


def test_termination_status_is_recorded(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    assert traj["extra"]["termination"] == "completed"


# ── exclusions ───────────────────────────────────────────────────────────────


def test_secret_sentinels_never_appear_in_serialized_atif(tmp_path, monkeypatch):
    payload = json.loads(json.dumps(_ORDERED_REPORT))
    payload["trajectory"][1]["cmd"] = "curl -H 'Authorization: Bearer %s' https://x" % SENTINEL
    payload["trajectory"][3]["preview"] = "failed with token %s" % SENTINEL
    payload["trajectory"][2]["text"] = "I will use %s" % SENTINEL
    payload["final"] = "used %s" % SENTINEL

    _agentobj, _ctx, traj = _run(
        tmp_path,
        monkeypatch,
        payload=payload,
        extra_env={"OPENAI_API_KEY": SENTINEL},
    )
    serialized = (tmp_path / atif.ATIF_FILENAME).read_text()
    assert SENTINEL not in serialized
    # The redaction is VISIBLE (an auditor can see which credential was elided),
    # not a silent drop that would hide tampering.
    assert "[redacted:OPENAI_API_KEY]" in serialized
    assert json.dumps(traj).count(SENTINEL) == 0


@pytest.mark.parametrize(
    "env_name",
    [
        "ANTHROPIC_API_KEY",  # explicit name
        "HARBOR_API_KEY",  # explicit name
        "SOMEVENDOR_TOKEN",  # suffix rule only
        "AWS_SECRET_ACCESS_KEY",  # suffix rule only
        "DB_PASSWORD",  # suffix rule only
        "SIGNING_SECRET",  # suffix rule only
    ],
)
def test_secret_named_env_values_are_scrubbed_by_name_convention(
    tmp_path, monkeypatch, env_name
):
    """Redaction is driven by the env var NAME (explicit set + suffix rule), never
    by guessing at a value's shape. Every name in that rule must actually scrub."""
    marker = "VALUE-OF-%s" % env_name
    payload = json.loads(json.dumps(_ORDERED_REPORT))
    payload["trajectory"][1]["cmd"] = "echo %s" % marker
    _agentobj, _ctx, _traj = _run(
        tmp_path, monkeypatch, payload=payload, extra_env={env_name: marker}
    )
    serialized = (tmp_path / atif.ATIF_FILENAME).read_text()
    assert marker not in serialized
    assert "[redacted:%s]" % env_name in serialized


def test_non_secret_named_env_values_are_left_alone(tmp_path, monkeypatch):
    """Paired control: the rule must not redact everything indiscriminately, or
    the test above would pass for a scrubber that eats all output."""
    payload = json.loads(json.dumps(_ORDERED_REPORT))
    payload["trajectory"][1]["cmd"] = "echo build-id-12345"
    _agentobj, _ctx, _traj = _run(
        tmp_path, monkeypatch, payload=payload, extra_env={"QUANTA_TB_BUILD_ID": "build-id-12345"}
    )
    serialized = (tmp_path / atif.ATIF_FILENAME).read_text()
    assert "echo build-id-12345" in serialized


def test_environment_values_are_never_serialized(tmp_path, monkeypatch):
    monkeypatch.setenv("QUANTA_TB_UNRELATED_HOST_VALUE", "host-only-marker")
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch)
    assert "host-only-marker" not in json.dumps(traj)


def test_unbounded_tool_stdout_is_bounded(tmp_path, monkeypatch):
    payload = json.loads(json.dumps(_ORDERED_REPORT))
    payload["trajectory"][1]["preview"] = "x" * 100_000
    payload["trajectory"][1]["cmd"] = "y" * 100_000
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch, payload=payload)
    serialized = json.dumps(traj)
    assert "x" * 100_000 not in serialized
    assert "y" * 100_000 not in serialized
    for step in traj["steps"]:
        for call in step.get("tool_calls") or []:
            for value in call["arguments"].values():
                assert len(value) <= atif.FIELD_CHAR_CAP
        for result in (step.get("observation") or {}).get("results", []):
            if isinstance(result.get("content"), str):
                assert len(result["content"]) <= atif.FIELD_CHAR_CAP


def test_step_count_is_bounded(tmp_path, monkeypatch):
    payload = json.loads(json.dumps(_ORDERED_REPORT))
    payload["trajectory"] = [
        {"kind": "exec", "cmd": "echo %d" % i, "ok": True, "exitCode": 0} for i in range(5_000)
    ]
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch, payload=payload)
    # LITERAL bound, not `atif.MAX_STEPS` — asserting against the constant under
    # test would pass for any value of it, including "no bound at all".
    assert len(traj["steps"]) <= 200
    assert len(traj["steps"]) <= atif.MAX_STEPS
    # A truncated document must say so at the root, per the ATIF total_steps rule.
    assert "truncated" in (traj.get("notes") or "")


def test_adapter_bounds_mirror_the_brains_own_cassette_bounds():
    """Cross-language SSOT pin.

    The adapter's caps exist to bound a brain that did NOT bound itself; if the
    brain widens its cassette and the adapter silently keeps the old cap (or vice
    versa) the two drift and a trajectory is quietly clipped. Pin both ends to the
    brain's declared constants, the same way `protocol-golden.json` pins the wire.
    """
    brain = (
        Path(__file__).resolve().parents[3] / "src" / "apps" / "terminal" / "brain-mode.ts"
    )
    if not brain.exists():  # pragma: no cover — adapter vendored outside the repo
        pytest.skip("brain-mode.ts not reachable from this checkout")
    source = brain.read_text()
    import re

    def _const(name):
        match = re.search(r"^const %s = (\d+)$" % name, source, re.MULTILINE)
        assert match is not None, "%s not found in brain-mode.ts" % name
        return int(match.group(1))

    assert atif.MAX_STEPS == _const("TRAJECTORY_MAX_STEPS")
    assert atif.FIELD_CHAR_CAP == _const("TRAJECTORY_PREVIEW_MAX")


# ── failure / timeout receipts ───────────────────────────────────────────────


def test_missing_report_still_produces_a_bounded_terminal_receipt(tmp_path, monkeypatch):
    _agentobj, _ctx, traj = _run(tmp_path, monkeypatch, payload=None)
    assert len(traj["steps"]) >= 1
    assert traj["extra"]["termination"] == "no_report"
    assert traj["agent"]["version"] == CLEAN_VERSION


def test_crashing_run_still_produces_a_terminal_receipt(tmp_path, monkeypatch):
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)

    async def exploding_spawn(argv, env, report_path):
        raise RuntimeError("brain died")

    monkeypatch.setattr(quanta_agent, "_spawn_brain", exploding_spawn)
    agent = _agent(tmp_path)
    with pytest.raises(RuntimeError):
        asyncio.run(agent.run("x", FakeEnv(), FakeContext()))

    traj = json.loads((tmp_path / atif.ATIF_FILENAME).read_text())
    assert traj["extra"]["termination"] == "error"
    assert len(traj["steps"]) >= 1


def test_successful_trial_without_atif_fails_promotability(tmp_path, monkeypatch):
    """The upstream rail: a rewarded trial with no ATIF cannot be submitted."""
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    _patch_spawn(monkeypatch, _ORDERED_REPORT)
    agent = _agent(tmp_path)
    asyncio.run(agent.run("x", FakeEnv(), FakeContext()))
    assert agent.promotability()["promotable"] is True

    (tmp_path / atif.ATIF_FILENAME).unlink()
    receipt = agent.promotability()
    assert receipt["promotable"] is False
    assert "missing-atif-trajectory" in receipt["reasons"]


# ── quanta's own receipts are NOT replaced by ATIF ───────────────────────────


def test_quanta_typed_receipts_remain_in_context_metadata(tmp_path, monkeypatch):
    _agentobj, ctx, _traj = _run(tmp_path, monkeypatch)
    assert ctx.metadata["verification"] == {"verdict": "verified-pass"}
    assert ctx.metadata["selfTest"] == {"authored": True, "green": True}
    assert ctx.metadata["oracleLoop"] == {"rounds": 1, "converged": True}


def test_context_records_the_atif_path(tmp_path, monkeypatch):
    _agentobj, ctx, _traj = _run(tmp_path, monkeypatch)
    assert ctx.metadata["quanta_agent"]["atif_trajectory"] == atif.ATIF_FILENAME


# ── validation against harbor's OFFICIAL models (skips without harbor) ───────


def test_payload_validates_against_harbor_official_atif_models(tmp_path, monkeypatch):
    pytest.importorskip(
        "harbor",
        reason="harbor is the pinned optional extra; run under "
        "`uv run --project adapters/terminal-bench pytest` to exercise this rail",
    )
    from harbor.utils.trajectory_validator import TrajectoryValidator

    _agentobj, _ctx, _traj = _run(tmp_path, monkeypatch, model="gpt-5.5", reasoning_effort="high")
    validator = TrajectoryValidator()
    ok = validator.validate(tmp_path / atif.ATIF_FILENAME)
    assert ok, validator.get_errors()


def test_terminal_receipt_also_validates_against_harbor(tmp_path, monkeypatch):
    pytest.importorskip("harbor")
    from harbor.utils.trajectory_validator import TrajectoryValidator

    _agentobj, _ctx, _traj = _run(tmp_path, monkeypatch, payload=None)
    validator = TrajectoryValidator()
    ok = validator.validate(tmp_path / atif.ATIF_FILENAME)
    assert ok, validator.get_errors()


def test_strict_validation_is_wired_and_blocks_promotion(tmp_path, monkeypatch):
    """Proof that `write_trajectory` really runs harbor's validator on the box
    path — inject a field ATIF forbids and require it to surface as a
    promotability failure rather than a silently-shipped bad artifact."""
    pytest.importorskip("harbor")
    real_build = atif.build_trajectory_payload

    def poisoned(**kwargs):
        payload = real_build(**kwargs)
        payload["not_an_atif_field"] = True
        return payload

    monkeypatch.setattr(atif, "build_trajectory_payload", poisoned)
    monkeypatch.delenv(quanta_agent.AGENT_VERSION_ENV, raising=False)
    _patch_spawn(monkeypatch, _ORDERED_REPORT)
    subject = _agent(tmp_path)
    asyncio.run(subject.run("x", FakeEnv(), FakeContext()))

    receipt = subject.promotability()
    assert receipt["promotable"] is False
    assert "invalid-atif-trajectory" in receipt["reasons"]
    # The artifact is still on disk for inspection, not silently dropped.
    assert (tmp_path / atif.ATIF_FILENAME).exists()


def test_validator_actually_has_teeth(tmp_path):
    """Anti-vacuity: prove the harbor validator rejects a broken payload, so the
    two green assertions above are not validating a permissive no-op."""
    pytest.importorskip("harbor")
    from harbor.utils.trajectory_validator import TrajectoryValidator

    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps({"schema_version": "ATIF-v1.7", "steps": []}))
    validator = TrajectoryValidator()
    assert validator.validate(broken) is False
    assert validator.get_errors()
