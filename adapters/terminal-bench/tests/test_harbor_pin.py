"""TB21-01 RED rails — the Harbor runtime must be PINNED and singly documented.

These are *packaging* rails, not behaviour rails: they read the real bytes of
``pyproject.toml`` / ``uv.lock`` / ``README.md`` and fail when the adapter
declares a floating dependency, drifts from its lock, or documents two
mutually-exclusive custom-agent invocations.

They deliberately do NOT import harbor — the pin must be auditable from a clean
checkout with no network and no venv (that is the whole point of a lock).
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ADAPTER = Path(__file__).resolve().parents[1]
PYPROJECT = ADAPTER / "pyproject.toml"
UV_LOCK = ADAPTER / "uv.lock"
README = ADAPTER / "README.md"

# `harbor == X.Y.Z` inside the `[project.optional-dependencies] harbor = [...]`
# list. Exactly-pinned (`==`), never a range, never a VCS URL.
_PIN_RE = re.compile(r'"harbor==(?P<version>\d+\.\d+\.\d+)"')


def _pinned_version() -> str:
    text = PYPROJECT.read_text()
    match = _PIN_RE.search(text)
    assert match is not None, (
        "pyproject.toml must pin harbor to an exact version "
        '(expected a `"harbor==X.Y.Z"` requirement)'
    )
    return match.group("version")


def test_pyproject_has_no_floating_vcs_dependency():
    """A `git+https://...` requirement resolves to whatever `main` is today."""
    text = PYPROJECT.read_text()
    assert "git+" not in text, (
        "pyproject.toml still declares a VCS dependency; the backlog forbids a "
        "floating VCS/`latest` dep as promotable evidence"
    )


def test_pyproject_pins_harbor_exactly():
    version = _pinned_version()
    # Anti-vacuity: a pin of `0.0.0` would satisfy the regex but not the intent.
    assert version != "0.0.0"
    # Upstream leaderboard tooling requires `harbor[modal]>=0.20.0`.
    major, minor, _patch = (int(p) for p in version.split("."))
    assert (major, minor) >= (0, 20), (
        f"pinned harbor {version} is older than the upstream leaderboard floor "
        "(terminal-bench-2-1/leaderboard/pyproject.toml requires harbor>=0.20.0)"
    )


def test_uv_lock_exists_and_agrees_with_the_pin():
    assert UV_LOCK.exists(), "adapters/terminal-bench/uv.lock is required (TB21-01 item 3)"
    version = _pinned_version()
    lock = UV_LOCK.read_text()
    assert 'name = "harbor"' in lock, "uv.lock does not contain a harbor entry"
    # The harbor package block in a uv lock is `[[package]]\nname = "harbor"\nversion = "X.Y.Z"`.
    block = re.search(
        r'name = "harbor"\nversion = "(?P<version>[^"]+)"',
        lock,
    )
    assert block is not None, "uv.lock harbor entry has no version line"
    assert block.group("version") == version, (
        f"uv.lock pins harbor {block.group('version')} but pyproject pins {version}"
    )


def test_readme_documents_exactly_one_custom_agent_flag():
    """Harbor >= 0.20 unified custom agents onto `--agent module:Class`.

    `--agent-import-path` no longer exists on `harbor run`; keeping it alive in
    the docs would give an operator two spellings, one of which errors out.
    """
    text = README.read_text()
    assert "--agent-import-path" not in text, (
        "README still documents the retired harbor 0.16 `--agent-import-path` flag"
    )
    assert "--agent quanta_agent:QuantaAgent" in text, (
        "README must document the pinned custom-agent invocation "
        "`--agent quanta_agent:QuantaAgent`"
    )


def test_readme_targets_the_canonical_2_1_dataset():
    text = README.read_text()
    assert "terminal-bench/terminal-bench-2-1" in text
    # `terminal-bench-2` NOT followed by `-1` is the retired 2.0 dataset name.
    stale = re.findall(r"terminal-bench-2(?!-1)", text)
    assert stale == [], f"README still references the retired TB2.0 dataset ({len(stale)} hits)"


def test_readme_documents_one_install_path():
    """One documented install path, and it is the locked one."""
    text = README.read_text()
    assert "uv sync --project adapters/terminal-bench" in text
    assert "pip install -e ." not in text, (
        "README documents a second, lock-bypassing install path (`pip install -e .`)"
    )
