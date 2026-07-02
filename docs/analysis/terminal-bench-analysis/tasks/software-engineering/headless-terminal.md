---
task: headless-terminal
category: software-engineering
difficulty: medium
tags: [bash, terminal]
expert_min: 120
junior_min: 240
skill_class: CODE-AUTHOR
terminal_native: high
docker_image: alexgshaw/headless-terminal:20251031
---

# headless-terminal

**Goal** — Implement `HeadlessTerminal(BaseTerminal)` in `/app/headless_terminal.py`: a headless terminal that starts an interactive bash shell, executes commands via keystrokes+Enter, supports interactive programs (vim), modifier keys (`\x03`=Ctrl-C), sources startup files (`~/.bashrc`), and persists shell state. Install any deps into system python.

**Solution shape** — Tiny (~35-line) Python class backed by tmux. `__init__` creates a detached tmux session (`tmux new-session -d -s <uuid>`); `send_keystrokes(keys, wait_sec)` runs `tmux send-keys -t <session> <keys>` then `time.sleep(wait_sec)`. tmux transparently provides the PTY, interactive-shell semantics, bashrc sourcing, ctrl-key handling, background jobs, and state persistence, so the implementation is a thin wrapper. `solve.sh` just `cp`s the reference file (deps: tmux present in image).

**Verifier** — pytest against the imported class: non-interactive echo→file; interactive vim edit-save; Ctrl-C (`\x03`) cancels a `sleep && echo`; `.bashrc`-exported var is visible; `export` state persists across calls; a backgrounded `python -m http.server` is reachable via `requests.get`.

**Difficulty drivers** — Conceptual, not lengthy: knowing that a real PTY (tmux/pty/pexpect) is the right substrate for interactive shells — a naive `subprocess.run` per command fails vim, Ctrl-C, bashrc sourcing, and state persistence. Getting timing (`wait_sec`) and key encoding right. The essence *is* terminal behavior.

**quanta attack points** — quanta's own `pty_*` tools are conceptually the exact primitive this task asks the agent to reimplement — strong domain alignment for reasoning about it, though authoring uses `container_exec` (write file → run pytest). Main risk: choosing a non-PTY approach that breaks interactivity/persistence tests. The iterate-until-pass loop is strong: six behavior tests give clear, targeted signals (which interaction failed) to converge.
