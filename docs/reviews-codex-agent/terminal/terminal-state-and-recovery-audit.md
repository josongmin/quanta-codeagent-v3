# Codex Terminal State And Recovery Audit

Overview router: [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/README.md)

이 문서는 Codex terminal subsystem에서 무엇이 durable하고 무엇이 volatile한지, 그리고 interruption 뒤 어떤 recovery rail이 가장 강한지 정리한다.

표기:
- `[FACT]`: current tool surface, local artifacts, live probe에서 직접 보인 것
- `[STRONG-INFERENCE]`: direct seam을 가장 잘 설명하는 구조 추론
- `[SOTA-INFERENCE]`: desktop coding-agent 일반 패턴과 현재 evidence를 합친 추론
- `[NON-CLAIM]`: evidence 부족으로 못 박지 않는 것

관련 문서:
- [terminal-runtime-and-session-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/terminal/terminal-runtime-and-session-architecture.md)
- [thread-management/logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)
- [thread-management/storage-and-db-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/storage-and-db-audit.md)

---

## 1. Direct recovery rails

terminal continuity와 관련해 직접 보인 rails:

1. `session_id` keyed exec continuation `[FACT]`
2. active rollout JSONL function_call/output rail `[FACT]`
3. `shell_snapshots/*.sh` local filesystem rail `[FACT]`
4. `threads` / `thread_dynamic_tools` local SQLite projection `[FACT]`
5. app terminal read surface `read_thread_terminal` `[FACT]`

---

## 2. Recovery strength by rail

| Rail | Direct evidence | Strength | Why |
| --- | --- | --- | --- |
| `session_id` continuation | live `exec_command` -> `write_stdin` probe | Medium | same-process continuation exists, restart survival unproven |
| active rollout JSONL | function_call/output rows persisted | Strong | same-thread replay/debug substrate가 직접 보임 |
| `shell_snapshots/*.sh` | shell state dump-like `.sh` files | Medium | shell environment restore substrate는 plausible, process restore는 unproven |
| local SQLite projection | `threads`, `thread_dynamic_tools` | Medium | control-plane metadata survives, raw terminal stream SSOT는 아님 |
| app terminal read surface | `read_thread_terminal` tool exists | Weak-Medium | attached terminal이 있을 때만 의미, attach lifecycle 미확정 |
| workspace artifacts | repo files/logs/docs | Very Strong | terminal 바깥 durable truth |

classification:
- evidence column `[FACT]`
- strength judgment `[STRONG-INFERENCE]`

---

## 3. What `shell_snapshots` likely are

직접 보이는 facts:

- snapshot file extension은 `.sh`다 `[FACT]`
- body는 transcript가 아니라 shell reconstruction script shape다 `[FACT]`
- aliases, functions, setopts, exports를 담는다 `[FACT]`
- sample file에는 current repo-related helper function과 `CODEX_SHELL=1` export가 들어 있다 `[FACT]`

가장 자연스러운 해석:

- `shell_snapshots`는 raw output log보다 `shell environment snapshot`에 가깝다. `[STRONG-INFERENCE]`
- terminal recovery가 필요할 때 fresh shell을 비슷한 state로 재시작하는 substrate일 가능성이 높다. `[SOTA-INFERENCE]`
- 하지만 running PID tree, foreground job, pipe buffer까지 재현한다고 말할 근거는 없다. `[NON-CLAIM]`

근거:
- [019e4661-4823-7bb1-8dd2-e188103d4a20.1779297241124921000.sh](/Users/songmin/.codex/shell_snapshots/019e4661-4823-7bb1-8dd2-e188103d4a20.1779297241124921000.sh)

---

## 4. Same-thread interruption recovery

현재 evidence에서 가장 강한 복구 경로:

1. rollout JSONL에서 직전 tool call과 output을 읽는다 `[FACT]`
2. thread row와 related metadata를 읽는다 `[FACT]`
3. 필요하면 shell snapshot으로 shell environment를 재수립한다 `[STRONG-INFERENCE]`
4. 중요한 state는 workspace artifact에서 다시 읽는다 `[FACT]` + `[STRONG-INFERENCE]`

