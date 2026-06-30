"""
Box-free coverage of the ONE piece of logic in the (otherwise box-only) Harbor glue:
``HarborEnvironmentAdapter`` — it must faithfully reconstruct an ``ExecResult`` from a
duck-typed Harbor result. A field-name drift here would silently break at box time, so
pin it now without importing harbor (the glue's harbor import is optional).
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quanta_agent import HarborEnvironmentAdapter  # noqa: E402
from quanta_terminal_bridge import ExecResult  # noqa: E402


class FakeHarborResult:
    def __init__(self, stdout, stderr, return_code):
        self.stdout = stdout
        self.stderr = stderr
        self.return_code = return_code


class FakeHarborEnv:
    def __init__(self, result):
        self._result = result
        self.calls = []

    async def exec(self, command):
        self.calls.append(command)
        return self._result


def test_adapter_maps_harbor_result_fields_1to1():
    env = FakeHarborEnv(FakeHarborResult("out", "err", 3))
    adapter = HarborEnvironmentAdapter(env)
    result = asyncio.run(adapter.exec("ls"))
    assert isinstance(result, ExecResult)
    assert result == ExecResult(stdout="out", stderr="err", return_code=3)
    assert env.calls == ["ls"]


def test_adapter_preserves_null_streams():
    env = FakeHarborEnv(FakeHarborResult(None, None, 0))
    result = asyncio.run(HarborEnvironmentAdapter(env).exec("x"))
    assert result == ExecResult(stdout=None, stderr=None, return_code=0)
