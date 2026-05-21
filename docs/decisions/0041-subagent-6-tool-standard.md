# ADR-0041: Subagent 6-tool 표준 (exec_command / write_stdin / spawn_agent / wait_agent / close_agent / send_input)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: Cluster E F15, codex-subagent-tools, ADR-0015(Codex foundation), `src/subagent/agent-tool.ts` / `registry.ts`(in-flight)

## 맥락

Codex `codex-subagent-tools` 분석은 수천 개 subagent 세션에서 실제 사용된
tool 분포를 통계로 정리한다:

```
exec_command   75%   one-shot synchronous shell command
write_stdin    24%   long-running PTY에 stdin write
spawn_agent     ~     child subagent 생성
wait_agent      ~     child 완료 대기 (timeout 옵션)
close_agent     ~     child 종료
send_input      ~     paused child에게 user input 전달
```

지배적인 2 tool (exec_command 75% + write_stdin 24%)이 ~99% 사용량을
차지하며, 나머지 4 tool은 spawn/wait/close/input 라이프사이클 plumbing.
v3는 이미 `src/subagent/agent-tool.ts` / `task-tools.ts`에 유사한 surface
가 있으나, 이름과 schema 형태가 Codex 표준과 1:1이 아니다 (예: 우리는
`task_output` / `task_stop` 이름 사용). 호환 path를 표준화하지 않으면
Codex format으로 trace된 세션 import가 손실 발생.

문제: **handler 구현은 별도 follow-up이 필요**하나, contract surface
(input/output schema + tool name + semantics)는 안정화가 즉시 가능.
Cluster E의 minimum-touch 정책상 in-flight `src/subagent/agent-tool.ts`
파일은 worktree에서 수정 금지.

## 결정

### Part 1 — contract-only 신규 모듈

`src/subagent/tools-6.ts` 신규 파일에 6 tool의 **계약 (contract)** 만 ship:

- `SUBAGENT_6_TOOL_NAMES` — frozen 6-element tuple, doc-order = usage 빈도
  내림차순.
- 각 tool마다 `<Name>InputSchema` / `<Name>OutputSchema` — 모두 Zod
  `.strict()`.
- output schema는 모두 `kind: "success" | "error"` discriminated union.
  `error` shape에 optional `cause` 필드 (`"timeout" | "signal:..." |
  "abort"` 등 자유 hint string).
- `SUBAGENT_6_TOOL_CONTRACTS` — `Record<name, { name, inputSchema,
  outputSchema, semantics }>` frozen dispatch table.
- **handler 없음** — 본 모듈은 zod 외 import 0. 실제 dispatch는 in-flight
  registry/agent-tool follow-up.

### Part 2 — semantics 명문화

각 tool blurb (`Subagent6ToolContract.semantics`) 1줄로 행동 약속:

- `exec_command(command, cwd, timeoutMs, pty?, env?)` → `{ exitCode,
  stdout, stderr, pid? }`. `pty: true`일 때 pid 반환되어 후속 write_stdin
  가능.
- `write_stdin(pid, data, appendNewline?)` → `{ bytesWritten }`. 장기
  실행 PTY 대상.
- `spawn_agent(prompt, agentType?, toolFilter?, maxDepth?)` → `{ agentId
  }`. agentId는 `agent_<uuid>` 형태 권장 (registry follow-up).
- `wait_agent(agentId, timeoutMs?)` → `{ status: completed|failed|stopped,
  finalText, turns }`. timeout 시 `kind:"error", cause:"timeout"` — child
  은 살아있음.
- `close_agent(agentId)` → `{ wasRunning }`. idempotent — 이미 settled해도
  `wasRunning: false`로 성공.
- `send_input(agentId, message)` → `{ delivered: true literal }`.
  conversational input (vs `write_stdin`의 PTY byte).

### Part 3 — cross-tool 불변식

- name uniqueness — `SUBAGENT_6_TOOL_NAMES` 길이와 `Set` 크기 동일 (테스트
  보장).
- 모든 output schema가 `kind` discriminator 보유 — generic `{ kind:
  "error", message, cause }` shape이 6 schema 모두에서 parse 성공해야 함
  (테스트 보장).
- closed set — 7번째 추가는 ADR 개정 필요.

## 근거

- Codex 사용 분포가 강력한 statistical signal: 두 tool로 99%가 통계 — 표준
  화하지 않으면 외부 trace import 시 손실. 표준 이름 + schema 고정이 cross-
  product trajectory tooling enabler.
- handler 분리: in-flight `agent-tool.ts` / `registry.ts`를 건드리지 않고도
  contract만 안정화 가능 — Cluster E의 minimum-touch + worktree fork
  policy 충족.
- discriminated union with `kind`: 1-필드 dispatch가 host loop의 per-tool
  special-case 폭주를 막음 (ADR-0019 four-surface 일관성).

## 대안

- **기존 `agent-tool.ts`에 6-tool surface 추가**: 기각 — in-flight 파일
  수정 금지 (Cluster E rule).
- **contract + handler를 같이 ship**: 기각 — handler는 registry 라이프
  사이클 (abort/settle/evict)에 깊이 결합되며 in-flight 안정화 필요.
- **timeoutMs를 optional default**: 기각 — silent default가 long-running
  hang의 historical bug class. 항상 명시.

## 결과·트레이드오프

- **얻은 것**: 6 tool contract가 안정화. 28 unit test (4+ schema round-trip
  × 6 + cross-tool 4 invariant) all green. 외부 Codex trace 형식과 1:1
  alignable.
- **비용**: 동일 의미를 가진 두 surface (기존 `task_output` 등 + 신규 6-
  tool)가 한동안 공존. follow-up에서 router 통합 필요.

## 한계 (LIMITATIONS)

- **(a) handler 구현은 follow-up**: 본 ADR은 schema + semantics + frozen
  dispatch table까지. 실제 `exec_command` PTY allocation, `spawn_agent`
  registry plumbing 등은 in-flight `registry.ts` / `agent-tool.ts` 안정화
  후 별도 ADR.
- **(b) Codex 표준과 우리 기존 tool naming 매핑 표 없음**: `task_output ↔
  wait_agent` 등 1:1 매핑 가이드는 router follow-up 시 같이.
- **(c) error.cause는 free-form string**: typed enum이 아닌 hint
  convention. 향후 ADR에서 enum 권고 가능 (현재는 throughput 우선).

## 불변식 영향

- **슬라이스 격리 유지**: `src/subagent/tools-6.ts` 신규 파일만 추가. zod
  외 import 0.
- **in-flight 파일 무수정**: `src/subagent/agent-tool.ts` /
  `registry.ts` / `task-tools.ts` / `types.ts` 모두 worktree에서 수정 0
  (main branch 안정성 보존).
- **RFC/ADR 동기**: ADR-0015 Codex foundation의 turnContext 흡수 노선과
  동일 절차 — contract first, wiring second.
- **신규 npm dep 0**.
