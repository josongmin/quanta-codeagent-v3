# Subagent Lifecycle And Runtime Interface

Overview router: [subagent-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-management-audit.md)

## 1. Visible interface

직접 보이는 subagent lifecycle surface:

| Tool | Direct meaning |
| --- | --- |
| `spawn_agent` | child 생성 |
| `send_input` | existing child에 추가 입력 |
| `resume_agent` | closed child를 다시 열기 |
| `wait_agent` | child final status 대기 |
| `close_agent` | child 종료 |
| `fork_context` | spawn 시 parent context 복제 옵션 |

이 표면만으로도 `one-shot helper call`보다 lifecycle-bearing child primitive 모델이 더 자연스럽다.

## 2. Best-fit request/response flow

```mermaid
sequenceDiagram
    participant P as Parent
    participant R as Runtime
    participant C as Child

    P->>R: spawn_agent(task, fork_context?)
    R-->>P: child_id
    R->>C: initialize child context
    P->>R: continue local work
    alt refinement needed
        P->>R: send_input(child_id, message)
        R->>C: append child input
    end
    alt child already closed but reusable
        P->>R: resume_agent(child_id)
        R->>C: reopen child
    end
    P->>R: wait_agent(child_id)
    R-->>P: child status or final result
    P->>R: close_agent(child_id)
```

## 2.1 Three common lifecycle shapes

### A. Read-only sidecar

```mermaid
sequenceDiagram
    participant P as Parent
    participant C as Child

    P->>C: spawn read-only question
    P->>P: continue local owner read
    P->>C: wait when merge point arrives
    C-->>P: answer packet
    P->>P: integrate into hypothesis
```

### B. Disjoint edit worker

```mermaid
sequenceDiagram
    participant P as Parent
    participant C as Child

    P->>C: spawn bounded edit with ownership boundary
    P->>P: keep critical path local
    C-->>P: changed files + result
    P->>P: reread live source
    P->>P: final closeout authority stays local
```

### C. Refinement / redirect

```mermaid
sequenceDiagram
    participant P as Parent
    participant C as Child

    P->>C: spawn initial task
    P->>P: gather new evidence
    P->>C: send_input(interrupt? new constraint)
    C-->>P: updated result
```

## 3. Payloads the parent actually cares about

| Call | Fields that matter most | Parent usually extracts |
| --- | --- | --- |
| `spawn_agent` | `agent_type`, `fork_context`, `message/items`, `reasoning_effort` | child role, context scope, initial objective |
| `send_input` | `target`, `message/items`, `interrupt` | whether to refine or redirect child work |
| `resume_agent` | `id` | whether old child can be reused instead of respawn |
| `wait_agent` | `targets`, `timeout_ms` | child completion, final packet, whether parent is blocked |
| `close_agent` | `target` | shutdown and lifecycle cleanup |

## 3.1 Payload-to-action mapping

| Observation from child lifecycle | Parent-side interpretation | Immediate next move |
| --- | --- | --- |
| child id returned | child branch admitted | continue local critical path |
| child final packet arrived | merge point reached | integrate or reread live source |
| wait timeout | child is not ready yet | keep local work going or defer join |
| resumed child accepted | old child context still useful | prefer reuse over redundant respawn |
| interrupting send_input used | parent wants immediate redirect | child objective changes now |

## 4. Best-fit child task packet

hidden exact packet shape는 비가시다. 다만 observable behavior를 설명하는 scaffold는 이 정도다.

```text
ChildTaskPacket {
  objective,
  task_kind,
  ownership_boundary,
  touched_files_or_surfaces,
  avoid_files_or_surfaces,
  expected_output_shape,
  keep_constraints_from_parent,
  reminder_not_to_revert_others
}
```

best-fit practical fields:

| Field | Why parent needs it |
| --- | --- |
| `objective` | child가 정확히 무엇을 닫아야 하는지 |
| `task_kind` | read-only analysis인지 edit worker인지 구분 |
| `ownership_boundary` | merge conflict와 duplicate work 방지 |
| `touched_files_or_surfaces` | write scope 고정 |
| `avoid_files_or_surfaces` | no-go zone 고정 |
| `expected_output_shape` | parent integration 비용 축소 |
| `keep_constraints_from_parent` | repo-local / reporting / honesty rule 계승 |

## 5. Why `fork_context` matters

`fork_context`는 단순 boolean 이상으로 해석된다. `[STRONG-INFERENCE]`

- child가 parent history/context를 그대로 시작할 수 있음을 시사
- 따라서 child는 fresh blank worker보다 `forked conversational worker`에 가깝다
- 반대로 exact copy depth, hidden memory transfer, artifact handle semantics는 `NON-CLAIM`이다

## 6. Parent-side pseudocode

```python
def use_subagent(sidecar_task, local_step):
    child = spawn_agent(sidecar_task)
    local_result = do_local_critical_path(local_step)

    if child_result_needed_now(local_result):
        child_result = wait_agent(child)
        local_result = integrate(local_result, child_result)

    close_agent(child)
    return local_result
```

핵심:
- child는 parent loop를 대체하지 않는다
- parent가 merge authority를 유지한다

## 6.1 Retry, resume, respawn

best-fit decision rule은 이렇다.

