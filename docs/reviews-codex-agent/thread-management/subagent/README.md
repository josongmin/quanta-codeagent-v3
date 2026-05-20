# Codex Subagent Analysis Pack

`subagent` 축만 따로 모은 owner pack이다.

Overview router: [subagent-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-management-audit.md)

상위 router:
- [thread-management/README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/README.md)
- [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

이 폴더의 목적:
- broad 문서들에 흩어진 `subagent` 내용을 한쪽으로 모은다
- `FACT`, `STRONG-INFERENCE`, `NON-CLAIM` 경계를 유지한다
- lifecycle, delegation, continuity를 분리해 owner를 명확히 둔다

이 폴더가 직접 소유하는 질문:
- `spawn_agent` 계열을 어떤 contract로 해석해야 하나
- 왜 `stateless RPC`보다 `child session primitive` 모델이 더 설명력이 높은가
- 언제 main thread가 유지되고, 언제 sidecar delegation이 허용되나
- `fork_context`, `wait_agent`, `send_input`, `resume_agent`를 어떤 continuity surface로 봐야 하나

권장 읽기 순서:
1. [subagent-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-management-audit.md)
2. [subagent-lifecycle-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-lifecycle-and-runtime-interface.md)
3. [subagent-task-delegation-and-ownership.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-task-delegation-and-ownership.md)
4. [subagent-memory-and-continuity.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-memory-and-continuity.md)

업스트림 evidence owner:
- [direct-observable-facts.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/direct-observable-facts.md)
- [session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)
- [logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)
- [task-management-and-todo-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/task-management-and-todo-audit.md)
- [memory-model-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/memory-model-audit.md)
- [prohibitions-and-constraint-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/prohibitions-and-constraint-management-audit.md)
- [judgment-and-tool-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/judgment-and-tool-usage-audit.md)

주의:
- 이 폴더는 hidden backend implementation dump가 아니다.
- tool surface와 현재 세션 지침에서 직접 보이는 것만 `FACT`로 둔다.
- `child session`, `sidecar queue`, `continuity strength` 같은 문장은 reverse-engineered model이다.
- `spawn_agent` 계열은 in-flight child continuity를 설명하지만, 앱 재시작이나 thread 재진입의 durable recovery rail은 `session-management-audit.md`와 `logging-and-recovery-audit.md`가 더 직접적인 owner다.
