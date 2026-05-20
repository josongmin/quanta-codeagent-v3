# Codex Terminal Surface And Tool Contract Audit

Overview router: [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/README.md)

이 문서는 Codex terminal surface에서 직접 보이는 tool contract와, live probe로 확인한 terminal behavior만 따로 정리한다.

표기:
- `[FACT]`: 현재 세션 tool surface, local rollout, 실제 probe에서 직접 보인 것
- `[STRONG-INFERENCE]`: direct seam을 가장 잘 설명하는 구조 추론
- `[NON-CLAIM]`: 현재 evidence만으로 못 박을 수 없는 것

관련 문서:
- [tool-inventory-and-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/tool-inventory-and-usage-audit.md)
- [turn-context-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/turn-context-and-runtime-interface.md)
- [thread-management/session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)

---

## 1. Direct tool surface

현재 visible terminal-related tool surface:

1. `exec_command` `[FACT]`
2. `write_stdin` `[FACT]`
3. `read_thread_terminal` `[FACT]`

tool meaning:

| Tool | Direct role | Class |
| --- | --- | --- |
| `exec_command` | command block 실행 | `[FACT]` |
| `write_stdin` | existing exec session continuation | `[FACT]` |
| `read_thread_terminal` | current app terminal output read | `[FACT]` |

기존 owner 문서에서 이미 고정된 최소 사실:

- `exec_command`는 shell command 실행 surface다. `[FACT]`
- `write_stdin`은 이미 열린 exec session에 추가 입력을 넣는다. `[FACT]`
- `read_thread_terminal`은 현재 thread terminal output read surface다. `[FACT]`

근거:
- [tool-inventory-and-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/tool-inventory-and-usage-audit.md)
- [turn-context-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/turn-context-and-runtime-interface.md)

---

## 2. Empirical live probe

이 turn에서 직접 확인한 probe:

### 2.1 Interactive TTY session

- `exec_command(cmd=\"bash\", tty=true)`는 long-lived session을 만들었고 `session_id=15908`를 돌려줬다. `[FACT]`
- 이후 `write_stdin(session_id=15908, chars=\"pwd\\n\")`가 prompt와 output을 같은 session 위에서 이어서 돌려줬다. `[FACT]`
- 같은 session에 `echo HELLO_FROM_TTY`와 `exit`를 추가로 넣을 수 있었다. `[FACT]`

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1025](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1025)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1031](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1031)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1038](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1038)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1045](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1045)

### 2.2 Long-running non-TTY session

- `exec_command(cmd=\"bash -lc 'echo START_NONTTY; sleep 3; echo END_NONTTY'\", tty omitted)`도 `session_id=15358`를 돌려줬다. `[FACT]`
- 첫 반환은 partial output `START_NONTTY`였다. `[FACT]`
- 그 뒤 `write_stdin(session_id=15358, chars=\"\")` 빈 입력 poll로 remaining output `END_NONTTY`와 exit를 회수했다. `[FACT]`
- 즉 non-interactive process도 long-running이면 session handle을 가질 수 있다. `[FACT]`

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1036](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1036)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1039](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1039)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1041](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1041)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1044](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1044)

### 2.3 Closed-stdin failure mode

- non-tty session에 `Ctrl-C`를 보내려 했을 때, tool은 `stdin is closed for this session; rerun exec_command with tty=true to keep stdin open`를 반환했다. `[FACT]`
- 이건 `session exists`와 `stdin is interactive`가 같은 말이 아님을 직접 보여준다. `[FACT]`

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1067](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1067)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1069](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1069)

### 2.4 Short non-TTY command

- `bash -lc 'echo QUICK_DONE'`처럼 즉시 끝나는 명령은 `session_id` 없이 바로 exit result만 돌려줬다. `[FACT]`

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1093](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1093)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1095](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1095)

### 2.5 `read_thread_terminal` separation

- interactive TTY session이 살아 있는 동안에도 `read_thread_terminal`은 두 번 다 `No app terminal session is attached to this thread yet.`를 반환했다. `[FACT]`
- 따라서 current `exec_command` session과 app-level terminal surface는 동일 rail이 아니다. `[STRONG-INFERENCE]`

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1030](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1030)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1047](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1047)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1049](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1049)

---

## 3. Final verdict

가장 보수적인 최종 결론:

1. `exec_command`는 상위 orchestration surface로는 command block 단위다. `[FACT]` + `[STRONG-INFERENCE]`
2. `write_stdin`는 하위 I/O surface로는 string chunk stream continuation이다. `[FACT]`
3. `tty=true`는 true interactive stdin rail을 연다. `[FACT]`
4. non-tty long-running process도 session handle은 가질 수 있지만, stdin interactivity는 보장하지 않는다. `[FACT]`
5. `read_thread_terminal`은 `exec_command` session과 다른 app terminal rail일 가능성이 높다. `[FACT]` + `[STRONG-INFERENCE]`

한 줄로 줄이면:

- `command execution`은 block-like action dispatch
- `terminal continuation`은 session-bound string stream
- `app terminal reading`은 separate rail

---

## 4. Non-claims

이 문서가 주장하지 않는 것:

- hidden shell supervisor 구현 언어
- exact PTY library 이름
- app terminal이 언제 attach되는지의 full lifecycle
- `read_thread_terminal`가 어떤 UI action으로 attach되는지의 exact trigger
- `session_id`와 local DB row 간의 1:1 persisted mapping

---

## 5. Round 2 update (2026-05-21 deep dive)

이 라운드에서 실제 설치된 `Codex.app` (build 2867)을 직접 본 결과, §4에서 "non-claim"이라 부른 것 중 일부가 직접 관측 사실로 좁혀졌다.

### 5.1 Bundled PTY library

- `[FACT]` `node-pty` v1.1.0이 `/Applications/Codex.app/Contents/Resources/app.asar/node_modules/node-pty/`에 번들로 들어 있다.

해석:
- §4의 "exact PTY library 이름은 non-claim"이 풀렸다. PTY backend는 `node-pty` v1.1.0이라고 직접 말할 수 있다.
- 단, `node-pty`가 곧 `exec_command`의 모든 mode (tty=true vs tty omitted)를 다 처리하는지는 별개 문제다. 두 mode 모두에 `node-pty`가 쓰이는지는 단정하지 않는다. `[WEAK-INFERENCE]`

### 5.2 Terminal shell options IPC

- `[FACT]` `terminal-shell-options` IPC channel이 존재한다.

해석:
- terminal 실행 시 shell type/login flag/env 등을 조정하는 dedicated channel이 따로 있다는 직접 증거다. `[STRONG-INFERENCE]`
- §2.4의 short-non-TTY behavior와 §2.1의 interactive TTY behavior가 같은 IPC handler에 흘러가는지, 별도 분기되는지는 minified bundle에서 직접 확인하지 못했다. `[WEAK-INFERENCE]`