```python
def next_child_action(child_state, parent_state):
    if child_state.is_useful_and_inflight:
        return "wait_or_continue_local"
    if child_state.exists_and_new_constraints_arrived:
        return "send_input"
    if child_state.closed_but_context_still_valuable:
        return "resume_agent"
    return "spawn_new_child"
```

의미:
- 같은 bounded thread를 이어갈 가치가 있으면 `resume/send_input`
- 아니면 새 child를 만든다

## 6.2 Error and limit path

| Symptom | Parent reaction |
| --- | --- |
| spawn rejected or unavailable | reroute to local work or no-spawn path |
| wait timed out | avoid blocking; continue local path if possible |
| child output conflicts with fresh source | trust fresh source, not child packet alone |
| child ownership drifts | stop integration and tighten boundary |
| child no longer relevant | close child and drop branch |

## 7. Interface boundary

안전하게 말할 수 있는 것:
- explicit child lifecycle exists
- child can receive more input
- child can be waited on
- child can be resumed

안전하게 말하면 안 되는 것:
- exact internal thread/process topology
- exact child memory graph cloning
- scheduler policy
- exact timeout/retry scheduler semantics

---

## Round 2 update (2026-05-21 deep dive)

이 섹션은 §1 visible interface table에 round-2에서 확인된 추가 lifecycle event family를 추가한다.

### R2.1 External-agent migration lifecycle (NEW family)

round-1의 visible interface 6개 (`spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`, `fork_context`)는 **in-process child** lifecycle이다. round-2에서는 **별도의 external-agent migration** lifecycle이 확인됐다. `[FACT]`

Events (이름 순서 = 진행 순서):

| Event | Most plausible meaning |
| --- | --- |
| `external_agent_import_detect_finished` | scan target directories complete |
| `external_agent_import_provider_stage_finished` | per-provider data extraction complete |
| `external_agent_import_session_completion_finished` | session-level import normalization complete |
| `external_agent_import_finished` | full migration complete |

Persistent state file: `external_agent_session_imports.json` `[FACT]`

Runtime bridge channels:
- `external_agent_tool_call`
- `external_agent_tool_result`

Import targets:
- `~/.claude/`
- `.claude-plugin/`
- `.claudeCode/`
- `.claudeCowork/`
- `AGENTS.md` / `agents.md` (when present in target dirs)

해석: `[STRONG-INFERENCE]`
- 이 lifecycle은 `spawn_agent` child를 만드는 것이 아니라 다른 agent 도구의 자료를 detect → per-provider extract → session normalize → finish 순으로 import하는 4-stage state machine이다
- 즉 “external-agent를 import 한 뒤 codex thread/conversation 시스템 안으로 가져온다”는 separate lifecycle
- 그 결과로 만들어진 thread/conversation이 codex 내부에서 어떤 owner를 가지는지는 NON-CLAIM

### R2.2 Background subagent lifecycle (NEW mode)

round-2에서 확인된 추가 surface: `[FACT]`

- `is-subagent-conversation-*.js` renderer hook
- `/tasks` page UI
- `use-is-background-subagents-enabled` feature gate
- IPC channels: `list-pending-automation-run-threads`, `recommended-skills`, `install-recommended-skill`, `remove-skill`, `automation-update`

해석:
- `/tasks` page는 background subagent queue를 보여주는 surface다 `[STRONG-INFERENCE]`
- 즉 subagent는 foreground (parent loop가 `wait_agent`로 합류) + background (queue) 두 mode를 가진다 `[STRONG-INFERENCE]`
- background mode의 lifecycle은 round-1 §2 request/response flow와 다를 수 있다 — parent loop가 즉시 합류하지 않고 UI surface (`/tasks`)가 progress를 노출하는 형태가 가장 자연스럽다 `[SOTA-INFERENCE]`

### R2.3 Updated visible interface table

§1의 6개 tool에 round-2에서 확인된 두 lifecycle family를 추가:

| Surface | Family | Direct meaning |
| --- | --- | --- |
| `spawn_agent` | foreground subagent | child 생성 (round-1) |
| `send_input` | foreground subagent | existing child input (round-1) |
| `resume_agent` | foreground subagent | closed child 재오픈 (round-1) |
| `wait_agent` | foreground subagent | child final status 대기 (round-1) |
| `close_agent` | foreground subagent | child 종료 (round-1) |
| `fork_context` | foreground subagent | spawn 시 parent context 복제 (round-1) |
| `/tasks` page + `list-pending-automation-run-threads` IPC | background subagent queue | UI-visible queued subagent surface (round-2) |
| `external_agent_import_*` 4 events | external-agent migration | 4-stage import lifecycle (round-2) |
| `external_agent_tool_call`, `external_agent_tool_result` | external-agent migration | bridge channels at runtime (round-2) |

### R2.4 Interface boundary update

§7 “안전하게 말하면 안 되는 것”에 추가:

- exact relation between foreground subagent (`spawn_agent` family) and background subagent (`/tasks` family) — share scheduler? share table? `[NON-CLAIM]`
- exact trigger for external-agent migration (manual vs auto-detect on startup) `[NON-CLAIM]`
- whether `external_agent_tool_call` is bidirectional bridge or one-way `[NON-CLAIM]`
- whether imported external agent sessions become subagent children or top-level threads `[NON-CLAIM]`
