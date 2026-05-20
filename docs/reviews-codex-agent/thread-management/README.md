# Codex Thread Management Pack

이 폴더는 Codex의 `thread / session / fork / recovery / automation / storage` 축만 따로 모은 owner pack이다.

상위 router:
- [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)
- [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/README.md)

이 폴더의 목적:
- thread/session continuity 질문을 한곳에서 닫는다
- UI thread 관리 기능과 runtime/subagent fork를 분리해서 설명한다
- JSONL, SQLite, workspace artifact가 어떤 저장 rail로 보이는지 정리한다
- visible DB/schema와 hidden backend 추정을 분리한다
- 업계 SOTA 패턴과 visible evidence를 합성한 best-fit hidden architecture를 별도 owner로 정리한다
- UI action별 local write-path hypothesis를 fact와 분리해 관리한다

이 폴더가 직접 소유하는 질문:
- thread와 session은 어떤 handle로 식별되고 이어지는가
- session ID, deeplink, cwd, archived rollout은 어디에 남는가
- visible local storage는 JSONL인가 SQLite인가 둘 다인가
- 어떤 local DB/file rail이 어떤 역할을 맡는 것이 가장 타당한가
- UI의 `Fork into local` / `Fork into new worktree`는 어떤 의미로 읽는 것이 가장 타당한가
- sidebar/context-menu action은 어떤 metadata/state write를 유발하는 것이 가장 그럴듯한가
- subagent child continuity와 top-level thread continuity는 어떻게 다른가
- heartbeat/cron/summary/artifact는 continuity rail에서 어디에 놓이는가

권장 읽기 순서:
1. [session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)
2. [storage-and-db-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/storage-and-db-audit.md)
3. [inferred-internal-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/inferred-internal-architecture.md)
4. [thread-ui-and-fork-surface-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/thread-ui-and-fork-surface-audit.md)
5. [ui-action-to-persistence-mapping.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/ui-action-to-persistence-mapping.md)
6. [logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)
7. [automation-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/automation-audit.md)
8. [long-horizon-task-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/long-horizon-task-management-audit.md)
9. [subagent/README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/README.md)

문서 배치:
- [session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)
  - top-level session state model, mode/tool/subagent/session handle
- [storage-and-db-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/storage-and-db-audit.md)
  - visible local persistence artifacts, JSONL and SQLite layout, safe DB claims
- [inferred-internal-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/inferred-internal-architecture.md)
  - SOTA-pattern + visible evidence 기반 best-fit hidden architecture, runtime loop, persistence split
- [thread-ui-and-fork-surface-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/thread-ui-and-fork-surface-audit.md)
  - UI thread actions, session ID/deeplink/workdir handles, local vs worktree fork
- [ui-action-to-persistence-mapping.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/ui-action-to-persistence-mapping.md)
  - context-menu action별 likely write/read surface, field mapping, confidence split
- [logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)
  - volatile vs durable rails, interruption recovery
- [automation-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/automation-audit.md)
  - heartbeat/cron continuation surface
- [long-horizon-task-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/long-horizon-task-management-audit.md)
  - long-running continuity model and externalization rules
- [subagent/README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/README.md)
  - child-session lifecycle, delegation, child continuity

업스트림 evidence owner:
- [direct-observable-facts.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/direct-observable-facts.md)
- [turn-context-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/turn-context-and-runtime-interface.md)
- [memory-model-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/memory-model-audit.md)
- [mode-and-plan-process-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/mode-and-plan-process-audit.md)
- [permission-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/permission-management-audit.md)
- [git-and-branch-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/git-and-branch-management-audit.md)

주의:
- 이 폴더는 hidden backend implementation dump가 아니다.
- 여기서 `DB structure`라고 할 때는 현재 로컬에서 직접 보인 SQLite/JSONL surface를 우선 뜻한다.
- service-side hidden store, retention policy, sync semantics는 evidence 없으면 `NON-CLAIM`으로 남긴다.
- 추정 섹션은 `visible contract + local snapshot + 2026 desktop agent SOTA pattern` 조합으로만 올린다.

---

## Round 2 update (2026-05-21 deep dive)

2026-05-21 deep dive에서 minified bundle/Rust binary 추가 추출이 진행되어, 이 pack 전반에 다음 축이 확정되었다.

- **Thread-follower event taxonomy (13개 확정)**: thread state mutation은 JSON-RPC 2.0 channel envelope (`{event}-request`/`-response`/`-timeout`, timeout code `-32000`)로 흐른다. 13개 event 전체 enumerate는 [inferred-internal-architecture.md](./inferred-internal-architecture.md#round-2-update-2026-05-21-deep-dive)에 모은다.
- **Session/turn JSONL schema 확정**: `archived_sessions/rollout-*.jsonl`의 `type` family에 `turn_context`가 추가 확인됐고, **매 turn마다 full snapshot** (cwd/policy/model/personality/collaboration_mode 등)이 박힌다. Owner는 [storage-and-db-audit.md](./storage-and-db-audit.md#round-2-update-2026-05-21-deep-dive)다.
- **`logs_2.sqlite` 전모**: schema + 4개 index + sliding-window retention algorithm + WAL/PRAGMA + ~10일 cap이 모두 확인됐다. 14.8GB main + 14GB WAL가 normal이다. 전체 내용은 [storage-and-db-audit.md](./storage-and-db-audit.md#round-2-update-2026-05-21-deep-dive) 참조.
- **`~/.codex/` directory inventory**: `config.toml`, `auth.json`, `.codex-global-state.json`, `models_cache.json`, `memories/` (git-versioned), `rules/default.rules` 등 풀 layout이 확정됐다. Owner는 [storage-and-db-audit.md](./storage-and-db-audit.md#round-2-update-2026-05-21-deep-dive).
- **External-agent migration lifecycle**: subagent invocation과 별개로 codex가 `~/.claude/`, `.claude-plugin/`, `.claudeCode/`, `.claudeCowork/` 같은 타 agent 자료를 import하는 별도 lifecycle을 가진다. Owner는 [subagent/README.md](./subagent/README.md#round-2-update-2026-05-21-deep-dive).
- **`thread-follower-set-collaboration-mode` event 확정 + `agent-mode-by-host-id.local`**: per-host trust mode (`full-access`/`read-only`)가 explicit event + global state knob 결합으로 관리된다. Owner는 [session-management-audit.md](./session-management-audit.md#round-2-update-2026-05-21-deep-dive).

이 round-2 round는 round-1 facts를 부정하지 않고 확장한다. 다만 `logs_2.sqlite` retention/compaction을 `NON-CLAIM`으로 두었던 부분은 sliding-window algorithm 확정으로 일부 옮겨졌다.