즉:

- live process state만 믿는 모델보다
- `rollout + snapshot + artifact` 조합이 훨씬 현실적이다. `[STRONG-INFERENCE]`

---

## 5. Failure scenarios

### Scenario 1: `session_id`만 믿고 프로세스 복구를 가정

- setup: long-running process가 있고 `session_id`만 저장
- interruption: app restart or supervisor loss
- likely result: same PID/proc tree continuation은 보장 안 됨
- safer path: rollout + shell snapshot + workspace artifact 재구성
- severity: P1

### Scenario 2: `read_thread_terminal`가 exec session을 항상 읽는다고 가정

- setup: tool-launched shell이 열려 있음
- trigger: `read_thread_terminal`
- observed result: attached app terminal이 없으면 아무것도 못 읽음
- severity: P1

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1030](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1030)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1049](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1049)

### Scenario 3: shell snapshot을 full transcript로 가정

- setup: operator expects stdout/stderr history in snapshot
- observed file shape: alias/function/export-heavy shell state dump
- likely result: actual output RCA에 필요한 payload는 rollout/tool output rail 쪽에 더 많음
- severity: P2

### Scenario 4: non-tty session에 arbitrary stdin signal injection 기대

- setup: long-running non-tty process
- trigger: later `write_stdin`
- observed result: stdin may already be closed
- severity: P2

근거:
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1069](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl#L1069)

---

## 6. Final model

terminal continuity를 가장 보수적으로 요약하면:

- `session_id`는 live continuation handle이다 `[FACT]`
- rollout JSONL은 replay/debug event rail이다 `[FACT]`
- `shell_snapshots`는 shell-state snapshot rail이다 `[FACT]` + `[STRONG-INFERENCE]`
- workspace artifact가 여전히 가장 강한 durable truth다 `[STRONG-INFERENCE]`
- app terminal read는 optional attached rail이다 `[FACT]` + `[STRONG-INFERENCE]`

한 줄로 줄이면:

- terminal recovery는 `live session`보다 `event log + shell snapshot + artifact` 쪽이 더 강하다.

---

## 7. Non-claims

이 문서가 주장하지 않는 것:

- app restart 뒤 `session_id`가 자동 복원된다는 것
- `shell_snapshots`가 Codex 내부에서 반드시 자동 replay된다는 것
- exact shell history file capture rule
- exact shell snapshot GC policy

---

## 8. Round 2 update (2026-05-21 deep dive)

이 라운드에서 실제 설치된 `Codex.app` (build 2867)의 `~/.codex/` on-disk 구조를 직접 본 결과, terminal continuity와 관련된 rail이 한 종 더 식별됐다.

### 8.1 Node REPL state rail

- `[FACT]` `~/.codex/node_repl/` directory가 존재한다.
- `[FACT]` 이 디렉터리는 browser/computer-use plugin bootstrap에서 쓰이는 Node REPL state를 추적한다.

해석:
- §1의 recovery rails 목록에 **`node_repl` directory** rail을 추가해야 한다. `[STRONG-INFERENCE]`
- shell snapshot rail이 system shell (zsh/bash) 환경 restore substrate이라면, `node_repl` rail은 Node REPL 세션 상태에 대한 별도 substrate로 보인다. `[STRONG-INFERENCE]`
- 단, 이 rail이 자동 replay되는지 / interactive REPL session continuity에 실제로 사용되는지는 직접 관측되지 않았다. `[WEAK-INFERENCE]`

### 8.2 Recovery strength table 갱신

§2의 강도 표에 다음 행을 더해야 한다.

| Rail | Direct evidence | Strength | Why |
| --- | --- | --- | --- |
| `~/.codex/node_repl/` | directory exists with REPL state files | Medium | plugin bootstrap에 쓰인다는 결합 evidence는 있으나, REPL replay가 실제로 일어나는지는 unproven |

분류:
- evidence column `[FACT]`
- strength judgment `[STRONG-INFERENCE]`
