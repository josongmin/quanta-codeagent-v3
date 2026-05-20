# Codex Agent Analysis

이 디렉터리는 Codex 계열 에이전트의 실행 구조를 분석 문서로 정리한다.

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

목표:
- Codex를 `단순 채팅 모델`이 아니라 `정책 제약형 도구-사용 에이전트`로 설명한다.
- 직접 관측 가능한 사실과, 그 사실들로부터의 강한 추론을 분리한다.
- 실전에서 중요한 축만 남긴다: control plane, 정책 계층, 도구 라우팅, 실행 루프, 런타임 경계.

문서 ownership 규칙:
- `cross-doc invariant`와 owner map은 [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)가 맡는다.
- 각 depth 문서는 자기 surface의 deepest detail만 소유하고, router 내용을 다시 owner 행세로 복제하지 않는다.
- loop-wide invariant가 바뀌면 router와 관련 depth 문서를 같이 갱신해야 한다.

권장 진입 순서:
- [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)
  - control-plane summary
  - runtime/LLM boundary, top-level loop, evidence discipline, 문서 소유권 맵
- [execution-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/execution-loop.md)
  - 최상위 agent loop, code-repair loop, review loop, audit loop의 짧은 시각 요약
- [agent-loop-deep-dive.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/agent-loop-deep-dive.md)
  - typed task model, fact vs inference, stop/uncertainty discipline
- [thread-management/README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/README.md)
  - thread, session, fork, recovery, storage, automation 전용 pack

세부 문서:
- [turn-context-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/turn-context-and-runtime-interface.md)
  - turn context 조립, runtime-LLM handshake, tool-call lifecycle, observation normalization
- [response-assembly-and-closeout.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/response-assembly-and-closeout.md)
  - final answer assembly, defended-claim filtering, verification disclosure, partial vs complete closeout
- [judgment-and-tool-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/judgment-and-tool-usage-audit.md)
  - how judgment is formed, how tools are selected, what is directly observable vs inferred
- [prohibitions-and-constraint-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/prohibitions-and-constraint-management-audit.md)
  - how prohibitions are layered, enforced, routed, and reported
- [tool-inventory-and-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/tool-inventory-and-usage-audit.md)
  - exhaustive inventory of visible tools, trigger conditions, constraints, and practical usage patterns
- [budget-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/budget-management-audit.md)
  - how the agent appears to budget tool calls, reads, edits, validation, and parallelism under visible constraints
- [sandbox-and-approval-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/sandbox-and-approval-audit.md)
  - whether sandboxing exists, what is directly visible in this session, and how sandbox/approval constraints shape execution
- [external-call-record-replay-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/external-call-record-replay-audit.md)
  - cassette/record-replay layer for external calls: current evidence, format, process, and gaps
- [hitl-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/hitl-audit.md)
  - human-in-the-loop boundaries: confirmations, handoff points, approval policy, and human-required decision rails
- [memory-model-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/memory-model-audit.md)
  - how memory appears to be structured across thread history, instruction stack, working state, artifacts, and subagents
- [plugin-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/plugin-audit.md)
  - plugin model, plugin-contributed skills, trigger rules, and plugin/runtime boundaries
- [mode-and-plan-process-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/mode-and-plan-process-audit.md)
  - differences between Default and Plan mode, and the inferred internal process of Plan mode
- [permission-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/permission-management-audit.md)
  - permission model across sandbox, approval, HITL consent, tool admissibility, and repo-local execution boundaries
- [direct-observable-facts.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/direct-observable-facts.md)
  - consolidated inventory of facts directly observable from this session, its tools, and visible repo/runtime context
- [unknowns-and-non-claims.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/unknowns-and-non-claims.md)
  - explicit boundary of what this analysis does not and cannot safely claim
- [cross-cutting-risk-register.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/cross-cutting-risk-register.md)
  - cross-document risk register for mis-modeling Codex agent behavior, permissions, loops, and evidence
- [comparative-differentiators-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/comparative-differentiators-audit.md)
  - what appears meaningfully different about this Codex agent relative to generic chat agents or simpler coding agents
