"""
quanta ↔ Terminal-Bench hands-side bridge. The PURE, box-independent protocol +
serve loop live here (unit-tested without Harbor); the Harbor ``BaseAgent`` glue
that binds a live ``environment`` is in the sibling ``quanta_agent`` module and
requires a box.
"""

from .protocol import (
    Environment,
    ExecResult,
    dispatch,
    encode,
    error_frame,
    exec_result_frame,
    parse_line,
)
from .serve import serve

__all__ = [
    "Environment",
    "ExecResult",
    "dispatch",
    "encode",
    "error_frame",
    "exec_result_frame",
    "parse_line",
    "serve",
]
