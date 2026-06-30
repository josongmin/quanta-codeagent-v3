"""
Hands-side bridge tests — PARITY with the TS `containerExecOverIpc` suite
(src/tool/container-exec/ipc-backend.test.ts). Each case pins the same wire
contract from the other end so the two cannot drift. No Harbor, no box: a
FakeEnvironment stands in for the container.
"""

import asyncio
import json
import sys
from pathlib import Path

# Import the bridge package from the adapter root (no install needed).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quanta_terminal_bridge import (  # noqa: E402
    ExecResult,
    dispatch,
    encode,
    error_frame,
    exec_result_frame,
    parse_line,
    serve,
)
from quanta_terminal_bridge.serve import _SHUTDOWN_GRACE_SECONDS  # noqa: E402


class FakeEnv:
    """Container stand-in: returns a scripted ExecResult, or raises, or is slow."""

    def __init__(self, result=None, raises=None, delay=0.0, record=None):
        self._result = result
        self._raises = raises
        self._delay = delay
        self._record = record

    async def exec(self, command):
        if self._record is not None:
            self._record.append(command)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raises is not None:
            raise self._raises
        return self._result


# ── pure dispatch ────────────────────────────────────────────────────────────


def test_exec_maps_return_code_to_code_and_passes_streams():
    seen = []
    env = FakeEnv(ExecResult("total 0", "", 0), record=seen)
    frame = asyncio.run(dispatch({"id": 0, "type": "exec", "command": "ls -la /"}, env))
    assert seen == ["ls -la /"]
    assert frame == {"id": 0, "type": "exec_result", "stdout": "total 0", "stderr": "", "code": 0}


def test_nonzero_exit_is_a_normal_result_not_an_error():
    env = FakeEnv(ExecResult("", "nope", 1))
    frame = asyncio.run(dispatch({"id": 0, "type": "exec", "command": "false"}, env))
    assert frame["type"] == "exec_result"  # the command RAN — not an error frame
    assert frame["code"] == 1


def test_null_streams_pass_through_verbatim():
    env = FakeEnv(ExecResult(None, None, 0))
    frame = asyncio.run(dispatch({"id": 0, "type": "exec", "command": "x"}, env))
    assert frame == {"id": 0, "type": "exec_result", "stdout": None, "stderr": None, "code": 0}


def test_env_exec_exception_becomes_an_error_frame():
    env = FakeEnv(raises=RuntimeError("env gone"))
    frame = asyncio.run(dispatch({"id": 0, "type": "exec", "command": "x"}, env))
    assert frame["type"] == "error"
    assert frame["id"] == 0
    assert "env gone" in frame["message"]


def test_exec_with_non_string_command_is_an_error_not_a_crash():
    env = FakeEnv(ExecResult("", "", 0))
    frame = asyncio.run(dispatch({"id": 0, "type": "exec", "command": 123}, env))
    assert frame["type"] == "error"


def test_cancel_and_unknown_types_produce_no_reply():
    env = FakeEnv(ExecResult("", "", 0))
    assert asyncio.run(dispatch({"id": 0, "type": "cancel"}, env)) is None
    assert asyncio.run(dispatch({"id": 0, "type": "wat"}, env)) is None


# ── parse / encode ───────────────────────────────────────────────────────────


def test_parse_line_accepts_valid_and_rejects_malformed():
    assert parse_line('{"id":1,"type":"exec","command":"x"}')["id"] == 1
    assert parse_line("not json {{{") is None  # malformed
    assert parse_line("[1,2,3]") is None  # non-object
    assert parse_line('{"type":"exec"}') is None  # missing id
    assert parse_line('{"id":true,"type":"exec"}') is None  # bool id is not an integer id
    assert parse_line('{"id":1.5,"type":"exec"}') is None  # float id rejected (TS sends ints only)


def test_encode_round_trips_and_both_frame_shapes_are_exact():
    line = encode(exec_result_frame(7, ExecResult("o", "e", 2)))
    assert "\n" not in line
    assert json.loads(line) == {"id": 7, "type": "exec_result", "stdout": "o", "stderr": "e", "code": 2}
    # full-shape equality (not just membership) so an extra/stray key on the error frame fails too
    assert json.loads(encode(error_frame(7, "boom"))) == {"id": 7, "type": "error", "message": "boom"}


# ── serve loop (correlation / malformed / cancel) ────────────────────────────


