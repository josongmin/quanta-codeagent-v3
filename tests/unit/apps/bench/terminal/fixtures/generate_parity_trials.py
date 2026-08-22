"""Regenerate `parity-trials-445.json` — the shared input for the TB21-04
scorer-parity differential (upstream Python metrics vs. the Quanta TypeScript
port).

The rows are shaped exactly like the Harbor Hub bulk trial rows the upstream
leaderboard consumes (`leaderboard.core.hub.hub_job_trials` →
`leaderboard.core.metrics.*`): `id`, `task_name`, `reward`, `error_type`,
`started_at`, `finished_at`, `input_tokens`, `cache_tokens`, `output_tokens`,
`cost_usd`.

The task names are the REAL 89 canonical task ids of
`terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…`; the rewards are synthetic
and deterministic (seeded LCG, no randomness at test time). The point of the
fixture is not to reproduce anybody's score — it is to drive every branch of the
upstream calculator (0/partial/1 rewards, k=5 tasks with 0..5 successes, errored
trials with a null reward, disqualified trials, missing telemetry) so the port
can be proven byte-identical against the pinned upstream implementation.

Deterministic: rerunning this script must reproduce the checked-in bytes.

    python3 tests/unit/apps/bench/terminal/fixtures/generate_parity_trials.py
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
TASKS_JSON = (
    HERE.parents[5] / "src" / "apps" / "bench" / "terminal" / "terminal-bench-2-1-tasks.json"
)
OUT = HERE / "parity-trials-445.json"

# Deterministic namespace so trial ids are stable across regenerations.
NS = uuid.UUID("11111111-2222-3333-4444-555555555555")

K = 5
BASE = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)


class Lcg:
    """Numerical Recipes LCG — deterministic and trivially portable."""

    def __init__(self, seed: int) -> None:
        self.state = seed

    def next(self) -> int:
        self.state = (1664525 * self.state + 1013904223) % (2**32)
        return self.state

    def below(self, n: int) -> int:
        return self.next() % n


def main() -> None:
    task_ids = sorted(json.loads(TASKS_JSON.read_text()).keys())
    assert len(task_ids) == 89, len(task_ids)

    rng = Lcg(20260710)
    trials: list[dict] = []
    disqualified: list[str] = []

    for t_index, task_id in enumerate(task_ids):
        # Target success count 0..5 cycles so pass@2..pass@5 sees every shape.
        target = t_index % (K + 1)
        for attempt in range(K):
            tid = str(uuid.uuid5(NS, f"{task_id}#{attempt}"))
            row: dict = {
                "id": tid,
                "task_name": task_id,
                "source": "terminal-bench/terminal-bench-2-1",
                "agent_name": "quanta",
                "agent_version": "3.0.0",
                "model_provider": "openai",
                "model_name": "gpt-5.6-luna",
                "error_type": None,
                "reward": 0,
            }
            flavour = rng.below(24)
            if attempt < target:
                # A success. Every 7th is a partial (0 < reward < 1) so the
                # `reward > 0` rule is exercised, not just the 1.0 case.
                row["reward"] = 0.5 if flavour == 0 else 1
            elif flavour == 1:
                # An errored trial: Harbor records no reward at all.
                row["reward"] = None
                row["error_type"] = "AgentTimeoutError"
            elif flavour == 2:
                row["reward"] = None
                row["error_type"] = "NonZeroAgentExitCodeError"
            else:
                row["reward"] = 0

            started = BASE + timedelta(seconds=rng.below(100_000))
            if flavour == 3:
                # No timestamps at all — excluded from the duration mean.
                row["started_at"] = None
                row["finished_at"] = None
            else:
                row["started_at"] = started.isoformat().replace("+00:00", "Z")
                row["finished_at"] = (
                    started + timedelta(seconds=60 + rng.below(1200))
                ).isoformat().replace("+00:00", "Z")

            if flavour == 4:
                # No telemetry at all — must count as 0, not crash.
                row["input_tokens"] = None
                row["cache_tokens"] = None
                row["output_tokens"] = None
                row["cost_usd"] = None
            else:
                cache = rng.below(3_000_000)
                # Harbor's convention: input_tokens INCLUDES cache tokens.
                row["input_tokens"] = cache + rng.below(120_000)
                if flavour == 5:
                    # An agent reporting them DISJOINT: input < cache, so the
                    # upstream `max(input - cache, 0)` clamp is exercised.
                    row["input_tokens"] = rng.below(50_000)
                row["cache_tokens"] = cache
                row["output_tokens"] = rng.below(90_000)
                row["cost_usd"] = rng.below(900) / 100.0

            if flavour == 6 and attempt < target:
                # A disqualified (reward-hacking) trial: it KEEPS its resource
                # usage but joins the metric as reward 0.
                disqualified.append(tid)

            trials.append(row)

    assert len(trials) == 89 * K, len(trials)
    payload = {
        "_source": (
            "synthetic rewards over the REAL 89 canonical task ids of "
            "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45"
            "e5fd0ea7c4186773687d177ad3a0699a; regenerate with generate_parity_trials.py"
        ),
        "disqualified_trials": [
            {"trial_id": tid, "reason": "reward_hacking"} for tid in disqualified
        ],
        "trials": trials,
    }
    OUT.write_text(json.dumps(payload, indent=1, sort_keys=False) + "\n")
    print(f"{OUT}: {len(trials)} trials, {len(disqualified)} disqualified")


if __name__ == "__main__":
    main()