- [session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)
  - how session state appears to be created, maintained, resumed, forked, and externalized across tools, modes, summaries, and subagents
- [thread-management/README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/README.md)
  - thread/session/fork/storage 전체 router
- [thread-management/storage-and-db-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/storage-and-db-audit.md)
  - visible JSONL/SQLite persistence rail, local DB/table inventory, safe DB claims
- [thread-management/inferred-internal-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/inferred-internal-architecture.md)
  - best-fit hidden architecture from local snapshot, logs, migration evidence, and SOTA patterns
- [thread-management/thread-ui-and-fork-surface-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/thread-ui-and-fork-surface-audit.md)
  - session ID, deeplink, cwd, local fork vs worktree fork UI surface
- [thread-management/ui-action-to-persistence-mapping.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/ui-action-to-persistence-mapping.md)
  - context-menu action별 likely local write/read surface mapping
- [subagent/README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/README.md)
  - subagent 전용 router
- [subagent/subagent-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-management-audit.md)
  - subagent final model, lifecycle summary, continuity boundary, non-claims
- [subagent/subagent-lifecycle-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-lifecycle-and-runtime-interface.md)
  - spawn/send/resume/wait/close interface와 parent-child tick-tock
- [subagent/subagent-task-delegation-and-ownership.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-task-delegation-and-ownership.md)
  - explicit permission, disjoint ownership, critical-path-local rule
- [subagent/subagent-memory-and-continuity.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-memory-and-continuity.md)
  - fork_context, child continuity strength, artifact/thread 대비 위치
- [mcp-usage-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/mcp-usage-audit.md)
  - MCP-related tools, resource access model, plugin interplay, routing preferences, and current-session limits
- [task-management-and-todo-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/task-management-and-todo-audit.md)
  - how internal task management appears to work, including todo-style decomposition, working queues, and plan/tool state
- [long-horizon-task-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/long-horizon-task-management-audit.md)
  - what is and is not visible about long-running / long-horizon task management, and how continuity is approximated when no explicit long-task facility is exposed
- [skills-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/skills-audit.md)
  - skill registration/exposure model, trigger rules, execution flow, plugin-coupling, and how skill selection has actually happened in this thread
- [repo-local-rule-ingestion-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/repo-local-rule-ingestion-audit.md)
  - how repo-local rule files such as AGENTS.md and `.codex/*` appear to be ingested, prioritized, and used during task execution
- [automation-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/automation-audit.md)
  - visible automation surface, heartbeat vs cron model, lifecycle operations, and current-session evidence
- [git-and-branch-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/git-and-branch-management-audit.md)
  - git capability, branch naming/defaults, directive-based app reporting, prohibitions, and controlled workflow model
- [logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)
  - what is visibly retained, what looks volatile, and how interruption recovery appears to work across thread, summary, artifact, automation, and shell rails
- [prompt-and-policy-stack.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/prompt-and-policy-stack.md)
  - 시스템/개발자/앱/모드/스킬/로컬 repo 규칙의 적층 구조
- [tool-routing-and-triggering.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/tool-routing-and-triggering.md)
  - 어떤 질문/상황에서 어떤 도구가 트리거되는지

핵심 결론:
- Codex는 순정 ReAct를 그대로 드러내는 형태라기보다, `정책 계층 + 도구 라우팅 + 상태 기반 반복 실행` 쪽에 가깝다.
- 도구 호출 여부는 질문 그 자체보다 `답변의 진실 조건`에 의해 결정된다.
- 코드 작업에서는 `owner -> type/wire/test -> 잔존 여부 확인` 순서의 repair loop가 핵심이다.
- 런타임은 도구/권한/세션 상태를 제공하고, LLM은 그 경계 안에서 실제 선택을 수행한다.

주의:
- 이 디렉터리 문서는 제품 내부 비공개 원문 프롬프트를 복제하지 않는다.
- 대신 외부에서 관측 가능한 사실과, 그 사실로부터 재구성 가능한 실행 모델을 정리한다.
