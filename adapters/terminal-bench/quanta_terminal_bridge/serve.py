"""
Async serve loop around the pure ``protocol`` core: read line-delimited JSON
requests from an inbound line source, dispatch each against the bound
``environment``, write response frames back. Concurrency-correct: each ``exec``
runs as its own task so out-of-order / concurrent ids behave exactly like the TS
``containerExecOverIpc`` expects, and a ``cancel`` frame cancels the matching
in-flight task.

CANCEL CONTRACT (cross-end parity — the brain KEEPS awaiting after sending cancel):
a ``cancel`` cancels the task AND writes a TERMINAL frame for that id so the brain's
pending call always settles (never hangs). We send an ``error`` frame ("cancelled")
— a cancelled ``env.exec`` yields no partial output generically, so a terminal error
is the honest, deterministic reply. (If a future env can return partial output on
cancel, that would be an ``exec_result`` instead — still terminal, still settles.)

Transport-agnostic: ``lines`` is any async iterator of strings (one JSON object
each — framing is the transport's job, mirroring the TS ``JsonLineDuplex``
contract) and ``write`` emits one frame line. A failing ``write`` (dead brain
pipe) STOPS the loop promptly — even when the failure happens on a concurrent
exec-reply task — symmetric with the TS side treating a closed duplex as fatal.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

from .protocol import Environment, LineWriter, dispatch, encode, error_frame, parse_line

# Shutdown grace: once `lines` is exhausted (brain closed its stdout) we give still-pending
# execs this long to flush their replies, THEN cancel + bounded-wait so a wedged env.exec
# (a hung container command that never returns and ignores cancellation) cannot block
# teardown forever. Kept small — at shutdown the brain pipe is already gone, so no reply we
# wait on can still matter; this is purely a courtesy window for tasks about to finish.
_SHUTDOWN_GRACE_SECONDS = 2.0


async def serve(lines: AsyncIterator[str], write: LineWriter, env: Environment) -> None:
    """Run the request/response loop until ``lines`` is exhausted OR the write
    transport dies. Pending exec tasks are awaited/cancelled on exit so nothing
    is orphaned."""
    pending: dict[Any, asyncio.Task[None]] = {}
    closed = asyncio.Event()  # set the instant ANY write fails (dead brain pipe)

    async def safe_write(line: str) -> None:
        if closed.is_set():
            return
        try:
            await write(line)
        except Exception:  # noqa: BLE001 — a dead brain pipe is fatal; flag it, callers stop
            closed.set()

    async def run_one(msg: dict[str, Any]) -> None:
        frame = await dispatch(msg, env)
        if frame is not None:
            await safe_write(encode(frame))

    def _untrack(req_id: Any, task: "asyncio.Task[None]") -> None:
        # Identity-checked pop: if a (mis-behaving) producer reused an id, do NOT evict
        # a DIFFERENT live task's entry. Only remove our own.
        if pending.get(req_id) is task:
            pending.pop(req_id, None)

    it = lines.__aiter__()
    try:
        while not closed.is_set():
            # Race the next line against the closed flag so a write failure on a concurrent
            # reply task stops the loop promptly instead of reading on into a dead pipe.
            nxt = asyncio.ensure_future(it.__anext__())
            closing = asyncio.ensure_future(closed.wait())
            done, _pending_waits = await asyncio.wait(
                {nxt, closing}, return_when=asyncio.FIRST_COMPLETED
            )
            if closed.is_set():
                nxt.cancel()
                closing.cancel()
                break
            closing.cancel()
            try:
                line = nxt.result()
            except StopAsyncIteration:
                break

            msg = parse_line(line)
            if msg is None:
                continue  # malformed — skip, never crash the loop
            mtype = msg.get("type")
            req_id = msg.get("id")
            if mtype == "cancel":
                task = pending.get(req_id)
                if task is not None:
                    # Only an IN-FLIGHT task needs the synthetic terminal frame: the cancelled
                    # run_one writes nothing itself, so we send `error("cancelled")` to settle the
                    # brain. If the task already COMPLETED (abort-after-finish race), it already
                    # wrote its `exec_result` and the brain settled — sending another frame here
                    # would be a spurious double-reply, so we don't.
                    task.cancel()
                    await safe_write(encode(error_frame(req_id, "cancelled")))
                continue
            # exec (or unknown): dispatch concurrently, correlated by id.
            task = asyncio.ensure_future(run_one(msg))
            pending[req_id] = task
            task.add_done_callback(lambda t, _id=req_id: _untrack(_id, t))
    finally:
        # Drain: let in-flight execs finish (so their replies flush) — but BOUND it so a
        # wedged exec (a hung container command that never returns) can't block teardown
        # forever. We use `asyncio.wait` (NOT wait_for+gather) deliberately: wait_for would
        # cancel its inner future on timeout and then BLOCK until that cancellation actually
        # takes effect — which never happens if the exec ignores CancelledError, re-creating
        # the very hang we're fixing. `asyncio.wait(timeout=...)` instead returns a
        # (done, still_pending) split WITHOUT waiting on stragglers, so the grace is a true
        # upper bound regardless of how badly a task misbehaves.
        if pending:
            tasks = list(pending.values())
            # 1) Grace window: already-finished tasks reap instantly; ones about to finish get
            #    a brief courtesy to flush. A clean shutdown (no in-flight work) returns at once.
            _done, still_pending = await asyncio.wait(
                tasks, timeout=_SHUTDOWN_GRACE_SECONDS
            )
            # 2) Anything still running is wedged: cancel it and give a final bounded window to
            #    unwind. We do NOT wait for cancellation to be honored — if the task swallows
            #    CancelledError, we still exit. (Cancelled tasks left behind are reaped by the
            #    loop at process exit; the agent is shutting down regardless.)
            if still_pending:
                for t in still_pending:
                    t.cancel()
                await asyncio.wait(still_pending, timeout=_SHUTDOWN_GRACE_SECONDS)
