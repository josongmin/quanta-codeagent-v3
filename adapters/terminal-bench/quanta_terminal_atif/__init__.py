"""ATIF (Agent Trajectory Interchange Format) emission for the Quanta Harbor agent.

WHY A FILE AND NOT A CONTEXT FIELD
----------------------------------
Read out of the pinned dependency (harbor 0.21.0), not from prose:

* ``harbor.models.agent.context.AgentContext`` has **no** trajectory slot — its
  fields are ``n_input_tokens`` / ``n_cache_tokens`` / ``n_output_tokens`` /
  ``cost_usd`` / ``rollout_details`` / ``metadata``.
* ``harbor.upload.uploader`` (``upload/uploader.py``) does::

      traj_file = trial_dir / "agent" / "trajectory.json"
      if traj_file.exists(): ... trajectory_path = f"trials/{id}/trajectory.json"

  and ``trial_dir / "agent"`` is exactly the agent's ``logs_dir``
  (``harbor.models.trial.paths.TrialPaths.agent_dir``).
* ``harbor.agents.base.BaseAgent.SUPPORTS_ATIF`` is the class-level declaration
  that an agent speaks ATIF.

So the whole contract is: **write ATIF to ``self.logs_dir / "trajectory.json"``
and set ``SUPPORTS_ATIF = True``.** The upstream 2.1 leaderboard's static
analysis fails any *rewarded* trial without a Hub ``trajectory_path``.

WE DO NOT MIRROR THE SCHEMA
---------------------------
The authoritative types live in ``harbor.models.trajectories`` (``Trajectory``,
``Step``, ``ToolCall``, ``Observation``, ``ObservationResult``, ``Metrics``,
``FinalMetrics``, ``Agent``). This module builds a payload and then validates it
through ``harbor.utils.trajectory_validator.TrajectoryValidator`` — Harbor's own
validator, over Harbor's own pydantic models, which are ``extra="forbid"`` and
therefore reject any field we invent. Nothing here re-declares the schema; the
only constants we own are the field *names we populate* and the bounds we apply.

Validation is unavailable (and skipped) when harbor is not importable — that is
the local, box-free dev path only. On a box harbor is always present, so the
strict path always runs there.

WHAT IS DELIBERATELY EXCLUDED
-----------------------------
* hidden verifier content — the adapter never sees it (Harbor runs the verifier
  after ``run()`` returns, in a directory the agent does not read);
* credential / env values — no environment is ever serialized, and every string
  that *is* serialized is scrubbed of the live values of secret-named env vars;
* unbounded tool stdout — every emitted string is capped at
  :data:`FIELD_CHAR_CAP` and the step list at :data:`MAX_STEPS`;
* synthetic reasoning text — the brain does not record model reasoning, so no
  ``reasoning_content`` is ever emitted. Inventing one would be fabrication.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

__all__ = [
    "ATIF_FILENAME",
    "ATIF_SCHEMA_VERSION",
    "AtifValidationError",
    "AtifValidationUnavailable",
    "FIELD_CHAR_CAP",
    "MAX_STEPS",
    "REDACTION_TEMPLATE",
    "SECRET_ENV_NAMES",
    "SECRET_ENV_NAME_SUFFIXES",
    "TERMINATION_COMPLETED",
    "TERMINATION_ERROR",
    "TERMINATION_NO_REPORT",
    "build_trajectory_payload",
    "harbor_atif_available",
    "scrubbed",
    "secret_values_from_env",
    "validate_payload",
    "write_trajectory",
]

# The uploader's hard-coded filename (harbor/upload/uploader.py). Not a choice.
ATIF_FILENAME = "trajectory.json"

# The newest schema version the pinned harbor's `Trajectory.schema_version`
# Literal accepts, and its default.
ATIF_SCHEMA_VERSION = "ATIF-v1.7"

# Bounds. These MIRROR the brain's own cassette bounds
# (`src/apps/terminal/brain-mode.ts`: TRAJECTORY_MAX_STEPS = 200,
# TRAJECTORY_PREVIEW_MAX = 240) so the adapter never *widens* what the brain
# already bounded, and still bounds a brain that (e.g. an older build) did not.
MAX_STEPS = 200
FIELD_CHAR_CAP = 240

REDACTION_TEMPLATE = "[redacted:{name}]"

# Env vars whose VALUE is a secret. Exact names first, then a name-suffix rule.
# This classifies by NAME only — it never inspects a value's shape, so it is a
# convention, not a content heuristic.
SECRET_ENV_NAMES = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "HARBOR_API_KEY",
        "OPENAI_API_KEY",
        "QUANTA_API_KEY",
    }
)
SECRET_ENV_NAME_SUFFIXES = ("_API_KEY", "_KEY", "_PASSWORD", "_SECRET", "_TOKEN")

TERMINATION_COMPLETED = "completed"
TERMINATION_NO_REPORT = "no_report"
TERMINATION_ERROR = "error"

#: Closed set of termination statuses this adapter can emit.
TERMINATION_STATUSES = frozenset(
    {TERMINATION_COMPLETED, TERMINATION_NO_REPORT, TERMINATION_ERROR}
)

# Brain cassette `kind` -> the ATIF `function_name` and the argument key the
# command rides under. `tool` is special: the tool NAME is in `cmd`.
_KIND_TO_TOOL = {
    "exec": ("container_exec", "command"),
    "pty": ("pty", "data"),
}


class AtifValidationUnavailable(RuntimeError):
    """Raised when harbor (the schema owner) is not importable."""


class AtifValidationError(ValueError):
    """Raised when a payload fails harbor's own ATIF validator."""

    def __init__(self, errors: Sequence[str]) -> None:
        self.errors = list(errors)
        super().__init__("ATIF validation failed: " + "; ".join(self.errors))


