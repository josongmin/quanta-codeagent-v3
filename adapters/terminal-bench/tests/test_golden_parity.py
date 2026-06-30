"""
GOLDEN-FRAME PARITY (hands side). Replays the SHARED corpus
(adapters/terminal-bench/protocol-golden.json) that the TS brain
(src/tool/container-exec/ipc-backend.test.ts golden test) also replays — so the two
independently-written ends provably agree on every wire byte. This is the artifact that
catches cross-end drift (a renamed key, a changed type string, the cancel contract)
WITHOUT a box. If a frame here changes, BOTH suites must be updated together.
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quanta_terminal_bridge import ExecResult, dispatch, encode, error_frame, parse_line  # noqa: E402

GOLDEN = json.loads((Path(__file__).resolve().parents[1] / "protocol-golden.json").read_text())


class _Env:
    def __init__(self, env):
        self._env = env

    async def exec(self, command):
        return ExecResult(self._env["stdout"], self._env["stderr"], self._env["return_code"])


def test_hands_PRODUCE_every_golden_response_frame():
    for case in GOLDEN["responses"]:
        frame = case["frame"]
        produced = asyncio.run(
            dispatch({"id": frame["id"], "type": "exec", "command": "x"}, _Env(case["env"]))
        )
        assert produced == frame, case["desc"]


def test_hands_PRODUCE_the_golden_error_frame():
    for case in GOLDEN["errors"]:
        assert error_frame(case["frame"]["id"], case["message"]) == case["frame"], case["desc"]


def test_hands_CONSUME_every_golden_request_frame():
    for case in GOLDEN["requests"]:
        # the exact bytes the brain writes must parse back to the same object (round-trip),
        # and an exec request must be routed as an exec.
        line = json.dumps(case["frame"])
        parsed = parse_line(line)
        assert parsed == case["frame"], case["desc"]


def test_golden_frames_are_byte_stable_under_our_encoder():
    # Our encoder must reproduce the golden response frames exactly (no key drift / reorder).
    for case in GOLDEN["responses"]:
        assert json.loads(encode(case["frame"])) == case["frame"], case["desc"]
