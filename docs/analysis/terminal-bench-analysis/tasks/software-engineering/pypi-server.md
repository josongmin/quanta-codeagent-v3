---
task: pypi-server
category: software-engineering
difficulty: medium
tags: [coding, system]
expert_min: 60
junior_min: 180
skill_class: SYSADMIN
terminal_native: high
docker_image: alexgshaw/pypi-server:20251031
---

# pypi-server

**Goal** — Create a Python package `vectorops` (v0.1.0) exposing `dotproduct(a,b)` at package root, build it, and run a local PyPI server on port 8080 that hosts it, such that `pip install --index-url http://localhost:8080/simple vectorops==0.1.0` works.

**Solution shape** — `solve.sh` apt-installs python3/venv/apache2-utils, makes a venv, installs `pypiserver==2.3.2` + passlib/bcrypt, and installs `build`/`twine` to system Python. Creates an htpasswd user, launches `pypi-server -p 8080 --passwords ... /srv/pypi-packages` in the background (nohup), then scaffolds the `vectorops` package (`__init__.py` with `dotproduct = sum(x*y for x,y in zip(a,b))`, `setup.py` name/version), `python -m build`, and `twine upload --repository-url http://localhost:8080` to publish. Multi-step sysadmin script.

**Verifier** — pytest. `install()` uninstalls any vectorops, then `pip install --index-url http://localhost:8080/simple vectorops==0.1.0` (must succeed) and `pip show`. `test_api()` imports vectorops and asserts several dotproduct results ([1,1]·[0,1]==1, etc.). reward 0/1.

**Difficulty drivers** — Standing up a working private package index end-to-end: build backend, wheel/sdist generation, running server (auth, background process, port 8080), and a real pip round-trip against it. Requires knowing pypiserver + twine + build-tool wiring and keeping the server alive for the test. Systems/packaging plumbing more than algorithm.

**quanta attack points** — `container_exec` for install/build/serve and to curl/pip against localhost:8080. Main failure risk is the long-lived background server (nohup) dying before the verifier runs, or the `/simple` index / upload path not matching what pip expects. The exit-code loop helps because the agent can self-run the exact `pip install` command as its own check. Genuinely terminal-native (a running service + package pipeline); no interactive TUI so pty is unnecessary, but background-process management is the crux.