def harbor_atif_available() -> bool:
    """True when harbor's official ATIF models/validator can be imported."""
    try:  # pragma: no cover — exercised on both sides by the two test rails
        import harbor.utils.trajectory_validator  # noqa: F401
    except Exception:  # noqa: BLE001 — any import failure means "not available"
        return False
    return True


# ── redaction / bounding ─────────────────────────────────────────────────────


def _is_secret_name(name: str) -> bool:
    upper = name.upper()
    return upper in SECRET_ENV_NAMES or upper.endswith(SECRET_ENV_NAME_SUFFIXES)


def secret_values_from_env(env: Mapping[str, str]) -> "dict[str, str]":
    """Map every non-empty secret-named env VALUE to its NAME.

    The returned mapping is used to scrub those literal values out of anything
    we serialize. It is never itself serialized — only the NAME survives, inside
    the redaction marker, so an auditor can see *which* credential was elided.
    """
    values: "dict[str, str]" = {}
    for name, value in env.items():
        if not isinstance(value, str) or value == "":
            continue
        if _is_secret_name(name):
            # Longest value first at scrub time keeps a value that contains a
            # shorter one from being partially replaced.
            values[value] = name
    return values


def _redact(text: str, secrets: Mapping[str, str]) -> str:
    for value in sorted(secrets, key=len, reverse=True):
        if value in text:
            text = text.replace(value, REDACTION_TEMPLATE.format(name=secrets[value]))
    return text


def _bound(text: str) -> str:
    if len(text) <= FIELD_CHAR_CAP:
        return text
    return text[: FIELD_CHAR_CAP - 1] + "…"


def _clean(value: Any, secrets: Mapping[str, str]) -> str:
    """Redact THEN bound. Order matters: bounding first could cut a secret in
    half and leave a recognisable prefix in the artifact."""
    return _bound(_redact("" if value is None else str(value), secrets))


# ── payload construction ─────────────────────────────────────────────────────