async def _drive(lines_in, env):
    """Run serve over a fixed inbound list; return the written frames (parsed)."""
    written = []

    async def line_iter():
        for ln in lines_in:
            yield ln

    async def write(line):
        written.append(json.loads(line))

    await serve(line_iter(), write, env)
    return written


def test_serve_correlates_concurrent_ids():
    # Two execs in flight; the env delays the FIRST more so replies would naturally
    # come back out of order — each must carry its own id.
    class TwoCmdEnv:
        async def exec(self, command):
            if command == "A":
                await asyncio.sleep(0.02)
                return ExecResult("A-out", "", 0)
            await asyncio.sleep(0.0)
            return ExecResult("B-out", "", 0)

    lines = [
        json.dumps({"id": 0, "type": "exec", "command": "A"}),
        json.dumps({"id": 1, "type": "exec", "command": "B"}),
    ]
    written = asyncio.run(_drive(lines, TwoCmdEnv()))
    by_id = {f["id"]: f for f in written}
    assert by_id[0]["stdout"] == "A-out"
    assert by_id[1]["stdout"] == "B-out"
    assert len(written) == 2
    # B (id 1) finishes first → its reply is written FIRST: proves genuinely concurrent /
    # out-of-order delivery (a mutation that serialized execs would write id 0 first → fail).
    assert written[0]["id"] == 1


def test_serve_skips_malformed_lines_without_crashing():
    lines = [
        "garbage {{{",
        json.dumps({"id": 99}),  # parses but no type → dispatched as unknown → no reply
        json.dumps({"id": 0, "type": "exec", "command": "x"}),
    ]
    written = asyncio.run(_drive(lines, FakeEnv(ExecResult("ok", "", 0))))
    assert len(written) == 1
    assert written[0] == {"id": 0, "type": "exec_result", "stdout": "ok", "stderr": "", "code": 0}


def test_serve_cancel_aborts_an_in_flight_exec_no_reply():
    # A slow exec; a cancel for the same id arrives before it finishes → the task is
    # cancelled and emits NO exec_result (the partial, if any, is the env's concern).
    async def scenario():
        started = asyncio.Event()  # created inside the running loop (py3.9-safe)

        class SlowEnv:
            async def exec(self, command):
                started.set()
                await asyncio.sleep(10)  # would hang if not cancelled
                return ExecResult("never", "", 0)

        written = []

        async def line_iter():
            yield json.dumps({"id": 0, "type": "exec", "command": "sleep"})
            await started.wait()  # ensure the exec task is actually running
            yield json.dumps({"id": 0, "type": "cancel"})

        async def write(line):
            written.append(json.loads(line))

        await serve(line_iter(), write, SlowEnv())
        return written

    written = asyncio.run(scenario())
    # Cross-end cancel contract: the loop cancels the task AND writes ONE terminal frame
    # for the id (so the TS brain, which keeps awaiting, settles — never hangs).
    assert written == [{"id": 0, "type": "error", "message": "cancelled"}]


def test_serve_stops_on_a_dead_write_transport_without_raising():
    # A broken brain pipe (write raises) must STOP the loop, not spin into a dead pipe
    # nor swallow-and-continue. serve returns (does not raise) and stops pulling more lines.
    pulled_second = []

    async def scenario():
        async def line_iter():
            yield json.dumps({"id": 0, "type": "exec", "command": "x"})
            # yield control BEFORE producing more, so the failed reply-write sets `closed`
            # and the loop's race breaks out before this second line is ever pulled.
            await asyncio.sleep(0.02)
            pulled_second.append("y")
            yield json.dumps({"id": 1, "type": "exec", "command": "y"})

        async def dead_write(_line):
            raise RuntimeError("broken pipe")

        await serve(line_iter(), dead_write, FakeEnv(ExecResult("ok", "", 0)))

    asyncio.run(scenario())  # must not raise (no hang, no escaped exception)
    assert pulled_second == []  # loop stopped before pulling the 2nd line


