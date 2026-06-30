"""
Hands-side JSON protocol core — the COUNTERPARTY to quanta's TS
`containerExecOverIpc` bridge (src/tool/container-exec/ipc-backend.ts). The TS
side (brain) decides WHAT to run; this side (hands) holds a container
`environment` and actually runs it, replying over a line-delimited JSON channel.

Wire protocol (one JSON object per line, ``\\n``-framed) — IDENTICAL to the TS
header so the two ends cannot drift:

    <-  {"id", "type": "exec",   "command"}      run `command` in the bound container
    <-  {"id", "type": "cancel"}                 best-effort abort of an in-flight id
    ->  {"id", "type": "exec_result", "stdout", "stderr", "code"}  stdout/stderr nullable
    ->  {"id", "type": "error",  "message"}       could not run it (transport/exec error)

This module is PURE PROTOCOL: it knows nothing about Harbor / Terminal-Bench / a
specific orchestrator — it talks to an injected ``Environment`` (a duck-typed
``async exec(command) -> ExecResult``). The Harbor ``BaseAgent`` glue that binds
a real ``environment`` lives in a separate module and needs a live box; THIS is
unit-testable against a fake environment with zero infrastructure.

Contract parity with the TS side (each pinned by a test on BOTH ends):
  * a NON-ZERO exit is a NORMAL ``exec_result`` (the command ran) — never an error.
  * only a raised exception from ``env.exec`` becomes an ``error`` frame.
  * ``stdout``/``stderr`` may be ``None`` (orchestrator reported no stream) — passed verbatim.
  * a malformed inbound line is SKIPPED (never crashes the loop, never mis-replies).
  * ``cancel`` produces no reply from ``dispatch`` itself; the SERVE LOOP cancels the
    running task AND writes a terminal ``error`` ("cancelled") frame so the brain's
    pending call settles (cross-end cancel contract — the brain keeps awaiting).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Protocol


@dataclass(frozen=True)
class ExecResult:
    """Mirror of the orchestrator's exec result (e.g. Harbor ``ExecResult``)."""

    stdout: Optional[str]
    stderr: Optional[str]
    return_code: int


class Environment(Protocol):
    """The container the hands side runs commands in. Duck-typed: a real Harbor
    ``BaseEnvironment`` satisfies this (its ``exec`` already returns
    stdout/stderr/return_code)."""

    async def exec(self, command: str) -> ExecResult: ...


def parse_line(line: str) -> Optional[dict[str, Any]]:
    """Parse one inbound line to a JSON object addressed by an INTEGER ``id``, or
    ``None`` (skip): malformed JSON, non-object, or missing/non-integer id. The id
    guard is integer-only to stay symmetric with the TS brain (which only ever
    originates ``nextId++`` integers) — a float id is rejected at the boundary
    rather than echoed. ``bool`` is excluded (``isinstance(True, int)`` is True)."""
    try:
        msg = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(msg, dict):
        return None
    mid = msg.get("id")
    if not isinstance(mid, int) or isinstance(mid, bool):
        return None
    return msg


def encode(obj: dict[str, Any]) -> str:
    """Encode one outbound frame to a single line (no trailing newline — the
    writer frames it). Compact + stable key handling."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def exec_result_frame(req_id: Any, result: ExecResult) -> dict[str, Any]:
    """Map an ``ExecResult`` to the wire ``exec_result`` frame: ``return_code`` →
    ``code`` (the rename the TS side expects), stdout/stderr verbatim (incl. None)."""
    return {
        "id": req_id,
        "type": "exec_result",
        "stdout": result.stdout,
        "stderr": result.stderr,
        "code": result.return_code,
    }


def error_frame(req_id: Any, message: str) -> dict[str, Any]:
    return {"id": req_id, "type": "error", "message": message}


async def dispatch(msg: dict[str, Any], env: Environment) -> Optional[dict[str, Any]]:
    """Handle ONE already-parsed message → the response frame to send, or ``None``
    (no reply: ``cancel`` / unrecognized type). A raised ``env.exec`` becomes an
    ``error`` frame; a non-zero exit stays a normal ``exec_result``."""
    mtype = msg.get("type")
    req_id = msg.get("id")
    if mtype == "exec":
        command = msg.get("command")
        if not isinstance(command, str):
            return error_frame(req_id, "exec: 'command' must be a string")
        try:
            result = await env.exec(command)
        except Exception as e:  # noqa: BLE001 — any exec failure maps to a typed error frame
            return error_frame(req_id, f"{type(e).__name__}: {e}")
        return exec_result_frame(req_id, result)
    # "cancel" and any unrecognized type produce no reply (the serve loop owns cancel).
    return None


# A line-writer: takes one already-encoded frame line and emits it (the serve loop
# appends the newline). Injected so tests capture frames in memory.
LineWriter = Callable[[str], Awaitable[None]]
