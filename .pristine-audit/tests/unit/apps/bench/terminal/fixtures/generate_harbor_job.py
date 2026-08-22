"""Regenerate the on-disk Harbor job fixtures under `harbor-jobs/`.

Every `result.json` is produced by harbor's OWN pydantic models
(`harbor.models.trial.result.TrialResult`), so the bytes the TypeScript scanner
parses are the bytes harbor writes — not a hand-written guess at the schema.
`harbor.trial.trial.Trial` writes exactly this:

    self.paths.result_path.write_text(self.result.model_dump_json(indent=4))
    # harbor/trial/trial.py:419, result_path = trial_dir / "result.json"

Run inside the pinned adapter environment (harbor==0.21.0):

    uv run --project adapters/terminal-bench python3 \
      tests/unit/apps/bench/terminal/fixtures/generate_harbor_job.py

Jobs emitted
------------
`canary-k5/`      3 real canonical tasks x 5 trials: passes, a partial reward,
                  plain failures, an agent timeout, an agent crash, a trial with
                  no reward at all, and one rewarded trial with no ATIF
                  trajectory on disk.
`nonstandard/`    one trial carrying `agent.override_timeout_sec` — the upstream
                  static-analysis "no timeout overrides" rule.
`tb20-legacy/`    one trial whose `source` is the retired 2.0 dataset and whose
                  task carries no `ref` — the versionless artifact that must be
                  quarantined.

Deterministic: trial UUIDs are uuid5-derived, timestamps are fixed.
"""

from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from harbor.models.agent.context import AgentContext
from harbor.models.task.id import PackageTaskId
from harbor.models.trial.config import AgentConfig, TaskConfig, TrialConfig
from harbor.models.trial.result import AgentInfo, ExceptionInfo, ModelInfo, TrialResult
from harbor.models.verifier.result import VerifierResult

HERE = Path(__file__).parent
ROOT = HERE / "harbor-jobs"
TASKS_JSON = (
    HERE.parents[5] / "src" / "apps" / "bench" / "terminal" / "terminal-bench-2-1-tasks.json"
)

DATASET = "terminal-bench/terminal-bench-2-1"
NS = uuid.UUID("66666666-7777-8888-9999-aaaaaaaaaaaa")
BASE = datetime(2026, 8, 20, 9, 0, 0, tzinfo=timezone.utc)
JOB_ID = uuid.UUID("622b427f-0ddc-54db-b64b-90960667e6be")

AGENT = AgentInfo(
    name="quanta",
    version="3.0.0",
    model_info=ModelInfo(name="gpt-5.6-luna", provider="openai"),
)


def quanta_metadata(*, atif_ok: bool, dirty: bool = False) -> dict:
    reasons: list[str] = []
    if dirty:
        reasons.append("dirty-worktree")
    if not atif_ok:
        reasons.append("missing-atif-trajectory")
    receipt = {
        "name": "quanta",
        "version": "3.0.0",
        "package_version": "3.0.0",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "dirty": dirty,
        "model": "gpt-5.6-luna",
        "reasoning_effort": "high",
        "reasoning_effort_wire_honored": True,
        "atif_trajectory": "trajectory.json",
        "termination": "completed",
        "promotability": {"promotable": not reasons, "reasons": reasons},
    }
    return {"quanta_agent": receipt}


def make_trial(
    *,
    task_id: str,
    task_ref: str,
    attempt: int,
    reward: float | int | None,
    exception: str | None = None,
    minutes: int = 7,
    source: str | None = DATASET,
    agent_override_timeout_sec: float | None = None,
    atif_ok: bool = True,
    telemetry: bool = True,
) -> tuple[str, TrialResult]:
    org, name = task_id.split("/", 1)
    trial_name = f"{name}.{attempt}"
    started = BASE + timedelta(minutes=attempt * 11)
    finished = started + timedelta(minutes=minutes)
    config = TrialConfig(
        task=TaskConfig(name=task_id, ref=task_ref or None),
        trial_name=trial_name,
        job_id=JOB_ID,
        agent=AgentConfig(
            name="quanta",
            model_name="openai/gpt-5.6-luna",
            override_timeout_sec=agent_override_timeout_sec,
            kwargs={"reasoning_effort": "high"},
        ),
    )
    result = TrialResult(
        id=uuid.uuid5(NS, f"{task_id}#{attempt}"),
        task_name=task_id,
        trial_name=trial_name,
        trial_uri=f"file://trials/{trial_name}",
        task_id=PackageTaskId(org=org, name=name, ref=task_ref or None),
        source=source,
        task_checksum=(task_ref or "").removeprefix("sha256:"),
        config=config,
        agent_info=AGENT,
        agent_result=(
            AgentContext(
                n_input_tokens=1_200_000 + attempt * 1_000,
                n_cache_tokens=1_100_000,
                n_output_tokens=40_000 + attempt * 7,
                cost_usd=0.83 + attempt / 100,
                metadata=quanta_metadata(atif_ok=atif_ok),
            )
            if telemetry
            else AgentContext(metadata=quanta_metadata(atif_ok=atif_ok))
        ),
        verifier_result=(
            None if reward is None else VerifierResult(rewards={"reward": reward})
        ),
        exception_info=(
            None
            if exception is None
            else ExceptionInfo(
                exception_type=exception,
                exception_message=f"{exception} raised during the trial",
                exception_traceback=f"Traceback (most recent call last):\n  {exception}\n",
                occurred_at=finished,
            )
        ),
        started_at=started,
        finished_at=finished,
    )
    return trial_name, result