def test_serve_reused_id_cancel_reaches_the_LIVE_second_task():
    # TEETH against the identity-pop bug (mutation-verified: a blind `pending.pop(0)` makes this
    # RED). Ordering is EVENT-gated, not sleep-raced, so the cross-pop window is forced:
    #   1. task1 (id0) starts and PARKS (awaits release) — still in flight.
    #   2. task2 (id0) reuses the id → overwrites pending[0]=task2 (task1 still running).
    #   3. task1 is released → completes → its done-callback fires. A BLIND pop here evicts
    #      task2's entry; identity-checked pop leaves task2 tracked (pending[0] is task2, not task1).
    #   4. cancel id0 → must reach the LIVE task2. Blind-pop ⇒ pending.get(0) is None ⇒ miss.
    async def scenario():
        task2_cancelled = asyncio.Event()
        task2_started = asyncio.Event()
        release_task1 = asyncio.Event()

        class Env:
            async def exec(self, command):
                if command == "task1":
                    await release_task1.wait()  # park task1 in flight
                    return ExecResult("task1", "", 0)
                task2_started.set()  # task2 = the live second task
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    task2_cancelled.set()
                    raise

        async def line_iter():
            yield json.dumps({"id": 0, "type": "exec", "command": "task1"})
            yield json.dumps({"id": 0, "type": "exec", "command": "task2"})
            await task2_started.wait()  # both in flight; pending[0] now overwritten to task2
            release_task1.set()  # task1 completes → done-callback (blind pop would evict task2)
            await asyncio.sleep(0.02)  # let task1's done-callback run
            yield json.dumps({"id": 0, "type": "cancel"})

        async def write(_line):
            pass

        await serve(line_iter(), write, Env())
        return task2_cancelled.is_set()

    assert asyncio.run(scenario()) is True


def test_serve_shutdown_drain_is_bounded_when_an_exec_is_wedged():
    # SHUTDOWN-DEADLOCK guard. The brain closes its stdout (lines exhausted) while an exec is
    # wedged inside env.exec — a hung container command that never returns: it awaits a Future
    # nobody ever resolves. The OLD `finally` did an unbounded, un-cancelled
    # `gather(*pending)` → serve() would block FOREVER at teardown, hanging the whole agent
    # process. The fix bounds the drain (grace window, then cancel) so serve() RETURNS.
    #
    # We prove it by wrapping serve() in wait_for with a timeout comfortably larger than the
    # bounded drain but still small: if serve hung, this raises TimeoutError; it must NOT.
    async def scenario():
        started = asyncio.Event()

        class WedgedEnv:
            async def exec(self, command):
                started.set()
                # Park forever on a Future nobody resolves — models a hung container command
                # with no result and no progress. (On the drain's cancel this propagates and
                # the task unwinds; the point under test is that we don't wait on it unbounded.)
                await asyncio.get_event_loop().create_future()

        async def line_iter():
            yield json.dumps({"id": 0, "type": "exec", "command": "wedged"})
            await started.wait()  # ensure the wedged exec is actually in flight
            # ...then the brain closes stdout: iterator ends → serve breaks → drains `pending`.

        async def write(_line):
            pass

        started_at = asyncio.get_event_loop().time()
        # Headroom = 2 graces (grace window + post-cancel window) + slack, still small.
        await asyncio.wait_for(
            serve(line_iter(), write, WedgedEnv()),
            timeout=_SHUTDOWN_GRACE_SECONDS * 2 + 1.0,
        )
        # Sanity: it must have actually entered the bounded drain (not returned trivially),
        # i.e. it waited ~one grace before the cancel let it finish — but well under the cap.
        elapsed = asyncio.get_event_loop().time() - started_at
        assert elapsed >= _SHUTDOWN_GRACE_SECONDS  # the grace window really elapsed
        assert elapsed < _SHUTDOWN_GRACE_SECONDS * 2 + 1.0  # and stayed bounded

    # Must complete without TimeoutError — i.e. serve() returned despite the wedged exec.
    asyncio.run(scenario())


def test_cancel_AFTER_completion_emits_no_spurious_error_frame():
    # Abort-after-finish race: the exec completed and already wrote its exec_result. A cancel that
    # arrives afterwards must NOT emit a second `error("cancelled")` frame (the task is gone from
    # `pending`) — the brain already settled on the exec_result.
    async def scenario():
        written = []

        async def line_iter():
            yield json.dumps({"id": 0, "type": "exec", "command": "x"})
            await asyncio.sleep(0.02)  # let the fast exec finish + its reply flush
            yield json.dumps({"id": 0, "type": "cancel"})  # too late — already done

        async def write(line):
            written.append(json.loads(line))

        await serve(line_iter(), write, FakeEnv(ExecResult("ok", "", 0)))
        return written

    written = asyncio.run(scenario())
    # exactly ONE frame: the exec_result. No trailing error("cancelled").
    assert written == [{"id": 0, "type": "exec_result", "stdout": "ok", "stderr": "", "code": 0}]
