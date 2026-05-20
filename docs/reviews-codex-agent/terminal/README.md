# Codex Terminal Runtime Pack

이 폴더는 Codex의 `terminal / exec session / app terminal / shell snapshot / terminal recovery` 축만 따로 모은 owner pack이다.

상위 router:
- [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)
- [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/README.md)

이 폴더의 목적:
- `exec_command`, `write_stdin`, `read_thread_terminal`을 하나의 terminal subsystem으로 묶어 설명한다
- block-like tool invocation과 string-stream terminal I/O를 분리해서 정리한다
- live exec session과 app terminal surface가 같은 rail이 아님을 직접 evidence로 고정한다
- `shell_snapshots`, active rollout JSONL, local SQLite projection이 terminal continuity에서 어떤 역할을 하는지 분리한다
- Codex 비슷한 terminal subsystem을 새로 만든다면 필요한 control plane / data plane을 설계 수준으로 적는다

이 폴더가 직접 소유하는 질문:
- Codex 터미널은 command block 단위로 실행되는가, raw string stream으로 다뤄지는가
- `exec_command`와 `write_stdin`은 어떤 session 모델 위에서 동작하는가
- `tty=true`와 non-tty long-running process는 어떻게 다른가
- `read_thread_terminal`은 `exec_command` session과 같은 것인가
- terminal tool activity는 어떤 local artifact에 남는가
- `shell_snapshots`는 무엇을 저장하는가
- terminal continuity와 interruption recovery는 어디까지 강한가
- Codex 같은 terminal subsystem을 새로 구현하려면 어떤 최소 component가 필요한가

권장 읽기 순서:
1. [terminal-surface-and-tool-contract-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-surface-and-tool-contract-audit.md)
2. [terminal-runtime-and-session-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-runtime-and-session-architecture.md)
3. [terminal-state-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-state-and-recovery-audit.md)
4. [terminal-reimplementation-blueprint.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-reimplementation-blueprint.md)

문서 배치:
- [terminal-surface-and-tool-contract-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-surface-and-tool-contract-audit.md)
  - visible tool contract, empirical behavior probe, block-vs-stream final verdict
- [terminal-runtime-and-session-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-runtime-and-session-architecture.md)
  - exec session, PTY/non-PTY split, app terminal separation, shell snapshot rail, rollout event rail
- [terminal-state-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-state-and-recovery-audit.md)
  - durable vs volatile rails, shell snapshot meaning, continuation strength, failure modes
- [terminal-reimplementation-blueprint.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-reimplementation-blueprint.md)
  - Codex-like terminal subsystem을 새로 만들 때의 API/control-plane/roadmap/failure modes

업스트림 evidence owner:
- [tool-inventory-and-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/tool-inventory-and-usage-audit.md)
- [turn-context-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/turn-context-and-runtime-interface.md)
- [thread-management/session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)
- [thread-management/logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)
- [thread-management/storage-and-db-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/storage-and-db-audit.md)

직접 읽은 local evidence:
- current active rollout sample:
  - [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl)
- shell snapshot sample:
  - [019e4661-4823-7bb1-8dd2-e188103d4a20.1779297241124921000.sh](/Users/songmin/.codex/shell_snapshots/019e4661-4823-7bb1-8dd2-e188103d4a20.1779297241124921000.sh)
- local state DB:
  - [state_5.sqlite](/Users/songmin/.codex/state_5.sqlite)
- local history/index rails:
  - [history.jsonl](/Users/songmin/.codex/history.jsonl)
  - [session_index.jsonl](/Users/songmin/.codex/session_index.jsonl)

주의:
- 이 폴더는 shell tool definition 원문을 복제하지 않는다.
- `read_thread_terminal`이 visible하다는 사실과, 실제로 app terminal session이 붙어 있다는 주장은 다르다.
- `shell_snapshots` 존재만으로 exact process replay를 단정하지 않는다.
- 추정 섹션은 `visible tool contract + live probe + local artifacts + 2026 desktop agent SOTA pattern` 조합으로만 올린다.

---

## Round 2 update (2026-05-21 deep dive)

이 라운드에서 실제 설치된 `Codex.app` (build 2867)을 직접 보면서, terminal subsystem에 대해 추가로 직접 관측된 facts:

- bundled `node-pty` v1.1.0 (`/Applications/Codex.app/Contents/Resources/app.asar/node_modules/node-pty/`) `[FACT]`
- `terminal-shell-options` IPC channel exists `[FACT]`
- `workspace-root-drop-handler-*.js`에 들어 있는 WSL detection logic (spawns `wsl.exe --status`, `wsl.exe --list --verbose`, `/usr/bin/bash -lc/-ilc`; translates `/mnt/c → C:` and `\\wsl$\<distro>\…`; filters crash-reporter env vars like `BREAKPAD_DUMP_LOCATION`, `CRASHPAD_*`, `ELECTRON_CRASH_REPORTER_PROCESS_TYPE` from spawned shells) `[FACT]`
- 27 external IDE/terminal apps tracked for "Open in" workflow (iTerm2, Warp, Ghostty, VS Code, Cursor, Zed, Windsurf, Antigravity, JetBrains family, etc.) `[FACT]`
- `~/.codex/node_repl/` directory tracks Node REPL state used by browser/computer-use plugin bootstraps `[FACT]`

세부 분포:
- node-pty / terminal-shell-options → [terminal-surface-and-tool-contract-audit.md](terminal-surface-and-tool-contract-audit.md) §5
- WSL detection / "Open in" target list → [terminal-runtime-and-session-architecture.md](terminal-runtime-and-session-architecture.md) §6
- node_repl 상태 rail → [terminal-state-and-recovery-audit.md](terminal-state-and-recovery-audit.md) §8
- 위 facts가 만드는 design requirement → [terminal-reimplementation-blueprint.md](terminal-reimplementation-blueprint.md) §9
