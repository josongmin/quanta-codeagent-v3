"""Run the PINNED upstream Terminal-Bench 2.1 leaderboard calculator verbatim.

This is the differential oracle for `src/apps/bench/terminal/scoring.ts`: the
TypeScript port is proven equal to the real upstream implementation by feeding
both the same trial rows and comparing every field.

Authority
---------
`upstream_metrics.py` in this directory is a byte-verbatim copy of

    https://github.com/harbor-framework/terminal-bench-2-1
      leaderboard/src/leaderboard/core/metrics.py
    commit 7131e4375048a0e408a8fb404b5f499d726b695b   (Apache-2.0)
    sha256 b51790e92003a396f6de916d8c65ca8fd4b2c06c63c60af1899b02ab7c8c466a

The hash is re-checked on every run, so the oracle cannot silently drift into
"whatever we edited it into".

Its only non-pure import (`leaderboard.core.hub.submission_trials`, used by
`compute_submission_metrics`, which fetches from the Harbor Hub) is stubbed
before load. Every function this driver calls is pure.

Protocol: a submission-shaped payload `{trials, disqualified_trials}` on stdin,
the computed metric record as JSON on stdout.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

HERE = Path(__file__).parent
UPSTREAM = HERE / "upstream_metrics.py"
UPSTREAM_SHA256 = "b51790e92003a396f6de916d8c65ca8fd4b2c06c63c60af1899b02ab7c8c466a"
UPSTREAM_COMMIT = "7131e4375048a0e408a8fb404b5f499d726b695b"


def load_upstream() -> types.ModuleType:
    raw = UPSTREAM.read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != UPSTREAM_SHA256:
        raise SystemExit(
            f"upstream_metrics.py is NOT the pinned upstream file.\n"
            f"  expected sha256 {UPSTREAM_SHA256}\n"
            f"  actual   sha256 {actual}\n"
            f"Restore it from {UPSTREAM_COMMIT}; never hand-edit the oracle."
        )

    # metrics.py imports `leaderboard.core.hub.submission_trials` at module
    # scope. That is the ONE impure entry point (it hits the Harbor Hub) and
    # nothing this driver calls uses it, so stub the package it lives in.
    for name in ("leaderboard", "leaderboard.core", "leaderboard.core.hub"):
        module = types.ModuleType(name)
        sys.modules[name] = module
    sys.modules["leaderboard.core.hub"].submission_trials = None  # type: ignore[attr-defined]

    spec = importlib.util.spec_from_file_location("upstream_metrics", UPSTREAM)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    m = load_upstream()
    payload = json.load(sys.stdin)
    trials = payload["trials"]
    submission = {"disqualified_trials": payload.get("disqualified_trials") or []}

    by_task, n_disq_joined = m.submission_by_task(trials, submission)
    accuracy, stderr = m.compute_metrics(by_task)
    n_trials = len(trials)
    n_disq = len(submission["disqualified_trials"])
    hack_pct = m._hack_rate_pct(n_disq, n_trials)

    record = {
        "accuracy": round(accuracy, 2),
        "accuracy_stderr": round(stderr, 2),
        "display_accuracy": f"**{accuracy:.1f}%** ± {stderr:.1f}%",
        "n_trials": n_trials,
        **m.compute_pass_at_k(by_task),
        **m.compute_resource_metrics(trials),
        "avg_trial_duration_sec": m.compute_avg_duration_sec(trials),
        "reward_hacks": hack_pct,
    }
    tokens_cell, cost_cell = m.format_resource_cells(record)
    json.dump(
        {
            **record,
            "n_disqualified_joined": n_disq_joined,
            "n_tasks": len(by_task),
            "display_hack_rate": m.format_hack_rate(hack_pct),
            "display_tokens_cell": tokens_cell,
            "display_cost_cell": cost_cell,
            # Raw (unrounded) values, so the port's rounding can be proven
            # rather than accidentally matched.
            "raw_accuracy": accuracy,
            "raw_accuracy_stderr": stderr,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