def write_trial(job_dir: Path, trial_name: str, result: TrialResult, *, atif: bool) -> None:
    trial_dir = job_dir / trial_name
    (trial_dir / "agent").mkdir(parents=True, exist_ok=True)
    (trial_dir / "verifier").mkdir(parents=True, exist_ok=True)
    # harbor/trial/trial.py:419 — the exact write.
    (trial_dir / "result.json").write_text(result.model_dump_json(indent=4))
    (trial_dir / "config.json").write_text(result.config.model_dump_json(indent=4))
    if result.verifier_result is not None:
        (trial_dir / "verifier" / "reward.json").write_text(
            json.dumps(result.verifier_result.rewards, indent=1)
        )
    if atif:
        (trial_dir / "agent" / "trajectory.json").write_text(
            json.dumps(
                {
                    "schema_version": "ATIF-v1.7",
                    "trial": str(result.id),
                    "steps": [{"type": "text", "content": "fixture"}],
                },
                indent=1,
            )
        )


def main() -> None:
    task_ids = sorted(json.loads(TASKS_JSON.read_text()).keys())
    digests = json.loads(TASKS_JSON.read_text())
    a, b, c = task_ids[0], task_ids[1], task_ids[2]

    if ROOT.exists():
        shutil.rmtree(ROOT)

    # ── canary-k5: 3 tasks x 5 trials ────────────────────────────────────────
    job = ROOT / "canary-k5"
    plan: list[tuple[str, int, float | int | None, str | None, bool]] = [
        # (task, attempt, reward, exception, atif_on_disk)
        (a, 0, 1, None, True),
        (a, 1, 1, None, True),
        (a, 2, 0.5, None, True),
        (a, 3, 0, None, False),
        (a, 4, None, "AgentTimeoutError", False),
        (b, 0, 0, None, False),
        (b, 1, 0, None, False),
        (b, 2, 0, None, False),
        (b, 3, None, "NonZeroAgentExitCodeError", False),
        (b, 4, None, None, False),  # graded but no reward recorded at all
        (c, 0, 1, None, True),
        (c, 1, 1, None, True),
        (c, 2, 1, None, True),
        (c, 3, 1, None, True),
        # A REWARDED trial with no ATIF trajectory on disk: upstream fails the
        # "rewarded trials have trajectories" check, so the run is not promotable.
        (c, 4, 1, None, False),
    ]
    for task_id, attempt, reward, exc, atif in plan:
        name, result = make_trial(
            task_id=task_id,
            task_ref=digests[task_id],
            attempt=attempt,
            reward=reward,
            exception=exc,
            atif_ok=atif,
        )
        write_trial(job, name, result, atif=atif)

    # ── nonstandard: a forbidden agent timeout override ──────────────────────
    name, result = make_trial(
        task_id=a,
        task_ref=digests[a],
        attempt=0,
        reward=1,
        agent_override_timeout_sec=7200.0,
    )
    write_trial(ROOT / "nonstandard", name, result, atif=True)

    # ── tb20-legacy: retired 2.0 dataset, versionless task ───────────────────
    name, result = make_trial(
        task_id=a,
        task_ref="",
        attempt=0,
        reward=1,
        source="terminal-bench/terminal-bench-2-0",
    )
    write_trial(ROOT / "tb20-legacy", name, result, atif=True)

    # Round-trip proof: every emitted file re-validates as a real TrialResult.
    n = 0
    for path in sorted(ROOT.rglob("result.json")):
        TrialResult.model_validate_json(path.read_text())
        n += 1
    print(f"{ROOT}: {n} result.json files, all validated by harbor's TrialResult")


if __name__ == "__main__":
    main()
