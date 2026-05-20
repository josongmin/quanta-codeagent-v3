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

---

## Round 2 update (2026-05-21 deep dive)

round-2에서는 subagent invocation rail과 별개의 “external-agent migration” lifecycle이 codex 안에 별도로 존재함이 확인됐다. 또한 background subagent용 UI/IPC surface와 renderer hook도 확인됐다. 자세한 lifecycle/IPC 차이는 [subagent-management-audit.md](./subagent-management-audit.md#round-2-update-2026-05-21-deep-dive)와 [subagent-lifecycle-and-runtime-interface.md](./subagent-lifecycle-and-runtime-interface.md#round-2-update-2026-05-21-deep-dive)가 owner다.

### R2.1 External-agent migration lifecycle (NEW)

`spawn_agent`/`send_input` 같은 in-process subagent invocation과는 **별도로**, codex에는 다른 agent 도구들의 자료를 import하는 migration lifecycle이 존재한다. `[FACT]`

Events (이름 그대로):
- `external_agent_import_detect_finished`
- `external_agent_import_provider_stage_finished`
- `external_agent_import_session_completion_finished`
- `external_agent_import_finished`

Persistent state file: `external_agent_session_imports.json` `[FACT]`

Runtime bridge channels:
- `external_agent_tool_call`
- `external_agent_tool_result`

Import targets:
- `~/.claude/`
- `.claude-plugin/`
- `.claudeCode/`
- `.claudeCowork/`
- 또한 위 dir에 있는 `AGENTS.md` / `agents.md` 파일

해석:
- 이 rail은 **subagent invocation이 아니라 external-agent migration**이다 `[FACT]`
- 즉 codex는 다른 agent ecosystem (Claude Code, Cowork 등)의 session/skill/agents.md를 import하는 lifecycle을 가진 “타 agent 자료 통합기” 역할을 한다 `[STRONG-INFERENCE]`
- 이건 round-1에서 다룬 `spawn_agent` subagent와 다른 차원의 lifecycle이며, 둘을 같은 owner로 묶으면 안 된다 `[STRONG-INFERENCE]`

### R2.2 Background subagent UI/IPC surface

round-2에서 추가 확인된 renderer/IPC surface: `[FACT]`

- `is-subagent-conversation-*.js` renderer hook (asset 이름 그대로 minified bundle에서 확인)
- `/tasks` 페이지가 background subagent queue UI를 가진다는 single-page evidence
- `use-is-background-subagents-enabled` feature gate hook 존재
- IPC channels: `list-pending-automation-run-threads`, `recommended-skills`, `install-recommended-skill`, `remove-skill`, `automation-update`

해석:
- background subagent는 feature-gated UI surface (`/tasks` page)를 가진다 `[FACT]`
- renderer-level에서 “is this a subagent conversation?” 분기가 명시적이다 `[FACT]`
- 따라서 round-1의 `spawn_agent` tool surface는 **synchronous in-process** subagent 모델이고, `/tasks` rail은 **background queued** subagent 모델일 가능성이 높다 `[STRONG-INFERENCE]`
- 즉 subagent 자체에 최소 두 가지 mode가 있다: foreground (parent loop 안), background (queued, UI-visible) `[STRONG-INFERENCE]`

### R2.3 Updated subagent rail map

| Rail | Round-2 status |
| --- | --- |
| `spawn_agent`/`send_input`/`resume_agent`/`wait_agent`/`close_agent`/`fork_context` | round-1 그대로 — synchronous in-process child lifecycle |
| Background subagent queue | `/tasks` page + `use-is-background-subagents-enabled` feature gate + `list-pending-automation-run-threads` IPC `[FACT]` |
| External-agent migration | `external_agent_import_*` events + `external_agent_session_imports.json` + bridge tool calls — 별도 lifecycle `[FACT]` |
| Renderer-side subagent hook | `is-subagent-conversation-*.js` `[FACT]` |

### R2.4 Owner reorg note

이 pack의 owner 분배는 round-2에서 다음과 같이 명확해진다:

- subagent invocation (`spawn_agent` family) → 이 pack 그대로
- background queued subagent → 이 pack에 추가됐지만, UI 쪽 surface는 `thread-ui-and-fork-surface-audit.md`도 일부 owner
- external-agent migration → 이 pack 내부에서 별도 sub-section으로 다룸 (round-2 추가 owner)
- automation IPC `list-pending-automation-run-threads` → automation-audit.md가 owner