def _tool_step(
    step_id: int,
    entry: Mapping[str, Any],
    secrets: Mapping[str, str],
    model: Optional[str],
    effort: Optional[str],
) -> "dict[str, Any]":
    kind = str(entry.get("kind") or "tool")
    raw_cmd = entry.get("cmd")
    if kind in _KIND_TO_TOOL:
        function_name, arg_key = _KIND_TO_TOOL[kind]
        arguments = {arg_key: _clean(raw_cmd, secrets)}
    else:
        # `kind == "tool"`: the brain puts the TOOL NAME in `cmd`; there are no
        # recorded arguments, and ATIF allows an empty argument dict.
        function_name = _clean(raw_cmd, secrets) or "tool"
        arguments = {}

    call_id = "call-{0}".format(step_id)
    result: "dict[str, Any]" = {"source_call_id": call_id}
    preview = entry.get("preview")
    if preview is not None:
        result["content"] = _clean(preview, secrets)
    result_extra: "dict[str, Any]" = {}
    if entry.get("ok") is not None:
        result_extra["ok"] = bool(entry["ok"])
    if entry.get("exitCode") is not None:
        result_extra["exit_code"] = entry["exitCode"]
    if result_extra:
        result["extra"] = result_extra

    step: "dict[str, Any]" = {
        "step_id": step_id,
        "source": "agent",
        # ATIF requires `message`; a pure tool dispatch has no dialogue text.
        "message": "",
        "tool_calls": [
            {
                "tool_call_id": call_id,
                "function_name": function_name,
                "arguments": arguments,
                "extra": {"kind": kind},
            }
        ],
        "observation": {"results": [result]},
    }
    if model is not None:
        step["model_name"] = model
    if effort is not None:
        step["reasoning_effort"] = effort
    return step


def _text_step(
    step_id: int,
    text: str,
    secrets: Mapping[str, str],
    model: Optional[str],
    effort: Optional[str],
) -> "dict[str, Any]":
    step: "dict[str, Any]" = {
        "step_id": step_id,
        "source": "agent",
        "message": _clean(text, secrets),
    }
    if model is not None:
        step["model_name"] = model
    if effort is not None:
        step["reasoning_effort"] = effort
    return step


def _cassette(report: Optional[Mapping[str, Any]]) -> "list[Mapping[str, Any]]":
    if not isinstance(report, Mapping):
        return []
    raw = report.get("trajectory")
    if not isinstance(raw, (list, tuple)):
        return []
    return [entry for entry in raw if isinstance(entry, Mapping)]


def _tokens(report: Optional[Mapping[str, Any]]) -> "dict[str, Any]":
    if not isinstance(report, Mapping):
        return {}
    tokens = report.get("tokens")
    return dict(tokens) if isinstance(tokens, Mapping) else {}


def build_trajectory_payload(
    *,
    instruction: str,
    report: Optional[Mapping[str, Any]],
    agent_name: str,
    agent_version: str,
    termination: str,
    model: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
    reasoning_effort_wire_honored: Optional[bool] = None,
    session_id: Optional[str] = None,
    secret_values: Optional[Mapping[str, str]] = None,
    extra: Optional[Mapping[str, Any]] = None,
) -> "dict[str, Any]":
    """Convert the brain's ordered report into an ATIF payload.

    ``report`` may be ``None`` (missing / garbled / the run died before it was
    written). That is not an error: a failing or timed-out trial must still
    produce a bounded terminal receipt, so the payload degrades to the
    instruction step plus a terminal agent step naming the termination status.
    """
    if termination not in TERMINATION_STATUSES:
        raise ValueError(
            "unknown termination status {0!r}; expected one of {1}".format(
                termination, sorted(TERMINATION_STATUSES)
            )
        )
    secrets = dict(secret_values or {})

    steps: "list[dict[str, Any]]" = [
        {"step_id": 1, "source": "user", "message": _clean(instruction, secrets)}
    ]

    cassette = _cassette(report)
    # Reserve room for the instruction step and the terminal step; keep the TAIL
    # of the cassette, mirroring the brain (the tail is where finalize happens).
    budget = MAX_STEPS - 2
    truncated = len(cassette) > budget
    if truncated:
        cassette = cassette[-budget:]

    for entry in cassette:
        step_id = len(steps) + 1
        if entry.get("kind") == "text":
            steps.append(
                _text_step(step_id, str(entry.get("text") or ""), secrets, model, reasoning_effort)
            )
        else:
            steps.append(_tool_step(step_id, entry, secrets, model, reasoning_effort))

    final_text = ""
    if isinstance(report, Mapping) and isinstance(report.get("final"), str):
        final_text = report["final"]
    if not final_text:
        final_text = "[no final message: termination={0}]".format(termination)
    steps.append(_text_step(len(steps) + 1, final_text, secrets, model, reasoning_effort))

    tokens = _tokens(report)
    cost = report.get("cost_usd") if isinstance(report, Mapping) else None
    final_metrics: "dict[str, Any]" = {"total_steps": len(steps)}
    if isinstance(tokens.get("input"), int):
        final_metrics["total_prompt_tokens"] = tokens["input"]
    if isinstance(tokens.get("output"), int):
        final_metrics["total_completion_tokens"] = tokens["output"]
    if isinstance(cost, (int, float)):
        final_metrics["total_cost_usd"] = float(cost)

    agent_extra: "dict[str, Any]" = {"termination": termination}
    if reasoning_effort is not None:
        agent_extra["reasoning_effort"] = reasoning_effort
    if reasoning_effort_wire_honored is not None:
        agent_extra["reasoning_effort_wire_honored"] = reasoning_effort_wire_honored

    root_extra: "dict[str, Any]" = {"termination": termination}
    if extra:
        root_extra.update(extra)

    payload: "dict[str, Any]" = {
        "schema_version": ATIF_SCHEMA_VERSION,
        "agent": {
            "name": agent_name,
            "version": agent_version,
            "extra": agent_extra,
        },
        "steps": steps,
        "final_metrics": final_metrics,
        "extra": root_extra,
    }
    if model is not None:
        payload["agent"]["model_name"] = model
    if session_id is not None:
        payload["session_id"] = session_id
    if truncated:
        payload["notes"] = (
            "Brain cassette truncated to the last {0} steps (adapter bound "
            "MAX_STEPS={1}); total_steps counts the steps present in this "
            "document.".format(budget, MAX_STEPS)
        )
    return payload


# ── validation / write ───────────────────────────────────────────────────────


def validate_payload(payload: Mapping[str, Any]) -> "list[str]":
    """Validate through harbor's OWN validator. Returns the error list ([] = ok).

    Raises :class:`AtifValidationUnavailable` when harbor is not importable —
    the caller decides whether that is fatal (it is not, locally; harbor is
    always installed on a box).
    """
    try:
        from harbor.utils.trajectory_validator import TrajectoryValidator
    except Exception as exc:  # noqa: BLE001
        raise AtifValidationUnavailable(
            "harbor is not importable, so the official ATIF schema cannot be "
            "consulted; install the pinned `harbor` extra"
        ) from exc
    validator = TrajectoryValidator()
    # `validate_images` needs a directory context we do not have for a dict.
    validator.validate(dict(payload), validate_images=False)
    return validator.get_errors()


def write_trajectory(
    logs_dir: "str | Path",
    payload: Mapping[str, Any],
    *,
    strict: Optional[bool] = None,
) -> Path:
    """Write ``logs_dir/trajectory.json`` and validate it against harbor's models.

    The file is written FIRST and validated after, so a schema regression still
    leaves an inspectable artifact on disk instead of a silent hole.

    ``strict`` defaults to "strict iff harbor is importable": on a box that is
    always True. In strict mode a validation failure raises
    :class:`AtifValidationError`.
    """
    directory = Path(logs_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ATIF_FILENAME
    path.write_text(json.dumps(payload, indent=2, sort_keys=False, ensure_ascii=False))

    if strict is None:
        strict = harbor_atif_available()
    if not strict:
        return path
    errors = validate_payload(payload)
    if errors:
        raise AtifValidationError(errors)
    return path


def scrubbed(value: Any, env: Mapping[str, str]) -> Any:
    """Deep-copy ``value`` with every secret-named env VALUE redacted.

    Used for the receipts that ride ``AgentContext.metadata`` — the brain's own
    report is free-form and could echo a credential it was handed.
    """
    secrets = secret_values_from_env(env)
    return _scrub(value, secrets)


def _scrub(value: Any, secrets: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        return _redact(value, secrets)
    if isinstance(value, Mapping):
        return {key: _scrub(item, secrets) for key, item in value.items()}
    if isinstance(value, (list, tuple)) and not isinstance(value, (str, bytes)):
        return [_scrub(item, secrets) for item in value]
    return value
